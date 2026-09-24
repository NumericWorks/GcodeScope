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
class UintBuf {
  constructor(cap) { this.a = new Uint32Array(cap || 16384); this.n = 0; }
  push(v) {
    if (this.n + 1 > this.a.length) { const b = new Uint32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  done() { return this.a.slice(0, this.n); }
}

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
      result.stepRapid.buffer, result.stepLine.buffer, result.stepPos.buffer, result.cutZ.buffer];
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
  const stepCut = new UintBuf(), stepRapid = new UintBuf(), stepLine = new UintBuf();
  const stepPos = new FloatBuf(1 << 14);

  // Machine state (always stored in mm)
  let x = 0, y = 0, z = 0, e = 0;
  let absolute = true, absE = true, scale = 1, inch = false;
  let motion = 0; // 0..3, or 81.. for canned cycle
  let plane = 17, feed = 0;
  let retractMode = 98, cycleR = 0, cycleZ = 0;
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

  const arc = (cw, tx, ty, tz, w, isCut) => {
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
    let semi = raw.indexOf(';');
    if (semi !== -1) {
      const c = raw.slice(semi + 1);
      if (c.length < 300) readMeta(c, meta);
      raw = raw.slice(0, semi);
    }
    if (raw.indexOf('(') !== -1) raw = raw.replace(/\([^)]*\)?/g, ' ');
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
      else if (g === 81 || g === 82 || g === 83 || g === 73 || g === 85 || g === 86 || g === 89 || g === 84) motion = 81;
      else if (g === 98 || g === 99) retractMode = g;
      else if (g === 92 || g === 28 || g === 10 || g === 4 || g === 30 || g === 52 || g === 29 || g === 38.2) special = g;
    }
    for (let i = 0; i < mList.length; i++) {
      const mm = mList[i];
      if (mm === 82) absE = true;
      else if (mm === 83) absE = false;
      else if (mm === 6) toolChanges++;
    }
    if (words.T !== undefined) tools.add(words.T);
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
      // Canned drill cycle (simplified): rapid XY, rapid to R, feed to Z, rapid back
      if (words.R !== undefined) cycleR = absolute ? words.R * scale : z + words.R * scale;
      if (hasZ) cycleZ = absolute ? words.Z * scale : cycleR + words.Z * scale;
      const initZ = z;
      const px = hasX ? tx : x, py = hasY ? ty : y;
      linear(px, py, Math.max(initZ, cycleR), false, feed);
      linear(px, py, cycleR, false, feed);
      linear(px, py, cycleZ, true, feed);
      linear(px, py, retractMode === 98 ? Math.max(initZ, cycleR) : cycleR, false, feed);
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

    if ((motion === 2 || motion === 3) && (words.I !== undefined || words.J !== undefined || words.K !== undefined || words.R !== undefined)) {
      arc(motion === 2, tx, ty, tz, words, isCut);
    } else {
      linear(tx, ty, tz, isCut, feed);
    }
    motionCount++;
    if (!isPrint) pushStep();
  }
  pushStep(); // final (last layer end / final move)

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
    cutPos: cut.done(), rapidPos: rapid.done(), cutZ: cutZ.done(),
    stepCut: stepCut.done(), stepRapid: stepRapid.done(), stepLine: stepLine.done(), stepPos: stepPos.done(),
  };
}
