/* GcodeScope — G-code parser (runs in a Web Worker, fully offline).
 * Input:  { file: File|Blob, name: string }
 * Output: typed arrays for rendering + summary stats.
 *
 * Handles: G0/G1/G2/G3 (modal), G17/G18/G19 arc planes, I/J/K and R arcs,
 * G20/G21 units, G90/G91, M82/M83, G92, G28, canned cycles (G73/G74/G76/G81-G89),
 * frames (G52, G68/G69), Fanuc macro B (#vars, IF/GOTO/WHILE), subprograms (M98/M97/G65/M99),
 * slicer metadata comments (Prusa/Orca/Bambu/Cura/S3D). Controller languages that are not
 * ISO G-code (HEIDENHAIN Klartext, SINUMERIK) are translated by js/dialects.js through `api`.
 */
'use strict';
importScripts('controller.js', 'expr.js', 'dialects.js'); // self.GSController, GSExpr, GSDialects

class FloatBuf {
  constructor(cap) { this.a = new Float32Array(cap || 65536); this.n = 0; }
  push6(a, b, c, d, e, f) {
    if (this.n + 6 > this.a.length) this.grow();
    const x = this.a, n = this.n;
    x[n] = a; x[n + 1] = b; x[n + 2] = c; x[n + 3] = d; x[n + 4] = e; x[n + 5] = f;
    this.n = n + 6;
  }
  push3(a, b, c) {
    if (this.n + 3 > this.a.length) this.grow();
    const x = this.a, n = this.n;
    x[n] = a; x[n + 1] = b; x[n + 2] = c;
    this.n = n + 3;
  }
  push1(a) { if (this.n + 1 > this.a.length) this.grow(); this.a[this.n++] = a; }
  grow() { const b = new Float32Array(this.a.length * 2); b.set(this.a); this.a = b; }
  done() { return this.a.slice(0, this.n); }
}
class ByteBuf {
  constructor(cap) { this.a = new Uint8Array(cap || 65536); this.n = 0; }
  push(v) {
    if (this.n + 1 > this.a.length) { const b = new Uint8Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  done() { return this.a.slice(0, this.n); }
}
class UintBuf {
  constructor(cap) { this.a = new Uint32Array(cap || 16384); this.n = 0; }
  push(v) {
    if (this.n + 1 > this.a.length) { const b = new Uint32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  done() { return this.a.slice(0, this.n); }
}

// Kind of each cut (feed) segment — mirrored in viewer.js (KIND_COLORS) and app.js (legend).
const K_CUT = 0, K_PLUNGE = 1, K_RAMP = 2, K_RETRACT = 3, K_LEADIN = 4, K_LEADOUT = 5;
// hole making — feed moves inside drilling/tapping/boring cycles and helical bore/thread milling
const K_SPOT = 6, K_DRILL = 7, K_TAP = 8, K_BORE = 9, K_BOREMILL = 10, K_THREADMILL = 11, K_COUNT = 12;
// hole types → segment kind. 'peck' = G83 full retract, 'chipbreak' = G73 short retract.
const HOLE_KIND = { spot: K_SPOT, drill: K_DRILL, peck: K_DRILL, chipbreak: K_DRILL, tap: K_TAP, bore: K_BORE, boremill: K_BOREMILL, threadmill: K_THREADMILL };
const PECK_CLEAR = 0.5; // mm, G83 re-approach / G73 retract distance (Fanuc parameter 5114/5115 default range)
// ISO metric coarse pitches, for "M10" style tap names without an explicit pitch
const METRIC_PITCH = { 1: 0.25, 1.2: 0.25, 1.6: 0.35, 2: 0.4, 2.5: 0.45, 3: 0.5, 4: 0.7, 5: 0.8, 6: 1, 8: 1.25, 10: 1.5, 12: 1.75,
  14: 2, 16: 2, 18: 2.5, 20: 2.5, 22: 2.5, 24: 3, 27: 3, 30: 3.5, 33: 3.5, 36: 4, 42: 4.5, 48: 5 };
const SPOT_RE = /SPOT|CENTER|CENTRE|PUNTA|ZENTRIER|ANBOHR|NC-?DRILL|CHAMFER|PAH/;
const THREAD_RE = /THREAD|THD|GEWINDE|D[İI]Ş|DIS\b|FILET/;

// Tool info from a comment: tool diameter d, thread size threadD / pitch (taps, thread mills), name
function toolFromComment(c) {
  const u = c.toUpperCase();
  const info = { name: u.trim().slice(0, 60) };
  let m;
  if ((m = /(?<![A-Z0-9])M(\d+(?:\.\d+)?)\s*[X×]\s*(\d+(?:\.\d+)?)/.exec(u))) { info.threadD = +m[1]; info.pitch = +m[2]; }
  else if ((m = /(?<![A-Z0-9])M(\d+(?:\.\d+)?)(?![\d.])/.exec(u)) && METRIC_PITCH[+m[1]] && /TAP|KILAVUZ|KLAVUZ|GEWINDE|THREAD|D[İI]Ş/.test(u)) {
    info.threadD = +m[1]; info.pitch = METRIC_PITCH[+m[1]];
  }
  if ((m = /\bD\s*=\s*(\d+(?:\.\d+)?)/.exec(u)) || (m = /(?:Ø|DIA(?:METER|M)?\.?\s*[-:=]?\s*|(?<![A-Z0-9])D)(\d+(?:\.\d+)?)/.exec(u))
    || (m = /(\d+(?:\.\d+)?)\s*MM\b/.exec(u))) info.d = +m[1];
  return info;
}
const LEAD_MAX_SWEEP = 100 * Math.PI / 180, LEAD_MAX_R = 25; // heuristic lead arc limits (mm)
const TWO_PI = 2 * Math.PI, D2R = Math.PI / 180;
const MAX_EXEC = 3e6, MAX_DEPTH = 32; // program-flow guards (loops, recursion)

const WORD_RE = /([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;
// A G1 move carrying an E word => 3D printer file.
const PRINT_RE = /^[ \t]*(?:N\d+[ \t]*)?G0?1[^;\n(]*E[-+]?[.\d]/im;

function parseDuration(s) {
  // "1d 2h 3m 4s", "1h 02m", "3600" (seconds), "1 hours 2 minutes"
  s = s.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  let t = 0, hit = false;
  const re = /(\d+(?:\.\d+)?)\s*(d|h|m|s|day|days|hour|hours|min|mins|minute|minutes|sec|secs|second|seconds)\b/gi;
  let m;
  while ((m = re.exec(s))) {
    hit = true;
    const v = parseFloat(m[1]), u = m[2].toLowerCase()[0];
    t += u === 'd' ? v * 86400 : u === 'h' ? v * 3600 : u === 'm' ? v * 60 : v;
  }
  return hit ? t : null;
}

function readMeta(c, meta) {
  // c: comment text without leading ';'
  let m;
  if (!meta.slicer) {
    if ((m = /generated (?:by|with) ([A-Za-z][\w .\-+]*?)(?:\s+on\b|\s+at\b|$)/i.exec(c))) meta.slicer = m[1].trim();
    else if ((m = /^\s*(BambuStudio|OrcaSlicer|PrusaSlicer|SuperSlicer|Simplify3D|ideaMaker|Cura_SteamEngine)[\s\d.]*/i.exec(c))) meta.slicer = m[0].trim();
    else if ((m = /^FLAVOR:(\w+)/.exec(c))) meta.flavor = m[1];
  }
  if ((m = /^TIME:(\d+(?:\.\d+)?)/.exec(c))) meta.time = parseFloat(m[1]);
  else if ((m = /estimated printing time(?: \(normal mode\))?\s*=\s*(.+)$/i.exec(c))) meta.time = parseDuration(m[1]);
  else if ((m = /total estimated time:\s*([^;]+)/i.exec(c))) meta.time = parseDuration(m[1]);
  else if ((m = /model printing time:\s*([^;]+)/i.exec(c)) && meta.time == null) meta.time = parseDuration(m[1]);
  else if ((m = /Build time:\s*(.+)$/i.exec(c))) meta.time = parseDuration(m[1]);
  if ((m = /^Filament used:\s*([\d.]+)\s*m\b/i.exec(c))) meta.filamentMm = parseFloat(m[1]) * 1000;
  else if ((m = /filament used \[mm\]\s*=\s*([\d.]+)/i.exec(c))) meta.filamentMm = parseFloat(m[1]);
  else if ((m = /total filament length \[mm\]\s*[:=]\s*([\d.]+)/i.exec(c))) meta.filamentMm = parseFloat(m[1]);
  if ((m = /(?:total )?filament used \[g\]\s*=\s*([\d.]+)/i.exec(c))) meta.filamentG = parseFloat(m[1]);
  else if ((m = /total filament weight \[g\]\s*[:=]\s*([\d.]+)/i.exec(c))) meta.filamentG = parseFloat(m[1]);
  if ((m = /^\s*filament_type\s*=\s*(.+)$/i.exec(c))) meta.material = m[1].split(';')[0].trim();
}

self.onmessage = async (ev) => {
  const { file, name } = ev.data;
  try {
    const text = await file.text();
    const result = parse(text, name);
    const tr = [result.cutPos.buffer, result.rapidPos.buffer, result.stepCut.buffer,
      result.stepRapid.buffer, result.stepLine.buffer, result.stepPos.buffer, result.cutZ.buffer, result.cutKind.buffer];
    self.postMessage({ type: 'done', result }, tr);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};

function parse(text, name) {
  const isPrint = PRINT_RE.test(text.length > 4e6 ? text.slice(0, 4e6) : text) || PRINT_RE.test(text);
  const len = text.length;

  const cut = new FloatBuf(1 << 18), rapid = new FloatBuf(1 << 16);
  const cutZ = new FloatBuf(1 << 16); // z of each cut segment (for layer coloring)
  const cutKind = new ByteBuf(1 << 16); // K_* of each cut segment (CNC coloring)
  let curKind = K_CUT;
  const stepCut = new UintBuf(), stepRapid = new UintBuf(), stepLine = new UintBuf();
  const stepPos = new FloatBuf(1 << 14);

  // Machine state (always stored in mm)
  let x = 0, y = 0, z = 0, e = 0;
  let absolute = true, absE = true, scale = 1, inch = false;
  let motion = 0; // 0..3, or 81.. for canned cycle
  let plane = 17, feed = 0;
  let retractMode = 98, cycleR = 0, cycleZ = 0, cycleCode = 81, cycleInitZ = 0, cycleQ = 0, cycleP = 0;
  let spindle = 0, feedPerRev = false;
  let tool = null; const toolInfo = {};
  const holes = [];     // { type, x, y, top, bottom, d, dKnown, pitch, lh, pecks, step, line, tool }
  const meta = {};
  let lineNo = 0;

  // stats
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let cutLen = 0, rapidLen = 0, timeCut = 0, timeRapid = 0, filament = 0;
  let minF = Infinity, maxF = 0, motionCount = 0, toolChanges = 0;
  const tools = new Set();
  let layerZ = -Infinity, layers = 0;
  const RAPID_FEED = 5000; // mm/min assumption for G0 in CNC mode

  const bound = (px, py, pz) => {
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
    if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
  };

  // Model XY bounds for prints skip layer 1 (purge lines / skirt live there)
  let mMinX = Infinity, mMinY = Infinity, mMaxX = -Infinity, mMaxY = -Infinity;
  const addCut = (x0, y0, z0, x1, y1, z1) => {
    cut.push6(x0, y0, z0, x1, y1, z1);
    cutZ.push1(z1);
    cutKind.push(curKind);
    bound(x0, y0, z0); bound(x1, y1, z1);
    if (layers >= 2) {
      if (x0 < mMinX) mMinX = x0; if (x0 > mMaxX) mMaxX = x0; if (x1 < mMinX) mMinX = x1; if (x1 > mMaxX) mMaxX = x1;
      if (y0 < mMinY) mMinY = y0; if (y0 > mMaxY) mMaxY = y0; if (y1 < mMinY) mMinY = y1; if (y1 > mMaxY) mMaxY = y1;
    }
  };
  const addRapid = (x0, y0, z0, x1, y1, z1) => rapid.push6(x0, y0, z0, x1, y1, z1);

  const pushStep = () => {
    stepCut.push(cut.n / 6);
    stepRapid.push(rapid.n / 6);
    stepLine.push(lineNo);
    stepPos.push3(x, y, z);
  };

  const segLen = (x0, y0, z0, x1, y1, z1) => Math.hypot(x1 - x0, y1 - y0, z1 - z0);

  // linear move; kind: 'cut' | 'rapid'
  const linear = (nx, ny, nz, isCut, f) => {
    const d = segLen(x, y, z, nx, ny, nz);
    const dxy = Math.hypot(nx - x, ny - y);
    if (dxy > 1e-9) { ldx = (nx - x) / dxy; ldy = (ny - y) / dxy; }
    if (d > 0) {
      if (isCut) {
        addCut(x, y, z, nx, ny, nz); cutLen += d;
        if (f > 0) timeCut += d / f;
      } else {
        addRapid(x, y, z, nx, ny, nz); rapidLen += d;
        timeRapid += d / (isPrint ? (f > 0 ? f : 6000) : RAPID_FEED);
      }
    }
    x = nx; y = ny; z = nz;
  };

  // of the last arc() call, for lead-in/out and helix detection
  let arcSweep = 0, arcR = 0, arcCx = 0, arcCy = 0;
  let ldx = 1, ldy = 0; // direction of the last XY segment (for tangential arcs)
  const arc = (cw, tx, ty, tz, w, isCut, extraTurns = 0) => {
    arcSweep = 0; arcR = 0;
    const sc = w.mm ? 1 : scale;
    // Map to plane axes: a,b in plane, c = helical axis
    let a0, b0, c0, a1, b1, c1, ia, ib;
    if (plane === 18) { a0 = z; b0 = x; c0 = y; a1 = tz; b1 = tx; c1 = ty; ia = w.K; ib = w.I; }
    else if (plane === 19) { a0 = y; b0 = z; c0 = x; a1 = ty; b1 = tz; c1 = tx; ia = w.J; ib = w.K; }
    else { a0 = x; b0 = y; c0 = z; a1 = tx; b1 = ty; c1 = tz; ia = w.I; ib = w.J; }
    let ca, cb;
    if (w.R !== undefined && ia === undefined && ib === undefined) {
      const r = w.R * sc;
      const dx = a1 - a0, dy = b1 - b0, d = Math.hypot(dx, dy);
      if (d === 0 || Math.abs(r) < d / 2 - 1e-6) { linear(tx, ty, tz, isCut, feed); return; }
      const h = Math.sqrt(Math.max(0, r * r - d * d / 4));
      // choose center side: for CW with positive R, center is to the right of chord
      let sgn = (cw ? 1 : -1) * (r > 0 ? 1 : -1);
      const mx = (a0 + a1) / 2, my = (b0 + b1) / 2;
      ca = mx + sgn * h * dy / d; cb = my - sgn * h * dx / d;
    } else {
      ca = a0 + (ia || 0) * sc; cb = b0 + (ib || 0) * sc;
    }
    const r = Math.hypot(a0 - ca, b0 - cb);
    if (!(r > 1e-9)) { linear(tx, ty, tz, isCut, feed); return; }
    let s = Math.atan2(b0 - cb, a0 - ca), t = Math.atan2(b1 - cb, a1 - ca);
    let sweep = t - s;
    if (cw) { if (sweep >= -1e-9) sweep -= 2 * Math.PI; }
    else { if (sweep <= 1e-9) sweep += 2 * Math.PI; }
    if (extraTurns > 0) sweep += (cw ? -1 : 1) * TWO_PI * extraTurns;
    arcSweep = Math.abs(sweep); arcR = r; arcCx = ca; arcCy = cb;
    const tol = Math.min(0.02, r * 0.1);
    const step = Math.max(2 * Math.acos(Math.max(-1, 1 - tol / r)), Math.PI / 90);
    const n = Math.min(720 * (1 + extraTurns), Math.max(4, Math.ceil(Math.abs(sweep) / step)));
    const endR = Math.hypot(a1 - ca, b1 - cb);
    for (let i = 1; i <= n; i++) {
      const k = i / n, ang = s + sweep * k, rr = r + (endR - r) * k;
      let pa = ca + rr * Math.cos(ang), pb = cb + rr * Math.sin(ang), pc = c0 + (c1 - c0) * k;
      if (i === n) { pa = a1; pb = b1; pc = c1; }
      let nx, ny, nz;
      if (plane === 18) { nz = pa; nx = pb; ny = pc; }
      else if (plane === 19) { ny = pa; nz = pb; nx = pc; }
      else { nx = pa; ny = pb; nz = pc; }
      linear(nx, ny, nz, isCut, feed);
    }
  };

  // --- Move classification (CNC). Plunge / ramp / retract come from geometry. Lead-in/out come from
  // cutter compensation (G41/G42 switched on → lead-in move, G40 → lead-out move) or, for CAM output
  // without compensation, from the short tangent arc (+ line) placed right after entering and right
  // before leaving the material. The heuristic is only accepted when the contour closes on the lead's
  // end point, so corner radii of open or closed contours are not mistaken for leads.
  let comp = 40, compPending = 0, leadArcNext = false;
  let entering = true, explicitLeads = false;
  let hist = [];        // flat feed blocks since the last entry: { s, e, arc, sweep, r, len, sx, sy, ex, ey }
  let p0 = null;        // contour start: end of the (candidate) lead-in or of the first block after entry
  let closed = false;   // a later block ended on p0
  let leadIn = null;    // provisional heuristic lead-in { s, e }
  const kindCounts = new Array(K_COUNT).fill(0);
  const setKind = (s, e, k) => { for (let i = s; i < e; i++) cutKind.a[i] = k; };
  const near = (ax, ay, bx, by) => Math.abs(ax - bx) < 1e-3 && Math.abs(ay - by) < 1e-3;
  const leadArc = (h) => h && h.arc && h.sweep <= LEAD_MAX_SWEEP && h.r <= LEAD_MAX_R;
  const leadLine = (h, a) => h && !h.arc && h.len <= 3 * a.r + 1e-6;
  const heuristic = () => !explicitLeads && comp === 40;
  const leaveMaterial = () => {
    if (leadIn && !closed) setKind(leadIn.s, leadIn.e, K_CUT); // contour never came back: not a lead
    if (heuristic() && closed && hist.length >= 2) {
      // lead-out: [arc] or [arc, line] that starts where the contour closed
      const n = hist.length, last = hist[n - 1], prev = hist[n - 2];
      if (leadArc(last) && near(last.sx, last.sy, p0[0], p0[1])) setKind(last.s, last.e, K_LEADOUT);
      else if (n >= 3 && leadArc(prev) && leadLine(last, prev) && near(prev.sx, prev.sy, p0[0], p0[1])) setKind(prev.s, last.e, K_LEADOUT);
    }
    entering = true; hist = []; p0 = null; closed = false; leadIn = null;
  };

  let blockDxy = 0, blockDz = 0, blockSx = 0, blockSy = 0, forceKind = -1;
  function classify(tx, ty, tz, isCut, isArc) {
    const dxy = Math.hypot(tx - x, ty - y), dz = tz - z;
    blockDxy = dxy; blockDz = dz; blockSx = x; blockSy = y;
    if (!isCut) {
      if (compPending === 40) compPending = 0; // G40 on a rapid: no lead-out move
      if (dz > 1e-6 || dxy > 1e-6) leaveMaterial();
      return;
    }
    let k = K_CUT;
    const flat = Math.abs(dz) < 1e-6;
    if ((compPending === 41 || compPending === 42) && dxy > 1e-6) {
      k = K_LEADIN; compPending = 0; leadArcNext = true; explicitLeads = true;
    } else if (leadArcNext && isArc && flat) {
      k = K_LEADIN; leadArcNext = false;
    } else if (compPending === 40 && dxy > 1e-6) {
      k = K_LEADOUT; compPending = 0; explicitLeads = true;
      const h = hist[hist.length - 1];
      if (h && h.arc && h.sweep <= LEAD_MAX_SWEEP && h.e === cut.n / 6) setKind(h.s, h.e, K_LEADOUT);
    } else if (!isArc && dz < -1e-6 && dxy < -dz * 0.2) k = K_PLUNGE;
    else if (entering && dz < -1e-6) k = K_RAMP;
    else if (!isArc && dz > 1e-6 && dxy < dz * 0.2) k = K_RETRACT;
    if (forceKind >= 0) {
      k = forceKind;
      if (k === K_LEADIN || k === K_LEADOUT) explicitLeads = true;
    }
    forceKind = -1;
    if (k !== K_LEADIN) leadArcNext = false;
    curKind = k;
  }
  function afterFeed(s, isArc) {
    const e = cut.n / 6;
    if (e === s) return;
    const k = curKind;
    if (k === K_RETRACT) { leaveMaterial(); return; }
    if (k === K_PLUNGE || k === K_RAMP) { if (!entering) leaveMaterial(); return; }
    if (Math.abs(blockDz) > 1e-6) { hist = []; entering = false; return; } // 3D move: no lead logic
    const h = { s, e, arc: isArc, sweep: isArc ? arcSweep : 0, r: isArc ? arcR : 0, len: blockDxy, sx: blockSx, sy: blockSy, ex: x, ey: y };
    if (p0 && hist.length && near(x, y, p0[0], p0[1])) closed = true;
    hist.push(h);
    if (hist.length > 3) hist.shift();
    if (entering) {
      entering = false;
      hist = [h]; p0 = [x, y];
      if (heuristic() && k === K_CUT && leadArc(h)) { setKind(s, e, K_LEADIN); leadIn = { s, e }; }
    } else if (hist.length === 2 && !leadIn && heuristic() && k === K_CUT && cutKind.a[hist[0].s] === K_CUT
      && leadArc(h) && leadLine(hist[0], h)) {
      // [line, arc] right after entry: the contour starts at the arc's end
      setKind(hist[0].s, e, K_LEADIN); leadIn = { s: hist[0].s, e }; p0 = [x, y]; closed = false;
    }
  }

  // --- Hole making
  const curTool = () => (tool !== null && toolInfo[tool]) || {};
  // One hole from a canned cycle (any controller). o: { type, x, y, init, r, bottom, top?, q, pitch?, lh?, dwell? }
  // Emits the tool path the cycle runs and records the hole for the viewer.
  function drillHole(o) {
    leaveMaterial();
    const { x: px, y: py } = o;
    const kind = HOLE_KIND[o.type];
    linear(px, py, z, false, feed);                     // position at the current level
    linear(px, py, o.r, false, feed);                   // rapid to R
    const pecks = [];
    curKind = kind;
    if ((o.type === 'peck' || o.type === 'chipbreak') && o.q > 0) {
      // peck depths count from the surface when it is known (Heidenhain Q203, Siemens RFP), else from R
      let cur = o.r, q = o.q, first = true;
      const ref = o.top !== undefined ? Math.min(o.top, o.r) : o.r;
      while (cur > o.bottom + 1e-6) {
        const next = Math.max((first ? ref : cur) - q, o.bottom);
        first = false;
        if (o.dec > 0) q = Math.max(q - o.dec, o.qMin > 0 ? o.qMin : o.dec);
        if (o.type === 'peck' && cur < o.r) linear(px, py, cur + PECK_CLEAR, false, feed);
        curKind = kind;
        linear(px, py, next, true, feed);
        if (next > o.bottom + 1e-6) {
          pecks.push(next);
          linear(px, py, o.type === 'peck' ? o.r : next + PECK_CLEAR, false, feed);
        }
        cur = next;
      }
    } else {
      linear(px, py, o.bottom, true, feed);
    }
    // feed out for taps and reaming/boring with feed return, rapid otherwise
    const feedOut = o.type === 'tap' || (o.type === 'bore' && o.feedOut);
    curKind = kind;
    linear(px, py, o.r, feedOut, feed);
    linear(px, py, o.retract, false, feed);
    const t = curTool();
    holes.push({
      type: o.type, x: px, y: py, top: o.top !== undefined ? o.top : o.r, bottom: o.bottom,
      d: o.d || (o.type === 'tap' && t.threadD) || t.d || 0, dKnown: !!(o.d || (o.type === 'tap' && t.threadD) || t.d),
      pitch: o.pitch || 0, lh: !!o.lh, pecks,
      step: stepCut.n, line: lineNo, tool,
    });
    motionCount++;
    pushStep();
  }

  // Helical bore milling / thread milling from an explicit cycle (Heidenhain 208/26x, Siemens CYCLE90,
  // Haas G12/G13). World coordinates. o: { type, x, y, d, pitch, top, bottom, setup, retract, lh }
  function helixHole(o) {
    leaveMaterial();
    if (hx) finishHelix(true);
    const t = curTool(), kind = HOLE_KIND[o.type];
    const pr = t.d > 0 && t.d < o.d ? (o.d - t.d) / 2 : o.d * 0.3; // tool-centre radius
    const depth = o.top - o.bottom;
    const turns = Math.max(1, Math.round(depth / (o.pitch > 0 ? o.pitch : Math.max(depth, 1e-3))));
    const p = plane; plane = 17;
    linear(o.x, o.y, Math.max(z, o.setup), false, feed);
    linear(o.x, o.y, o.setup, false, feed);
    curKind = kind;
    if (o.type === 'threadmill') {
      // down to the bottom, arc in, helix up one pitch per turn, arc out (climb milling, bottom-up)
      const cw = !!o.lh;
      linear(o.x, o.y, o.bottom, true, feed);
      arc(cw, o.x + pr, o.y, o.bottom, { I: pr / 2, J: 0, mm: true }, true);
      arc(cw, o.x + pr, o.y, o.top, { I: -pr, J: 0, mm: true }, true, turns - 1);
      arc(cw, o.x, o.y, o.top, { I: -pr / 2, J: 0, mm: true }, true);
    } else {
      linear(o.x, o.y, o.top, true, feed);
      linear(o.x + pr, o.y, o.top, true, feed);
      arc(false, o.x + pr, o.y, o.bottom, { I: -pr, J: 0, mm: true }, true, turns - 1);
      arc(false, o.x + pr, o.y, o.bottom, { I: -pr, J: 0, mm: true }, true); // clean-up circle at depth
      linear(o.x, o.y, o.bottom, true, feed);
    }
    linear(o.x, o.y, o.retract, false, feed);
    plane = p;
    holes.push({
      type: o.type, x: o.x, y: o.y, top: o.top, bottom: o.bottom, d: o.d, dKnown: true,
      pitch: o.type === 'threadmill' ? o.pitch : 0, lh: !!o.lh, pecks: [], step: stepCut.n, line: lineNo, tool,
    });
    motionCount++;
    pushStep();
  }

  // Canned cycles G73/G74/G76/G81–G89 of the Fanuc family (Haas, Mazak EIA, Mitsubishi, Kitamura, Okuma,
  // Brother...) and Fagor's variant (Z = reference plane, I = depth). px/py: program coordinates.
  function isoCycle(w, hasX, hasY, px, py) {
    const c = cycleCode, t = curTool(), name = t.name || '';
    let type, dec = 0;
    if (dialect === 'fagor') {
      // Fagor 8055/8060: G81-G86/G89 Z<ref plane> I<depth> K<dwell>; G83 I<step> J<count>; G69 B<step>
      if (w.Z !== undefined) cycleR = absolute ? w.Z * scale + foz : z + w.Z * scale;
      if (c === 83) {
        if (w.I !== undefined) cycleQ = Math.abs(w.I) * scale;
        if (w.J !== undefined) cycleZ = cycleR - cycleQ * w.J;
      } else if (w.I !== undefined) cycleZ = absolute ? w.I * scale + foz : cycleR + w.I * scale;
      if (c === 69 && w.B !== undefined) cycleQ = Math.abs(w.B) * scale;
    } else {
      if (w.R !== undefined) cycleR = absolute ? w.R * scale + foz : cycleInitZ + w.R * scale;
      if (w.Z !== undefined) cycleZ = absolute ? w.Z * scale + foz : cycleR + w.Z * scale;
      if (w.Q !== undefined) cycleQ = Math.abs(w.Q) * scale;
      if (w.P !== undefined) cycleP = w.P;
    }
    const reps = dialect === 'fagor' ? 1 : w.K !== undefined ? w.K : w.L !== undefined ? w.L : 1;
    const depth = cycleR - cycleZ;
    if (c === 84 || c === 74 || c === 84.2 || c === 84.3) type = 'tap';
    else if (c === 83 || c === 69) type = cycleQ > 0 ? 'peck' : 'drill';
    else if (c === 73) type = cycleQ > 0 ? 'chipbreak' : 'drill';
    else if (c === 85 || c === 86 || c === 87 || c === 88 || c === 89 || c === 76) type = 'bore';
    else if (SPOT_RE.test(name)) type = 'spot';
    else if (/DRILL|MATKAP|BOHRER|FORET/.test(name)) type = 'drill';
    else type = depth <= (t.d ? Math.min(t.d, 3.5) : 3.5) ? 'spot' : 'drill';
    let pitch = 0;
    if (type === 'tap') pitch = feedPerRev ? feed : spindle > 0 ? feed / spindle : t.pitch || 0;
    const retract = retractMode === 98 ? Math.max(cycleInitZ, cycleR) : cycleR;
    const [cx, cy] = toProg();
    let qx = hasX ? px : cx, qy = hasY ? py : cy;
    for (let i = 0; i < reps; i++) {
      if (i > 0 && !absolute) { qx += hasX ? w.X * scale : 0; qy += hasY ? w.Y * scale : 0; }
      const [wx, wy] = toWorld(qx, qy, 0);
      drillHole({ type, x: wx, y: wy, r: cycleR, bottom: cycleZ, q: cycleQ, dec, pitch, lh: c === 74, feedOut: c === 85 || c === 89, retract });
    }
  }
  // Positions for bolt-hole patterns: run the active canned cycle at each (Haas G70/G71/G72).
  function cycleAt(points) {
    for (const [qx, qy] of points) isoCycle({}, true, true, qx, qy);
  }

  // Helical interpolation → bore milling / thread milling (G17 only). A run of same-centre helical
  // arcs becomes a hole when the tool then leaves (rapid, moves up, or returns inside the circle);
  // if it moves outward instead it was the helical entry of a pocket and stays a ramp.
  let hx = null;
  function helixTrack(isCut, isArc, s, z0) {
    const dz = z - z0;
    if (isCut && isArc && plane === 17) {
      const same = hx && Math.abs(arcCx - hx.cx) < 1e-3 && Math.abs(arcCy - hx.cy) < 1e-3 && Math.abs(arcR - hx.r) < 1e-3;
      if (same && (Math.abs(dz) > 1e-6 || arcSweep > TWO_PI - 0.02)) {
        if (Math.abs(dz) > 1e-6) { hx.turns += arcSweep / TWO_PI; hx.dz += dz; }
        else hx.flat = true;
        hx.lo = Math.min(hx.lo, z); hx.hi = Math.max(hx.hi, z); hx.e = cut.n / 6; hx.step = stepCut.n - 1;
        return;
      }
      if (Math.abs(dz) > 1e-6) {
        if (hx) finishHelix(false);
        hx = { cx: arcCx, cy: arcCy, r: arcR, s, e: cut.n / 6, turns: arcSweep / TWO_PI, dz, lo: Math.min(z0, z), hi: Math.max(z0, z),
          flat: false, step: stepCut.n - 1, line: lineNo };
        return;
      }
    }
    if (!hx) return;
    const inside = Math.hypot(x - hx.cx, y - hx.cy) <= hx.r + 1e-3;
    finishHelix(!isCut || dz > 1e-6 || inside);
  }
  function finishHelix(ok) {
    const h = hx; hx = null;
    if (!ok || h.turns < 0.9) return;
    const t = curTool();
    const type = h.dz > 0 || THREAD_RE.test(t.name || '') ? 'threadmill' : 'boremill';
    setKind(h.s, h.e, HOLE_KIND[type]);
    const d = t.d ? 2 * h.r + t.d : type === 'threadmill' && t.threadD ? t.threadD : 2 * h.r;
    holes.push({
      type, x: h.cx, y: h.cy, top: h.hi, bottom: h.lo, d, dKnown: !!(t.d || (type === 'threadmill' && t.threadD)),
      pitch: type === 'threadmill' ? Math.abs(h.dz) / h.turns : 0, lh: false, pecks: [], step: h.step, line: h.line, tool,
    });
  }

  // ---------------------------------------------------------------- coordinate frames
  // Programmable frames: Fanuc G52 / G68, Siemens TRANS / ATRANS / ROT / AROT, Heidenhain cycle 7 / 10.
  // world = R·p + o, rotation about the tool axis only.
  let fc = 1, fs = 0, fox = 0, foy = 0, foz = 0, g68Saved = null;
  const toWorld = (px, py, pz) => [fc * px - fs * py + fox, fs * px + fc * py + foy, pz + foz];
  const toProg = () => { const dx = x - fox, dy = y - foy; return [fc * dx + fs * dy, -fs * dx + fc * dy, z - foz]; };
  const rotV = (vx, vy) => [fc * vx - fs * vy, fs * vx + fc * vy];
  const frame = {
    reset() { fc = 1; fs = 0; fox = foy = foz = 0; },
    set(ox, oy, oz, deg) { fc = Math.cos(deg * D2R); fs = Math.sin(deg * D2R); fox = ox; foy = oy; foz = oz; },
    shift(dx, dy, dz) { fox += fc * dx - fs * dy; foy += fs * dx + fc * dy; foz += dz; },
    rotate(deg, cx = 0, cy = 0) { // about program point (cx, cy), on top of the current frame
      const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R);
      const qx = cx - (c * cx - s * cy), qy = cy - (s * cx + c * cy);
      fox += fc * qx - fs * qy; foy += fs * qx + fc * qy;
      const nc = fc * c - fs * s; fs = fs * c + fc * s; fc = nc;
    },
    get: () => ({ ox: fox, oy: foy, oz: foz, deg: Math.atan2(fs, fc) / D2R }),
  };

  // ---------------------------------------------------------------- moves shared by all dialects
  function doMove(tx, ty, tz, isCut, arcW, cw, turns) {
    const segStart = cut.n / 6, z0 = z;
    classify(tx, ty, tz, isCut, !!arcW);
    if (arcW) arc(cw, tx, ty, tz, arcW, isCut, turns || 0);
    else linear(tx, ty, tz, isCut, feed);
    if (isCut) afterFeed(segStart, !!arcW);
    motionCount++;
    pushStep();
    helixTrack(isCut, !!arcW, segStart, z0);
  }
  const noteFeed = () => { if (feed > 0) { if (feed < minF) minF = feed; if (feed > maxF) maxF = feed; } };
  const unsupported = new Map(); // things seen but not drawn (tilted planes, pockets...) → count
  const skip = (what) => unsupported.set(what, (unsupported.get(what) || 0) + 1);
  // tool diameters in comments are in program units (inch programs → inch)
  const readTool = (c) => { const t = toolFromComment(c); if (scale !== 1 && t.d) t.d *= scale; return t; };
  const setTool = (id, name) => {
    tools.add(id); tool = id;
    if (name) toolInfo[id] = Object.assign(toolInfo[id] || {}, readTool(name));
  };

  // ---------------------------------------------------------------- program source and flow
  const ctl = isPrint ? null : self.GSController.detect(text, name);
  const dialect = ctl ? ctl.dialect : 'iso', family = ctl ? ctl.family : '';
  const head = text.length > 2e6 ? text.slice(0, 2e6) : text;
  const macros = !isPrint && /#\d|#\[|\bVC\d+\s*=|\bGOTO\b|\bWHILE\b|\bIF\s*\[/i.test(head);
  const calls = !isPrint && /\bM9[78]\s*P|\bG65\s*P|\bCALL\s+O|\bM99\b/i.test(head);
  // Programs with jumps are executed from a line array; plain CAM output streams as before.
  const lines = !isPrint && (dialect !== 'iso' || macros || calls) ? text.split('\n') : null;
  let pc = 0, halted = false, executed = 0;
  const stack = [];
  const vars = {};
  const evalx = (src) => self.GSExpr.evaluate(src, (k) => vars[k]);
  const flow = {
    next: () => pc,
    jump(i) { pc = i; },
    call(i, f) {
      if (stack.length >= MAX_DEPTH) { skip('call depth'); return false; }
      stack.push(Object.assign({ ret: pc }, f)); pc = i; return true;
    },
    ret() { const f = stack.pop(); if (f) pc = f.ret; return f; },
    top: () => stack[stack.length - 1],
    depth: () => stack.length,
    halt() { halted = true; },
  };
  // Fanuc O-numbers / Okuma O-names and N-numbers → line index
  let labelsO = null, labelsN = null;
  function indexLabels() {
    labelsO = new Map(); labelsN = new Map();
    lines.forEach((l, i) => {
      let m = /^\s*[O:]([A-Z0-9]+)/i.exec(l);
      if (m) { const k = /^\d+$/.test(m[1]) ? String(+m[1]) : m[1].toUpperCase(); if (!labelsO.has(k)) labelsO.set(k, i); }
      m = /^\s*N(\d+)/i.exec(l);
      if (m && !labelsN.has(+m[1])) labelsN.set(+m[1], i);
    });
  }
  const findBlock = (re, from, dir) => {
    for (let i = from; i >= 0 && i < lines.length; i += dir) if (re.test(lines[i].toUpperCase())) return i;
    return -1;
  };
  const whileCache = new Map();

  // Fanuc macro B / Okuma user-task flow. Returns true when the line was consumed.
  function preFlow(line) {
    let m;
    const l = line.replace(/^\s*N\d+\s*/, '');
    if ((m = /^IF\s*\[(.*)\]\s*GOTO\s*N?(\d+)/.exec(l)) || (m = /^IF\s*\[(.*)\]\s*N(\d+)\s*$/.exec(l))) {
      if (evalx(m[1])) jumpN(+m[2]);
      return true;
    }
    if ((m = /^IF\s*\[(.*)\]\s*THEN\s*(.*)$/.exec(l))) {
      if (evalx(m[1])) assign(m[2]);
      return true;
    }
    if ((m = /^GOTO\s*N?(\d+)/.exec(l))) { jumpN(+m[1]); return true; }
    if ((m = /^WHILE\s*\[(.*)\]\s*DO\s*(\d+)/.exec(l))) {
      if (!evalx(m[1])) {
        const k = 'w' + (pc - 1);
        if (!whileCache.has(k)) whileCache.set(k, findBlock(new RegExp('^\\s*(?:N\\d+\\s*)?END\\s*' + m[2] + '\\b'), pc, 1));
        const e = whileCache.get(k);
        if (e >= 0) pc = e + 1;
      }
      return true;
    }
    if ((m = /^END\s*(\d+)\s*$/.exec(l))) {
      const k = 'e' + (pc - 1);
      if (!whileCache.has(k)) whileCache.set(k, findBlock(new RegExp('^\\s*(?:N\\d+\\s*)?WHILE\\b.*\\bDO\\s*' + m[1] + '\\b'), pc - 2, -1));
      const w = whileCache.get(k);
      if (w >= 0) pc = w;
      return true;
    }
    if (/^(?:#\s*(?:\d+|\[)|VC\d+\s*=|V[A-Z]{1,3}\d*\s*=)/.test(l)) { assign(l); return true; }
    if ((m = /\bG65\s*P(\d+)/.exec(l))) {
      // macro call: address words become local variables #1..#26
      const at = labelsO.get(String(+m[1]));
      if (at === undefined) { skip('G65 P' + m[1]); return true; }
      const saved = {};
      for (let i = 1; i <= 33; i++) saved[i] = vars['#' + i];
      const ARG = { A: 1, B: 2, C: 3, I: 4, J: 5, K: 6, D: 7, E: 8, F: 9, H: 11, M: 13, Q: 17, R: 18, S: 19, T: 20, U: 21, V: 22, W: 23, X: 24, Y: 25, Z: 26 };
      for (let i = 1; i <= 33; i++) vars['#' + i] = undefined;
      const re = /([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;
      let a;
      while ((a = re.exec(l.replace(/G65\s*P\d+/, '')))) if (ARG[a[1]]) vars['#' + ARG[a[1]]] = parseFloat(a[2]);
      flow.call(at + 1, { locals: saved });
      return true;
    }
    return false;
  }
  function jumpN(n) {
    const i = labelsN.get(n);
    if (i === undefined) { skip('GOTO N' + n); halted = true; } else pc = i;
  }
  function assign(stmt) {
    const m = /^(#\s*(?:\d+|\[.*?\])|VC\d+|V[A-Z]{1,3}\d*)\s*=\s*(.+)$/.exec(stmt.trim());
    if (!m) return;
    let k = m[1].replace(/\s+/g, '');
    if (k.startsWith('#[')) k = '#' + Math.round(evalx(k.slice(2, -1)));
    const v = evalx(m[2]);
    vars[k] = Number.isFinite(v) ? v : 0;
  }
  // After the block ran: calls and returns (Fanuc M98/M97/M99, Okuma CALL/RTS), program end.
  function postFlow(line) {
    let m;
    if ((m = /\bM98\s*P(\d+)(?:\s*L(\d+))?/.exec(line)) || (m = /\bM97\s*P(\d+)(?:\s*L(\d+))?/.exec(line))) {
      const local = /M97/.test(m[0]);
      let n = +m[1], reps = m[2] ? +m[2] : 1;
      if (!local && n > 9999 && m[1].length > 4) { reps = Math.floor(n / 10000); n %= 10000; } // Fanuc P31000 = 3× O1000
      const at = local ? labelsN.get(n) : labelsO.get(String(n));
      if (at === undefined) { skip((local ? 'M97 P' : 'M98 P') + n); return; }
      if (reps > 0) flow.call(local ? at : at + 1, { reps: reps - 1, at: local ? at : at + 1 });
      return;
    }
    if ((m = /\bCALL\s+O([A-Z0-9]+)(?:\s*Q(\d+))?/.exec(line))) {
      const at = labelsO.get(m[1]);
      if (at === undefined) { skip('CALL O' + m[1]); return; }
      flow.call(at + 1, { reps: (m[2] ? +m[2] : 1) - 1, at: at + 1 });
      return;
    }
    if (/\bM99\b|^\s*(?:N\d+\s*)?RTS\b/.test(line)) {
      const f = flow.top();
      if (!f) { halted = true; return; }             // M99 in a main program: endless loop → stop
      if (f.reps > 0) { f.reps--; pc = f.at; return; }
      flow.ret();
      if (f.locals) for (let i = 1; i <= 33; i++) vars['#' + i] = f.locals[i];
      return;
    }
    if (/\bM0?2\b|\bM30\b/.test(line) && !stack.length) halted = true;
  }

  // "X#101" / "Z[#1+2]" / Okuma "X=VC1*2" → numbers, so the word parser sees plain values
  function substitute(s) {
    let out = '', i = 0;
    const n = s.length;
    while (i < n) {
      const ch = s[i];
      if (ch >= 'A' && ch <= 'Z' && !(i > 0 && /[A-Z]/.test(s[i - 1]))) {
        let j = i + 1;
        while (s[j] === ' ') j++;
        const eq = s[j] === '=';
        if (eq) { j++; while (s[j] === ' ') j++; }
        let k = j;
        if (s[k] === '-' || s[k] === '+') k++;
        if (s[k] === '#' || s[k] === '[' || (eq && (i + 1 === j - 1 || s[i + 1] === '=' || s[i + 1] === ' '))) {
          let e = j, depth = 0;
          if (eq) {
            while (e < n && (depth > 0 || s[e] !== ' ')) { if (s[e] === '[' || s[e] === '(') depth++; else if (s[e] === ']' || s[e] === ')') depth--; e++; }
          } else {
            e = k;
            if (s[e] === '[') { do { if (s[e] === '[') depth++; else if (s[e] === ']') depth--; e++; } while (e < n && depth > 0); }
            else { e++; if (s[e] === '[') { do { if (s[e] === '[') depth++; else if (s[e] === ']') depth--; e++; } while (e < n && depth > 0); } else while (e < n && /\d/.test(s[e])) e++; }
          }
          const v = evalx(s.slice(j, e));
          out += ch + (Number.isFinite(v) ? String(+v.toFixed(6)) : '0');
          i = e;
          continue;
        }
      }
      out += ch; i++;
    }
    return out;
  }

  // ---------------------------------------------------------------- ISO blocks
  // b: { g: [], m: [], w: {X: 1, ...}, cmt, inc: {X: true}, cr, turns, cip: [i1, j1], ct, centerAbs: {I: true}, tool }
  function execBlock(b) {
    const w = b.w, gl = b.g;
    let special = 0, rot = 0;
    for (let i = 0; i < gl.length; i++) {
      const g = gl[i];
      if (g === 0 || g === 1 || g === 2 || g === 3) motion = g;
      else if (g === 17 || g === 18 || g === 19) plane = g;
      else if (g === 20) { scale = 25.4; inch = true; }
      else if (g === 21) scale = 1;
      else if (g === 90) absolute = true;
      else if (g === 91) absolute = false;
      else if (g === 80) motion = 0;
      else if (isCycleG(g)) {
        if (motion !== 81) cycleInitZ = okumaReturn !== null ? okumaReturn : z;
        motion = 81; cycleCode = g;
      }
      else if (g === 94) feedPerRev = false;
      else if (g === 95) feedPerRev = true;
      else if (g === 98 || g === 99) retractMode = g;
      else if (g === 40 || g === 41 || g === 42) { if (g !== comp) compPending = g; comp = g; }
      else if (g === 68 && dialect !== 'fagor') rot = 68;
      else if (g === 69 && dialect !== 'fagor') rot = 69;
      else if (g === 73 && dialect === 'fagor') rot = 73;
      else if (g === 68.2 || g === 68.3 || g === 68.4 || g === 43.4 || g === 43.5 || g === 53.1) skip('G' + g + ' (5-axis / tilted plane)');
      else if ((g === 12 || g === 13) && family === 'haas') special = g;
      else if ((g === 70 || g === 71 || g === 72) && family === 'haas') special = g;
      else if (g === 71 && dialect === 'okuma') special = 71;
      else if ((g === 87 || g === 88) && dialect === 'fagor') { skip('G' + g + ' pocket'); return; }
      else if ((g >= 60 && g <= 64) && dialect === 'fagor') { skip('G' + g + ' pattern'); return; }
      else if (g === 150 && family === 'haas') { skip('G150 pocket'); return; }
      else if (g === 92 || g === 28 || g === 10 || g === 4 || g === 30 || g === 52 || g === 29 || g === 38.2) special = g;
    }
    for (let i = 0; i < b.m.length; i++) {
      const mm = b.m[i];
      if (mm === 82) absE = true;
      else if (mm === 83) absE = false;
      else if (mm === 6) toolChanges++;
    }
    if (b.tool !== undefined) setTool(b.tool, typeof b.tool === 'string' ? b.tool + ' ' + (b.cmt || '') : b.cmt);
    else if (w.T !== undefined) {
      tools.add(w.T); tool = w.T;
      if (b.cmt && !isPrint) toolInfo[tool] = Object.assign(toolInfo[tool] || {}, readTool(b.cmt));
    }
    if (w.S !== undefined) spindle = w.S;
    if (w.F !== undefined && w.F > 0) feed = w.F * scale;

    const hasX = w.X !== undefined, hasY = w.Y !== undefined, hasZ = w.Z !== undefined;
    if (rot) {
      if (rot === 69) { if (g68Saved) [fc, fs, fox, foy, foz] = g68Saved; g68Saved = null; return; }
      const [cx, cy] = toProg();
      const px = hasX ? w.X * scale : rot === 73 && w.I !== undefined ? w.I * scale : cx;
      const py = hasY ? w.Y * scale : rot === 73 && w.J !== undefined ? w.J * scale : cy;
      const deg = rot === 73 ? (w.Q || 0) : (w.R || 0);
      if (!g68Saved) g68Saved = [fc, fs, fox, foy, foz];
      else [fc, fs, fox, foy, foz] = g68Saved;
      frame.rotate(deg, px, py);
      return;
    }
    if (special) {
      if (special === 92) {
        if (hasX) x = w.X * scale;
        if (hasY) y = w.Y * scale;
        if (hasZ) z = w.Z * scale;
        if (w.E !== undefined) e = w.E;
      } else if (special === 28) {
        const all = !hasX && !hasY && !hasZ;
        if (all || hasX) x = 0;
        if (all || hasY) y = 0;
        if (all || hasZ) z = isPrint ? 0 : z;
      } else if (special === 52) {
        // local coordinate system, keeps a G68 rotation
        const deg = Math.atan2(fs, fc) / D2R;
        frame.set(hasX ? w.X * scale : 0, hasY ? w.Y * scale : 0, hasZ ? w.Z * scale : 0, deg);
      } else if (special === 71) {
        if (hasZ) okumaReturn = w.Z * scale + foz; // Okuma return level for canned cycles
      } else if (special === 12 || special === 13) {
        haasCircularPocket(w, special === 12);
      } else if (special >= 70 && special <= 72) {
        haasBoltPattern(w, special, hasX, hasY);
      }
      return;
    }

    if (!hasX && !hasY && !hasZ && w.E === undefined) return;

    // targets in program coordinates (per-axis AC/IC overrides for Siemens), then world
    const plain = isPrint || (fc === 1 && fs === 0 && fox === 0 && foy === 0 && foz === 0); // no frame active
    let cpx = x, cpy = y, cpz = z;
    if (!plain) [cpx, cpy, cpz] = toProg();
    const inc = b.inc;
    const px = !hasX ? cpx : (inc && inc.X !== undefined ? inc.X : !absolute) ? cpx + w.X * scale : w.X * scale;
    const py = !hasY ? cpy : (inc && inc.Y !== undefined ? inc.Y : !absolute) ? cpy + w.Y * scale : w.Y * scale;
    const pz = !hasZ ? cpz : (inc && inc.Z !== undefined ? inc.Z : !absolute) ? cpz + w.Z * scale : w.Z * scale;
    let tx = px, ty = py, tz = pz;
    if (!plain) [tx, ty, tz] = toWorld(px, py, pz);

    // extrusion
    let extruding = false;
    if (w.E !== undefined) {
      const de = absE ? w.E - e : w.E;
      e = absE ? w.E : e + w.E;
      // E-only moves are retract/unretract pairs; count filament only on moves that travel
      if (de > 0 && (hasX || hasY || hasZ)) { filament += de; extruding = true; }
    }

    if (feed > 0 && motion !== 0) { if (feed < minF) minF = feed; if (feed > maxF) maxF = feed; }

    if (motion === 81 && !isPrint) {
      if (hx) finishHelix(true);
      if (b.noCycle) { doMove(tx, ty, tz, false, null); return; } // Okuma NCYL: position only
      isoCycle(w, hasX, hasY, px, py);
      return;
    }

    if (w.E !== undefined && !hasX && !hasY && !hasZ) return; // retract/unretract only

    const isCut = isPrint ? extruding : motion !== 0;

    if (isPrint && extruding && Math.abs(tz - layerZ) > 1e-4) {
      // new layer starts
      if (layers > 0) pushStep();
      layerZ = tz; layers++;
    }

    let arcW = null, turns = 0, cw = motion === 2;
    if (motion === 2 || motion === 3) {
      if (w.I !== undefined || w.J !== undefined || w.K !== undefined || w.R !== undefined) {
        arcW = { I: w.I, J: w.J, K: w.K, R: w.R };
        if (b.centerAbs) { // Siemens I=AC(..): absolute centre in program coordinates
          if (b.centerAbs.I && w.I !== undefined) arcW.I = w.I - cpx / scale;
          if (b.centerAbs.J && w.J !== undefined) arcW.J = w.J - cpy / scale;
          if (b.centerAbs.K && w.K !== undefined) arcW.K = w.K - cpz / scale;
        }
        if ((fs !== 0) && plane === 17 && (arcW.I !== undefined || arcW.J !== undefined)) [arcW.I, arcW.J] = rotV(arcW.I || 0, arcW.J || 0);
      } else if (b.cr !== undefined) arcW = { R: b.cr };
      else if (b.cip) {
        // Siemens CIP: circle through an intermediate point
        const [ix, iy] = toWorld(b.cip[0] * scale, b.cip[1] * scale, 0);
        const c = circle3(x, y, ix, iy, tx, ty);
        if (c) { arcW = { I: c[0] - x, J: c[1] - y, mm: true }; cw = (ix - x) * (ty - y) - (iy - y) * (tx - x) < 0; }
      }
      if (b.turns) turns = b.turns;
    } else if (b.ct) {
      // tangential arc (Siemens CT, Heidenhain CT): centre from the last direction
      const cx = tx - x, cy = ty - y, nx = -ldy, ny = ldx, dn = cx * nx + cy * ny;
      if (Math.abs(dn) > 1e-9) {
        const sN = (cx * cx + cy * cy) / (2 * dn);
        arcW = { I: nx * sN, J: ny * sN, mm: true }; cw = sN < 0;
      }
    }

    if (isPrint) {
      if (arcW) arc(cw, tx, ty, tz, arcW, isCut);
      else linear(tx, ty, tz, isCut, feed);
      motionCount++;
      return;
    }
    if (b.kind !== undefined) forceKind = b.kind;
    doMove(tx, ty, tz, isCut, arcW, cw, turns);
  }
  function isCycleG(g) {
    if (dialect === 'fagor') return g === 81 || g === 82 || g === 83 || g === 84 || g === 85 || g === 86 || g === 89 || g === 69;
    return (g >= 81 && g <= 89) || g === 73 || g === 74 || g === 76 || g === 84.2 || g === 84.3;
  }
  let okumaReturn = null;
  function circle3(ax, ay, bx, by, cx, cy) {
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-12) return null;
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    return [(a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d, (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d];
  }
  // Haas G12 (CW) / G13 (CCW) circular pocket: I first radius, K finish radius, Q step, Z depth
  function haasCircularPocket(w, cw) {
    const r = (w.K !== undefined ? w.K : w.I || 0) * scale;
    if (!(r > 0)) return;
    const [cx, cy, cz] = toProg();
    const bottom = w.Z !== undefined ? (absolute ? w.Z * scale : cz + w.Z * scale) : cz;
    const [wx, wy, wz] = toWorld(cx, cy, bottom);
    helixHole({ type: 'boremill', x: wx, y: wy, d: 2 * r, pitch: 0, top: Math.max(z, wz), bottom: wz, setup: z, retract: z });
  }
  // Haas bolt patterns with an active canned cycle: G70 circle, G71 arc, G72 line (I, J, K, L)
  function haasBoltPattern(w, g, hasX, hasY) {
    if (motion !== 81) return;
    const [cx0, cy0] = toProg();
    const cx = hasX ? w.X * scale : cx0, cy = hasY ? w.Y * scale : cy0;
    const I = (w.I || 0) * scale, J = w.J || 0, L = Math.max(1, Math.round(w.L || 1));
    const pts = [];
    for (let k = 0; k < L; k++) {
      if (g === 72) pts.push([cx + k * I * Math.cos(J * D2R), cy + k * I * Math.sin(J * D2R)]);
      else {
        const a = (J + k * (g === 70 ? 360 / L : w.K || 0)) * D2R;
        pts.push([cx + I * Math.cos(a), cy + I * Math.sin(a)]);
      }
    }
    cycleAt(pts);
  }

  // ---------------------------------------------------------------- ISO line (comments, macros, words)
  let pos = 0, lastProgress = 0;
  const gList = [];
  const mList = [];
  function isoLine(raw) {
    // comments
    let cmt = '';
    let semi = raw.indexOf(';');
    if (semi !== -1) {
      const c = raw.slice(semi + 1);
      if (c.length < 300) readMeta(c, meta);
      cmt = c;
      raw = raw.slice(0, semi);
    }
    if (raw.indexOf('(') !== -1) raw = raw.replace(/\([^)]*\)?/g, (p) => { cmt += ' ' + p.slice(1, -1); return ' '; });
    if (cmt && !isPrint) {
      // tool table comments, e.g. Fusion "(T1 D=10. CR=0. - ZMIN=-9. - flat end mill)"
      const tm = /^\s*T(\d+)\b/i.exec(cmt);
      if (tm && !/\bT\d/i.test(raw)) toolInfo[+tm[1]] = Object.assign(toolInfo[+tm[1]] || {}, readTool(cmt));
    }
    if (!raw.trim()) return;
    let line = raw.toUpperCase();
    if (lines && preFlow(line)) return;
    if (macros) line = substitute(line);
    if (dialect === 'fagor' && /^\s*(?:N\d+\s*)?[#$]/.test(line)) return; // Fagor 8060 #/$ instructions
    const w = {};
    gList.length = 0; mList.length = 0;
    WORD_RE.lastIndex = 0;
    let m, any = false;
    while ((m = WORD_RE.exec(line))) {
      const L = m[1], v = parseFloat(m[2]);
      if (L === 'G') gList.push(v);
      else if (L === 'M') mList.push(v);
      else w[L] = v;
      any = true;
    }
    if (any) execBlock({ g: gList, m: mList, w, cmt, noCycle: dialect === 'okuma' && /\bNCYL\b/.test(line) });
    if (lines) postFlow(line);
  }

  // ---------------------------------------------------------------- dialect interface (js/dialects.js)
  // Adapters use program coordinates in program units (inch programs stay in inch here).
  const S = (v) => (v === undefined || v === null ? undefined : v * scale);
  const api = {
    lines, flow, vars, evalx, skip,
    lineNo: () => lineNo,
    pos: () => toProg().map((v) => v / scale),
    dirNow: () => { const [a, b] = [fc * ldx + fs * ldy, -fs * ldx + fc * ldy]; return [a, b]; },
    spindleNow: () => spindle,
    frameSet: (ox, oy, oz, deg) => frame.set(ox * scale, oy * scale, oz * scale, deg),
    frameShift: (dx, dy, dz) => frame.shift(dx * scale, dy * scale, dz * scale),
    frameGet: () => { const f = frame.get(); return { ox: f.ox / scale, oy: f.oy / scale, oz: f.oz / scale, deg: f.deg }; },
    iso: (s) => isoLine(s),
    exec: (b) => { if (!b.g) b.g = []; if (!b.m) b.m = []; execBlock(b); },
    comment(c) { if (c.length < 300) readMeta(c, meta); },
    units(isInch) { scale = isInch ? 25.4 : 1; inch = isInch; },
    feed(f) { if (f > 0) feed = f * scale; },
    spindle(sv) { if (sv > 0) spindle = sv; },
    tool(id, nm, sv) { setTool(id, nm); toolChanges++; if (sv > 0) spindle = sv; },
    toolInfo: () => curTool(),
    comp(g) { if (g !== comp) compPending = g; comp = g; },
    K: { CUT: K_CUT, LEADIN: K_LEADIN, LEADOUT: K_LEADOUT },
    // o: { x, y, z (program, absolute; omitted = unchanged), rapid, f, kind }
    move(o) {
      if (o.f > 0) feed = o.f * scale;
      const [cx, cy, cz] = toProg();
      const [tx, ty, tz] = toWorld(S(o.x) ?? cx, S(o.y) ?? cy, S(o.z) ?? cz);
      if (Math.abs(tx - x) < 1e-9 && Math.abs(ty - y) < 1e-9 && Math.abs(tz - z) < 1e-9) return;
      if (o.kind !== undefined) forceKind = o.kind;
      if (!o.rapid) noteFeed();
      doMove(tx, ty, tz, !o.rapid, null);
    },
    // o: { x, y, z, cx, cy (program centre), cw, turns, f, kind } — arcs in the XY plane
    arc(o) {
      if (o.f > 0) feed = o.f * scale;
      const [cx, cy, cz] = toProg();
      const [tx, ty, tz] = toWorld(S(o.x) ?? cx, S(o.y) ?? cy, S(o.z) ?? cz);
      const [wcx, wcy] = toWorld(S(o.cx), S(o.cy), 0);
      if (o.kind !== undefined) forceKind = o.kind;
      noteFeed();
      const p = plane; plane = 17;
      doMove(tx, ty, tz, true, { I: wcx - x, J: wcy - y, mm: true }, !!o.cw, o.turns || 0);
      plane = p;
    },
    // o: { type, x, y (program; omitted = current), surface, setup, bottom, retract (program Z), q, dec, qMin, pitch, lh, d, feedOut }
    hole(o) {
      if (o.f > 0) feed = o.f * scale;
      const [cx, cy] = toProg();
      const [wx, wy] = toWorld(S(o.x) ?? cx, S(o.y) ?? cy, 0);
      if (hx) finishHelix(true);
      noteFeed();
      drillHole(Object.assign({}, o, {
        x: wx, y: wy, r: S(o.setup) + foz, bottom: S(o.bottom) + foz, top: S(o.surface) + foz, retract: S(o.retract) + foz,
        q: S(o.q) || 0, dec: S(o.dec) || 0, qMin: S(o.qMin) || 0, pitch: S(o.pitch) || 0, d: S(o.d),
      }));
    },
    // o: { type: 'boremill'|'threadmill', x, y, d, pitch, lh, surface, bottom, setup, retract } (program)
    helixHole(o) {
      if (o.f > 0) feed = o.f * scale;
      const [cx, cy] = toProg();
      const [wx, wy] = toWorld(S(o.x) ?? cx, S(o.y) ?? cy, 0);
      noteFeed();
      helixHole(Object.assign({}, o, {
        x: wx, y: wy, top: S(o.surface) + foz, bottom: S(o.bottom) + foz, setup: S(o.setup) + foz, retract: S(o.retract) + foz,
        d: S(o.d) || 0, pitch: S(o.pitch) || 0,
      }));
    },
  };
  const adapter = lines && self.GSDialects[dialect] ? self.GSDialects[dialect](api) : null;
  if (lines) indexLabels();

  // ---------------------------------------------------------------- main loop
  for (;;) {
    let raw;
    if (lines) {
      if (halted || pc >= lines.length) break;
      if (++executed > MAX_EXEC) { skip('execution limit'); break; }
      lineNo = pc + 1;
      raw = lines[pc++];
      if ((executed & 16383) === 0) self.postMessage({ type: 'progress', value: Math.min(0.99, pc / lines.length) });
      if (raw.charCodeAt(raw.length - 1) === 13) raw = raw.slice(0, -1);
    } else {
      if (pos >= len) break;
      let nl = text.indexOf('\n', pos);
      if (nl === -1) nl = len;
      raw = text.slice(pos, nl);
      pos = nl + 1;
      lineNo++;
      if (pos - lastProgress > 2e6) {
        lastProgress = pos;
        self.postMessage({ type: 'progress', value: pos / len });
      }
    }
    if (adapter) adapter.line(raw);
    else isoLine(raw);
  }
  if (adapter && adapter.end) adapter.end();
  pushStep(); // final (last layer end / final move)
  if (!isPrint) { leaveMaterial(); if (hx) finishHelix(true); }
  const kindArr = cutKind.done();
  if (!isPrint) for (let i = 0; i < kindArr.length; i++) kindCounts[kindArr[i]]++;

  if (minX === Infinity) { minX = minY = minZ = 0; maxX = maxY = maxZ = 0; }
  if (isPrint && mMinX !== Infinity) { minX = mMinX; maxX = mMaxX; minY = mMinY; maxY = mMaxY; }
  const lineCount = lines ? lines.length - (text.endsWith('\n') ? 1 : 0) : lineNo;

  return {
    name,
    mode: isPrint ? 'print' : 'cnc',
    controller: ctl,
    inch,
    lines: lineCount,
    motionCount,
    layers: isPrint ? layers : 0,
    bounds: { minX, minY, minZ, maxX, maxY, maxZ },
    cutLen, rapidLen,
    estTime: (timeCut + timeRapid) * 60, // seconds
    filamentMm: isPrint ? filament : 0,
    minF: minF === Infinity ? 0 : minF, maxF,
    toolChanges,
    tools: [...tools].sort((a, b) => (typeof a === typeof b ? (a < b ? -1 : a > b ? 1 : 0) : typeof a === 'number' ? -1 : 1)),
    unsupported: [...unsupported].map(([k, n]) => ({ what: k, count: n })),
    meta,
    cutPos: cut.done(), rapidPos: rapid.done(), cutZ: cutZ.done(), cutKind: kindArr, kindCounts, holes,
    stepCut: stepCut.done(), stepRapid: stepRapid.done(), stepLine: stepLine.done(), stepPos: stepPos.done(),
  };
}
