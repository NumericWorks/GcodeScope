/* GcodeScope — G-code parser (runs in a Web Worker, fully offline).
 * Input:  { file: File|Blob, name: string }
 * Output: typed arrays for rendering + summary stats.
 *
 * Handles: G0/G1/G2/G3 (modal), G17/G18/G19 arc planes, I/J/K and R arcs,
 * G20/G21 units, G90/G91, M82/M83, G92, G28, canned drill cycles G81-G83/G73
 * (simplified), slicer metadata comments (Prusa/Orca/Bambu/Cura/S3D).
 */
'use strict';
importScripts('controller.js'); // self.GSController

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
  if ((m = /\bM(\d+(?:\.\d+)?)\s*[X×]\s*(\d+(?:\.\d+)?)/.exec(u))) { info.threadD = +m[1]; info.pitch = +m[2]; }
  else if ((m = /\bM(\d+(?:\.\d+)?)\b/.exec(u)) && METRIC_PITCH[+m[1]] && /TAP|KILAVUZ|KLAVUZ|GEWINDE|THREAD|D[İI]Ş/.test(u)) {
    info.threadD = +m[1]; info.pitch = METRIC_PITCH[+m[1]];
  }
  if ((m = /\bD\s*=\s*(\d+(?:\.\d+)?)/.exec(u)) || (m = /(?:Ø|DIA(?:METER|M)?\.?\s*[-:=]?\s*|\bD)(\d+(?:\.\d+)?)/.exec(u))
    || (m = /(\d+(?:\.\d+)?)\s*MM\b/.exec(u))) info.d = +m[1];
  return info;
}
const LEAD_MAX_SWEEP = 100 * Math.PI / 180, LEAD_MAX_R = 25; // heuristic lead arc limits (mm)

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
  const arc = (cw, tx, ty, tz, w, isCut) => {
    arcSweep = 0; arcR = 0;
    // Map to plane axes: a,b in plane, c = helical axis
    let a0, b0, c0, a1, b1, c1, ia, ib;
    if (plane === 18) { a0 = z; b0 = x; c0 = y; a1 = tz; b1 = tx; c1 = ty; ia = w.K; ib = w.I; }
    else if (plane === 19) { a0 = y; b0 = z; c0 = x; a1 = ty; b1 = tz; c1 = tx; ia = w.J; ib = w.K; }
    else { a0 = x; b0 = y; c0 = z; a1 = tx; b1 = ty; c1 = tz; ia = w.I; ib = w.J; }
    let ca, cb;
    if (w.R !== undefined && ia === undefined && ib === undefined) {
      const r = w.R * scale;
      const dx = a1 - a0, dy = b1 - b0, d = Math.hypot(dx, dy);
      if (d === 0 || Math.abs(r) < d / 2 - 1e-6) { linear(tx, ty, tz, isCut, feed); return; }
      const h = Math.sqrt(Math.max(0, r * r - d * d / 4));
      // choose center side: for CW with positive R, center is to the right of chord
      let sgn = (cw ? 1 : -1) * (r > 0 ? 1 : -1);
      const mx = (a0 + a1) / 2, my = (b0 + b1) / 2;
      ca = mx + sgn * h * dy / d; cb = my - sgn * h * dx / d;
    } else {
      ca = a0 + (ia || 0) * scale; cb = b0 + (ib || 0) * scale;
    }
    const r = Math.hypot(a0 - ca, b0 - cb);
    if (!(r > 1e-9)) { linear(tx, ty, tz, isCut, feed); return; }
    let s = Math.atan2(b0 - cb, a0 - ca), t = Math.atan2(b1 - cb, a1 - ca);
    let sweep = t - s;
    if (cw) { if (sweep >= -1e-9) sweep -= 2 * Math.PI; }
    else { if (sweep <= 1e-9) sweep += 2 * Math.PI; }
    arcSweep = Math.abs(sweep); arcR = r; arcCx = ca; arcCy = cb;
    const tol = Math.min(0.02, r * 0.1);
    const step = Math.max(2 * Math.acos(Math.max(-1, 1 - tol / r)), Math.PI / 90);
    const n = Math.min(720, Math.max(4, Math.ceil(Math.abs(sweep) / step)));
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

  let blockDxy = 0, blockDz = 0, blockSx = 0, blockSy = 0;
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
      let cur = o.r;
      while (cur > o.bottom + 1e-6) {
        const next = Math.max(cur - o.q, o.bottom);
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
  }

  // Fanuc-family canned cycles G73/G74/G76/G81–G89 (also Haas, Mazak EIA, Mitsubishi, Okuma G-mode...)
  function isoCycle(hasX, hasY, tx, ty) {
    const w = words;
    if (w.R !== undefined) cycleR = absolute ? w.R * scale : cycleInitZ + w.R * scale;
    if (w.Z !== undefined) cycleZ = absolute ? w.Z * scale : cycleR + w.Z * scale;
    if (w.Q !== undefined) cycleQ = Math.abs(w.Q) * scale;
    if (w.P !== undefined) cycleP = w.P;
    const reps = w.K !== undefined ? w.K : w.L !== undefined ? w.L : 1;
    const c = cycleCode, t = curTool(), name = t.name || '';
    const depth = cycleR - cycleZ;
    let type;
    if (c === 84 || c === 74 || c === 84.2 || c === 84.3) type = 'tap';
    else if (c === 83) type = cycleQ > 0 ? 'peck' : 'drill';
    else if (c === 73) type = cycleQ > 0 ? 'chipbreak' : 'drill';
    else if (c === 85 || c === 86 || c === 87 || c === 88 || c === 89 || c === 76) type = 'bore';
    else if (SPOT_RE.test(name)) type = 'spot';
    else if (/DRILL|MATKAP|BOHRER|FORET/.test(name)) type = 'drill';
    else type = depth <= (t.d ? Math.min(t.d, 3.5) : 3.5) ? 'spot' : 'drill';
    let pitch = 0;
    if (type === 'tap') pitch = feedPerRev ? feed : spindle > 0 ? feed / spindle : t.pitch || 0;
    let px = hasX ? tx : x, py = hasY ? ty : y;
    for (let i = 0; i < reps; i++) {
      if (i > 0 && !absolute) { px += hasX ? w.X * scale : 0; py += hasY ? w.Y * scale : 0; }
      drillHole({
        type, x: px, y: py, r: cycleR, bottom: cycleZ, q: cycleQ, pitch, lh: c === 74,
        feedOut: c === 85 || c === 89, retract: retractMode === 98 ? Math.max(cycleInitZ, cycleR) : cycleR,
      });
    }
  }

  // Helical interpolation → bore milling / thread milling (G17 only). A run of same-centre helical
  // arcs becomes a hole when the tool then leaves (rapid, moves up, or returns inside the circle);
  // if it moves outward instead it was the helical entry of a pocket and stays a ramp.
  let hx = null;
  const TWO_PI = 2 * Math.PI;
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

  let pos = 0, lastProgress = 0;
  let words = {};
  const gList = [];
  const mList = [];

  while (pos < len) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1) nl = len;
    let raw = text.slice(pos, nl);
    pos = nl + 1;
    lineNo++;

    if (pos - lastProgress > 2e6) {
      lastProgress = pos;
      self.postMessage({ type: 'progress', value: pos / len });
    }

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
      if (tm && !/\bT\d/i.test(raw)) toolInfo[+tm[1]] = Object.assign(toolInfo[+tm[1]] || {}, toolFromComment(cmt));
    }
    if (!raw.trim()) continue;
    const line = raw.toUpperCase();

    words = {};
    gList.length = 0; mList.length = 0;
    WORD_RE.lastIndex = 0;
    let m, any = false;
    while ((m = WORD_RE.exec(line))) {
      const L = m[1], v = parseFloat(m[2]);
      if (L === 'G') gList.push(v);
      else if (L === 'M') mList.push(v);
      else words[L] = v;
      any = true;
    }
    if (!any) continue;

    let special = 0; // non-modal G with axis words (G92/G28/G10/G4/G53...)
    for (let i = 0; i < gList.length; i++) {
      const g = gList[i];
      if (g === 0 || g === 1 || g === 2 || g === 3) motion = g;
      else if (g === 17 || g === 18 || g === 19) plane = g;
      else if (g === 20) { scale = 25.4; inch = true; }
      else if (g === 21) scale = 1;
      else if (g === 90) absolute = true;
      else if (g === 91) absolute = false;
      else if (g === 80) motion = 0;
      else if ((g >= 81 && g <= 89) || g === 73 || g === 74 || g === 76 || g === 84.2 || g === 84.3) {
        if (motion !== 81) cycleInitZ = z;
        motion = 81; cycleCode = g;
      }
      else if (g === 94) feedPerRev = false;
      else if (g === 95) feedPerRev = true;
      else if (g === 98 || g === 99) retractMode = g;
      else if (g === 40 || g === 41 || g === 42) { if (g !== comp) compPending = g; comp = g; }
      else if (g === 92 || g === 28 || g === 10 || g === 4 || g === 30 || g === 52 || g === 29 || g === 38.2) special = g;
    }
    for (let i = 0; i < mList.length; i++) {
      const mm = mList[i];
      if (mm === 82) absE = true;
      else if (mm === 83) absE = false;
      else if (mm === 6) toolChanges++;
    }
    if (words.T !== undefined) {
      tools.add(words.T); tool = words.T;
      if (cmt && !isPrint) toolInfo[tool] = Object.assign(toolInfo[tool] || {}, toolFromComment(cmt));
    }
    if (words.S !== undefined) spindle = words.S;
    if (words.F !== undefined && words.F > 0) {
      feed = words.F * scale;
    }

    const hasX = words.X !== undefined, hasY = words.Y !== undefined, hasZ = words.Z !== undefined;

    if (special) {
      if (special === 92) {
        if (hasX) x = words.X * scale;
        if (hasY) y = words.Y * scale;
        if (hasZ) z = words.Z * scale;
        if (words.E !== undefined) e = words.E;
      } else if (special === 28) {
        const all = !hasX && !hasY && !hasZ;
        if (all || hasX) x = 0;
        if (all || hasY) y = 0;
        if (all || hasZ) z = isPrint ? 0 : z;
      }
      continue;
    }

    if (!hasX && !hasY && !hasZ && words.E === undefined) continue;

    let tx = hasX ? words.X * scale : x, ty = hasY ? words.Y * scale : y, tz = hasZ ? words.Z * scale : z;
    if (!absolute) {
      tx = x + (hasX ? words.X * scale : 0);
      ty = y + (hasY ? words.Y * scale : 0);
      tz = z + (hasZ ? words.Z * scale : 0);
    }

    // extrusion
    let extruding = false;
    if (words.E !== undefined) {
      const de = absE ? words.E - e : words.E;
      e = absE ? words.E : e + words.E;
      // E-only moves are retract/unretract pairs; count filament only on moves that travel
      if (de > 0 && (hasX || hasY || hasZ)) { filament += de; extruding = true; }
    }

    if (feed > 0 && motion !== 0) { if (feed < minF) minF = feed; if (feed > maxF) maxF = feed; }

    if (motion === 81 && !isPrint) {
      if (hx) finishHelix(true);
      isoCycle(hasX, hasY, tx, ty);
      motionCount++;
      pushStep();
      continue;
    }

    if (words.E !== undefined && !hasX && !hasY && !hasZ) continue; // retract/unretract only

    const isCut = isPrint ? extruding : motion !== 0;

    if (isPrint && extruding && Math.abs(tz - layerZ) > 1e-4) {
      // new layer starts
      if (layers > 0) pushStep();
      layerZ = tz; layers++;
    }

    const isArc = (motion === 2 || motion === 3) && (words.I !== undefined || words.J !== undefined || words.K !== undefined || words.R !== undefined);
    const segStart = cut.n / 6, z0 = z;
    if (!isPrint) classify(tx, ty, tz, isCut, isArc);
    if (isArc) arc(motion === 2, tx, ty, tz, words, isCut);
    else linear(tx, ty, tz, isCut, feed);
    if (!isPrint && isCut) afterFeed(segStart, isArc);
    motionCount++;
    if (!isPrint) { pushStep(); helixTrack(isCut, isArc, segStart, z0); }
  }
  pushStep(); // final (last layer end / final move)
  if (!isPrint) { leaveMaterial(); if (hx) finishHelix(true); }
  const kindArr = cutKind.done();
  if (!isPrint) for (let i = 0; i < kindArr.length; i++) kindCounts[kindArr[i]]++;

  if (minX === Infinity) { minX = minY = minZ = 0; maxX = maxY = maxZ = 0; }
  if (isPrint && mMinX !== Infinity) { minX = mMinX; maxX = mMaxX; minY = mMinY; maxY = mMaxY; }

  return {
    name,
    mode: isPrint ? 'print' : 'cnc',
    controller: isPrint ? null : self.GSController.detect(text, name),
    inch,
    lines: lineNo,
    motionCount,
    layers: isPrint ? layers : 0,
    bounds: { minX, minY, minZ, maxX, maxY, maxZ },
    cutLen, rapidLen,
    estTime: (timeCut + timeRapid) * 60, // seconds
    filamentMm: isPrint ? filament : 0,
    minF: minF === Infinity ? 0 : minF, maxF,
    toolChanges, tools: [...tools].sort((a, b) => a - b),
    meta,
    cutPos: cut.done(), rapidPos: rapid.done(), cutZ: cutZ.done(), cutKind: kindArr, kindCounts, holes,
    stepCut: stepCut.done(), stepRapid: stepRapid.done(), stepLine: stepLine.done(), stepPos: stepPos.done(),
  };
}
