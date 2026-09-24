/* GcodeScope — controller languages that are not plain ISO G-code.
 * Loaded into the parser worker with importScripts(); exposes self.GSDialects[dialect](api) → { line(raw), end() }.
 *
 *  klartext       HEIDENHAIN TNC conversational (iTNC 530, TNC 320/620/640, TNC7 and older TNC 4xx)
 *  heidenhainIso  HEIDENHAIN DIN/ISO programs (%NAME G71 *, G200-series cycles with Q parameters, G79)
 *  sinumerik      Siemens SINUMERIK 840D / 840D sl / 828D / ONE (=AC/=IC, CR/TURN/CIP/CT, MCALL CYCLExx,
 *                 HOLES1/2, CYCLE801/802, frames, R parameters and DEF variables, IF/GOTO/REPEAT/WHILE/FOR)
 *
 * Adapters work in program coordinates and program units; the parser's `api` applies units, frames,
 * move classification and hole bodies (see parser.worker.js "dialect interface").
 */
'use strict';
(function () {
  const D2R = Math.PI / 180;
  const METRIC_PITCH = { 3: 0.5, 4: 0.7, 5: 0.8, 6: 1, 8: 1.25, 10: 1.5, 12: 1.75, 14: 2, 16: 2, 18: 2.5, 20: 2.5, 22: 2.5, 24: 3, 27: 3, 30: 3.5, 36: 4, 42: 4.5, 48: 5 };
  const SPOT_RE = /SPOT|CENTER|CENTRE|PUNTA|ZENTRIER|ANBOHR|NC-?DRILL|CHAMFER/;
  const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

  // ------------------------------------------------------------ HEIDENHAIN cycles (Klartext and DIN/ISO)
  // cyc: { num, q: {200: 2, ...} } for 2xx cycles, { num, old: true, p: {1: '2', ...} } for cycles 1/2/17/18.
  // pat: optional surface offset from PATTERN DEF.
  function heidenhainCycle(api, cyc, zPat = 0) {
    const [, , pz] = api.pos();
    const lastNum = (s) => { const m = /([-+]?\s*\d*\.?\d+)\s*$/.exec(s || ''); return m ? parseFloat(m[1].replace(/\s+/g, '')) : 0; };
    if (cyc.old) {
      // old fixed cycles start with the tool at set-up clearance above the surface
      const setup = Math.abs(lastNum(cyc.p[1])), depth = -Math.abs(lastNum(cyc.p[2]));
      const surface = pz - setup;
      const base = { surface, setup: pz, bottom: surface + depth, retract: pz };
      if (cyc.num === 1) {
        const q = Math.abs(lastNum(cyc.p[3]));
        api.hole(Object.assign(base, { type: q > 0 && q < -depth ? 'peck' : 'drill', q, f: lastNum(cyc.p[5]) }));
      } else if (cyc.num === 2) {
        const f = lastNum(cyc.p[4]);
        api.hole(Object.assign(base, { type: 'tap', f, pitch: api.spindleNow() > 0 ? f / api.spindleNow() : 0 }));
      } else if (cyc.num === 17 || cyc.num === 18) {
        const p = lastNum(cyc.p[3]);
        api.hole(Object.assign(base, { type: 'tap', pitch: Math.abs(p), lh: p < 0 }));
      } else api.skip('CYCL DEF ' + cyc.num);
      return;
    }
    const Q = (n, d = 0) => (cyc.q[n] !== undefined ? cyc.q[n] : d);
    const surface = Q(203) + zPat, setup = surface + Math.abs(Q(200, 2)), depth = Math.abs(Q(201));
    const retract = Math.max(surface + Q(204, Q(200, 2)), setup);
    const bottom = surface - depth;
    const base = { surface, setup, bottom, retract, f: Q(206) };
    const tool = (api.toolInfo().name || '');
    switch (cyc.num) {
      case 200: return api.hole(Object.assign(base, { type: Q(202) > 0 && Q(202) < depth - 1e-9 ? 'peck' : SPOT_RE.test(tool) ? 'spot' : 'drill', q: Q(202) }));
      case 201: return api.hole(Object.assign(base, { type: 'bore', feedOut: true }));
      case 202: case 204: return api.hole(Object.assign(base, { type: 'bore' }));
      case 203: case 205: {
        const q = Q(202), pecks = q > 0 && q < depth - 1e-9;
        const type = !pecks ? 'drill' : cyc.num === 203 && Q(213) > 0 ? 'chipbreak' : 'peck';
        return api.hole(Object.assign(base, { type, q, dec: Q(212), qMin: Q(205) }));
      }
      case 206: return api.hole(Object.assign(base, { type: 'tap', pitch: api.spindleNow() > 0 ? Q(206) / api.spindleNow() : 0 }));
      case 207: case 209: return api.hole(Object.assign(base, { type: 'tap', pitch: Math.abs(Q(239)), lh: Q(239) < 0, f: 0 }));
      case 208: return api.helixHole(Object.assign(base, { type: 'boremill', d: Q(335), pitch: Math.abs(Q(334, 0.5)), f: Q(206) }));
      case 240: {
        // centering: Q343 = 1 → Q344 is the countersink diameter (90° spot drill → depth = Ø/2)
        const byDia = Q(343) === 1, d = byDia ? Math.abs(Q(344)) : 0;
        return api.hole(Object.assign(base, { type: 'spot', bottom: surface - (byDia ? d / 2 : depth), d: d || undefined }));
      }
      case 241: return api.hole(Object.assign(base, { type: 'drill' }));
      case 262: case 263: case 264: case 265:
        return api.helixHole(Object.assign(base, { type: 'threadmill', d: Q(335), pitch: Math.abs(Q(239)), lh: Q(239) < 0, f: Q(207) }));
      default: api.skip('CYCL DEF ' + cyc.num);
    }
  }

  // PATTERN DEF points → [[x, y, zSurfaceOffset], ...]
  function heidenhainPattern(text) {
    const pts = [];
    const re = /\b(POS|ROW|PAT|FRAME|CIRC|PITCHCIRC)\d*\s*\(([^)]*)\)/gi;
    const val = (s, k, d = 0) => { const m = new RegExp('(?:^|\\s)' + k + '\\s*([-+]?\\s*\\d*\\.?\\d+)', 'i').exec(s); return m ? parseFloat(m[1].replace(/\s+/g, '')) : d; };
    let m;
    while ((m = re.exec(text))) {
      const kind = m[1].toUpperCase(), a = m[2];
      const X = val(a, 'X'), Y = val(a, 'Y'), Z = val(a, 'Z');
      if (kind === 'POS') pts.push([X, Y, Z]);
      else if (kind === 'ROW') {
        const D = val(a, 'D'), n = val(a, 'NUM', 1), r = val(a, 'ROT') * D2R;
        for (let i = 0; i < n; i++) pts.push([X + i * D * Math.cos(r), Y + i * D * Math.sin(r), Z]);
      } else if (kind === 'PAT' || kind === 'FRAME') {
        const dx = val(a, 'DX'), dy = val(a, 'DY'), nx = val(a, 'NUMX', 1), ny = val(a, 'NUMY', 1), r = val(a, 'ROT') * D2R;
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
          if (kind === 'FRAME' && j > 0 && j < ny - 1 && i > 0 && i < nx - 1) continue;
          const lx = i * dx, ly = j * dy;
          pts.push([X + lx * Math.cos(r) - ly * Math.sin(r), Y + lx * Math.sin(r) + ly * Math.cos(r), Z]);
        }
      } else {
        const R = val(a, 'D') / 2, st = val(a, 'START'), n = val(a, 'NUM', 1);
        const step = kind === 'CIRC' ? 360 / n : val(a, 'STEP');
        for (let i = 0; i < n; i++) { const t = (st + i * step) * D2R; pts.push([X + R * Math.cos(t), Y + R * Math.sin(t), Z]); }
      }
    }
    return pts;
  }

  // ------------------------------------------------------------ HEIDENHAIN Klartext
  function klartext(api) {
    const lines = api.lines, V = api.vars;
    const labels = new Map();
    lines.forEach((l, i) => {
      const m = /^\s*\d*\s*LBL\s+("[^"]*"|'[^']*'|\d+)/i.exec(l);
      if (m) { const k = m[1].replace(/["']/g, '').toUpperCase(); if (!labels.has(k)) labels.set(k, i); }
    });
    let cc = null, cyc = null, pattern = null, collect = null, modalCall = false;
    let pend = null, round = null; // one buffered flat feed line, for RND / CHF corners
    let compNow = 40, ds = [0, 0, 0], rotDeg = 0;

    const val = (s) => {
      s = s.replace(/\s+/g, '');
      const m = /^([-+]?)(Q[LRS]?\d+)$/i.exec(s);
      if (m) return (m[1] === '-' ? -1 : 1) * num(V[m[2].toUpperCase()]);
      return parseFloat(s);
    };
    const coords = (U) => {
      const c = {};
      const re = /(?:^|\s)(I?)([XYZ])\s*([-+]?\s*(?:Q[LRS]?\d+|\d*\.?\d+))/g;
      let m;
      while ((m = re.exec(U))) c[m[2]] = { v: val(m[3]), inc: m[1] === 'I' };
      return c;
    };
    const cur = () => (pend ? pend.to.slice() : api.pos());
    const target = (c, p) => ['X', 'Y', 'Z'].map((k, i) => (c[k] ? (c[k].inc ? p[i] + c[k].v : c[k].v) : p[i]));
    const feedOf = (U) => {
      const m = /(?:^|\s)F\s*(MAX|AUTO|[-+]?\s*(?:Q\d+|\d*\.?\d+))/.exec(U);
      if (!m) return { rapid: false };
      if (m[1] === 'MAX') return { rapid: true };
      if (m[1] === 'AUTO') return { rapid: false };
      return { rapid: false, f: val(m[1]) };
    };
    const compOf = (U) => { const m = /(?:^|\s)(R0|RL|RR)(?=\s|$)/.exec(U); return m ? { R0: 40, RL: 41, RR: 42 }[m[1]] : 0; };
    const mCodes = (U) => { const out = []; const re = /(?:^|\s)M(\d+)/g; let m; while ((m = re.exec(U))) out.push(+m[1]); return out; };

    function flush() {
      if (!pend) return;
      const p = pend; pend = null; round = null;
      if (p.comp) api.comp(p.comp);
      api.move({ x: p.to[0], y: p.to[1], z: p.to[2], f: p.f, kind: p.kind });
    }
    function line(to, o) {
      const from = cur();
      const flat = !o.rapid && Math.abs(to[2] - from[2]) < 1e-9 && Math.hypot(to[0] - from[0], to[1] - from[1]) > 1e-9;
      if (pend && round && flat) {
        // RND / CHF between the buffered line and this one
        const P0 = pend.from, P1 = pend.to, P2 = to;
        const la = Math.hypot(P1[0] - P0[0], P1[1] - P0[1]), lb = Math.hypot(P2[0] - P1[0], P2[1] - P1[1]);
        const u = [(P1[0] - P0[0]) / la, (P1[1] - P0[1]) / la], v = [(P2[0] - P1[0]) / lb, (P2[1] - P1[1]) / lb];
        const cross = u[0] * v[1] - u[1] * v[0], phi = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])));
        const t = round.chf ? round.r : round.r * Math.tan(phi / 2);
        if (phi > 1e-6 && t < la - 1e-9 && t < lb - 1e-9) {
          const T1 = [P1[0] - u[0] * t, P1[1] - u[1] * t, P1[2]], T2 = [P1[0] + v[0] * t, P1[1] + v[1] * t, P1[2]];
          const rr = round, f = pend.f;
          pend.to = T1; round = null; flush();
          if (rr.chf) api.move({ x: T2[0], y: T2[1], f });
          else {
            const s = cross > 0 ? 1 : -1; // left turn → CCW
            api.arc({ x: T2[0], y: T2[1], cx: T1[0] - s * u[1] * rr.r, cy: T1[1] + s * u[0] * rr.r, cw: cross < 0, f });
          }
          pend = { from: T2, to, f: o.f, comp: o.comp, kind: o.kind };
          return;
        }
      }
      flush();
      if (flat && !o.noBuffer) { pend = { from, to, f: o.f, comp: o.comp, kind: o.kind }; return; }
      if (o.comp) api.comp(o.comp);
      api.move({ x: to[0], y: to[1], z: to[2], rapid: o.rapid, f: o.f, kind: o.kind });
    }
    function arcTo(to, center, cw, o = {}) {
      flush();
      if (o.comp) api.comp(o.comp);
      api.arc({ x: to[0], y: to[1], z: to[2], cx: center[0], cy: center[1], cw, turns: o.turns || 0, f: o.f, kind: o.kind });
    }
    const dir = () => api.dirNow(); // last XY direction, program frame

    function callCycle(zPat) {
      flush();
      if (cyc) heidenhainCycle(api, cyc, zPat || 0);
    }
    function applyFrame() { api.frameSet(ds[0], ds[1], ds[2], rotDeg); }
    function jumpLabel(k) {
      const at = labels.get(String(k).replace(/["']/g, '').toUpperCase());
      if (at === undefined) { api.skip('LBL ' + k); return; }
      flush();
      api.flow.jump(at + 1);
    }

    function cycleDef(U, raw) {
      let m = /^CYCL DEF\s+(\d+)\.(\d+)\s*(.*)$/.exec(U);
      if (m) {
        const n = +m[1], sub = +m[2], rest = m[3];
        if (n === 7) { // datum shift: 7.1 X+10 / IX+5 ...
          if (sub === 0) return;
          const c = coords(' ' + rest);
          ['X', 'Y', 'Z'].forEach((k, i) => { if (c[k]) ds[i] = c[k].inc ? ds[i] + c[k].v : c[k].v; });
          applyFrame();
          return;
        }
        if (n === 10) {
          const r = /(I?)ROT\s*([-+]?\s*(?:Q\d+|\d*\.?\d+))/.exec(rest);
          if (r) { rotDeg = r[1] ? rotDeg + val(r[2]) : val(r[2]); applyFrame(); }
          return;
        }
        if (n === 8 || n === 11 || n === 26 || n === 19) { if (sub === 0) api.skip('CYCL DEF ' + n + (n === 19 ? ' (tilted plane)' : n === 8 ? ' (mirror)' : ' (scaling)')); return; }
        if (sub === 0) cyc = { num: n, old: true, p: {} };
        else if (cyc && cyc.old && cyc.num === n) cyc.p[sub] = rest;
        return;
      }
      m = /^CYCL DEF\s+(\d+)/.exec(U);
      if (!m) return;
      cyc = { num: +m[1], q: {} };
      modalCall = false;
      qParams(U);
      if (/~\s*$/.test(raw)) collect = 'cycl';
    }
    function qParams(s) {
      const re = /\bQ(\d+)\s*=\s*([-+]?\s*(?:Q[LRS]?\d+|\d*\.?\d+))/g;
      let m;
      while ((m = re.exec(s))) cyc.q[+m[1]] = val(m[2]);
    }

    function fn(U) {
      const m = /^FN\s*(\d+)\s*:\s*(.*)$/.exec(U);
      if (!m) return;
      const n = +m[1], body = m[2];
      if (n >= 9 && n <= 12) {
        const c = /IF\s+(.+?)\s+(EQU|NE|GT|LT)\s+(.+?)\s+GOTO\s+LBL\s+("[^"]*"|\S+)/.exec(body);
        if (!c) return;
        const a = api.evalx(c[1]), b = api.evalx(c[3]);
        const ok = c[2] === 'EQU' ? Math.abs(a - b) < 1e-9 : c[2] === 'NE' ? Math.abs(a - b) >= 1e-9 : c[2] === 'GT' ? a > b : a < b;
        if (ok) jumpLabel(c[4]);
        return;
      }
      const a = /^(Q[LRS]?\d+)\s*=\s*(.*)$/.exec(body);
      if (!a) return;
      let e = a[2];
      if (n === 4) e = e.replace(/\bDIV\b/g, '/');
      else if (n === 5) e = 'SQRT(' + e.replace(/\bSQRT\b/, '') + ')';
      else if (n === 6) e = 'SIN(' + e.replace(/\bSIN\b/, '') + ')';
      else if (n === 7) e = 'COS(' + e.replace(/\bCOS\b/, '') + ')';
      else if (n === 8) { const p = e.split(/\bLEN\b/); e = `SQRT((${p[0]})^2+(${p[1]})^2)`; }
      else if (n === 13) { const p = e.split(/\bANG\b/); e = `ATAN2(${p[1]},${p[0]})`; }
      const v = api.evalx(e);
      V[a[1]] = Number.isFinite(v) ? v : 0;
    }

    return {
      line(raw) {
        let s = raw.replace(/\r$/, '');
        const idx = api.flow.next() - 1;
        if (collect) {
          const U = s.toUpperCase();
          if (collect === 'cycl' && cyc) qParams(U);
          else if (collect === 'pattern') pattern.text += ' ' + U;
          if (!/~\s*$/.test(s)) collect = null;
          return;
        }
        const semi = s.indexOf(';');
        if (semi >= 0) { api.comment(s.slice(semi + 1)); s = s.slice(0, semi); }
        s = s.replace(/^\s*\d+\s+/, '').trim();
        if (!s || s[0] === '*') return;
        const U = s.toUpperCase();
        let m;

        if ((m = /^BEGIN PGM\s+\S+\s+(MM|INCH)/.exec(U))) { api.units(m[1] === 'INCH'); return; }
        if (/^END PGM/.test(U)) { flush(); api.flow.halt(); return; }
        if (/^(BLK FORM|TOOL DEF|SEL |DECLARE|FUNCTION (?:MODE|FEED|DWELL|SPINDLE|COUNT|S-PULSE)|STOP\b|CALL PGM|PGM CALL|;)/.test(U)) {
          if (/^(CALL PGM|PGM CALL)/.test(U)) api.skip('CALL PGM');
          return;
        }
        if ((m = /^TOOL CALL\s*(?:(\d+)|"([^"]*)"|'([^']*)')?/.exec(U))) {
          flush();
          const id = m[1] !== undefined ? +m[1] : (m[2] || m[3]);
          const S = /(?:^|\s)S\s*([\d.]+)/.exec(U), F = /(?:^|\s)F\s*([\d.]+)/.exec(U);
          if (id !== undefined) api.tool(id, typeof id === 'string' ? id : '', S ? +S[1] : 0);
          else if (S) api.spindle(+S[1]);
          if (F) api.feed(+F[1]);
          return;
        }
        if (/^PLANE\s/.test(U)) { if (!/^PLANE RESET/.test(U)) api.skip('PLANE (tilted plane)'); return; }
        if (/^(FUNCTION TCPM|M128)/.test(U)) { api.skip('TCPM / M128'); return; }
        if ((m = /^TRANS DATUM\s+(RESET|AXIS)?(.*)$/.exec(U))) {
          if (m[1] === 'RESET') ds = [0, 0, 0];
          else { const c = coords(' ' + m[2]); ['X', 'Y', 'Z'].forEach((k, i) => { if (c[k]) ds[i] = c[k].inc ? ds[i] + c[k].v : c[k].v; }); }
          applyFrame();
          return;
        }
        if (/^CYCL DEF/.test(U)) { flush(); cycleDef(U, s + (/~\s*$/.test(raw) ? ' ~' : '')); if (/~\s*$/.test(raw)) collect = collect || 'cycl'; return; }
        if (/^PATTERN DEF/.test(U)) { pattern = { text: U }; if (/~\s*$/.test(raw)) collect = 'pattern'; return; }
        if ((m = /^CYCL CALL\s*(PAT|POS)?(.*)$/.exec(U))) {
          flush();
          if (m[1] === 'PAT') {
            const pts = pattern ? heidenhainPattern(pattern.text) : [];
            if (!pts.length) api.skip('CYCL CALL PAT (point table)');
            for (const [px, py, pzs] of pts) { api.move({ x: px, y: py, rapid: true }); callCycle(pzs); }
          } else if (m[1] === 'POS') {
            const t = target(coords(m[2]), api.pos());
            api.move({ x: t[0], y: t[1], rapid: true });
            callCycle();
          } else callCycle();
          return;
        }
        if ((m = /^LBL\s+("[^"]*"|'[^']*'|\d+)/.exec(U))) {
          if (m[1] === '0') {
            flush();
            const f = api.flow.top();
            if (f && f.kind === 'lbl') {
              if (f.reps > 0) { f.reps--; api.flow.jump(f.at + 1); } else api.flow.ret();
            }
          }
          return;
        }
        if ((m = /^CALL LBL\s+("[^"]*"|'[^']*'|\d+)(?:\s+REP\s*(\d+))?/.exec(U))) {
          flush();
          const top = api.flow.top();
          if (top && top.kind === 'lbl' && top.callLine === idx) { // back at the call after a repeated section
            if (top.reps > 0) { top.reps--; api.flow.jump(top.at + 1); } else api.flow.ret();
            return;
          }
          const at = labels.get(m[1].replace(/["']/g, '').toUpperCase());
          if (at === undefined) { api.skip('CALL LBL ' + m[1]); return; }
          api.flow.call(at + 1, { kind: 'lbl', callLine: idx, at, reps: m[2] ? +m[2] - 1 : 0 });
          return;
        }
        if (/^FN\s*\d+\s*:/.test(U)) { fn(U); return; }
        if ((m = /^(Q[LRS]?\d+)\s*=\s*(.+)$/.exec(U))) { const v = api.evalx(m[2]); V[m[1]] = Number.isFinite(v) ? v : 0; return; }
        if (/^(FL|FLT|FC|FCT|FPOL|FSELECT|FSTART)\b/.test(U)) { flush(); api.skip('FK free contour'); return; }

        if ((m = /^CC\b(.*)$/.exec(U))) {
          const p = cur(), c = coords(m[1]);
          cc = [c.X ? (c.X.inc ? p[0] + c.X.v : c.X.v) : p[0], c.Y ? (c.Y.inc ? p[1] + c.Y.v : c.Y.v) : p[1]];
          return;
        }
        if ((m = /^RND\s+R?\s*([-+]?\s*(?:Q\d+|\d*\.?\d+))/.exec(U))) { if (pend) round = { r: Math.abs(val(m[1])) }; return; }
        if ((m = /^CHF\s+([-+]?\s*(?:Q\d+|\d*\.?\d+))/.exec(U))) { if (pend) round = { r: Math.abs(val(m[1])), chf: true }; return; }

        const ms = mCodes(U), fo = feedOf(U), comp = compOf(U);
        if (comp) compNow = comp;
        let moved = false;
        if ((m = /^L\b(.*)$/.exec(U))) {
          const to = target(coords(m[1]), cur());
          line(to, { rapid: fo.rapid, f: fo.f, comp, noBuffer: ms.includes(99) || modalCall });
          moved = true;
        } else if ((m = /^LP\b(.*)$/.exec(U))) {
          const p = cur(), c0 = cc || [0, 0];
          const pr = /(I?)PR\s*([-+]?\s*(?:Q\d+|\d*\.?\d+))/.exec(m[1]), pa = /(I?)PA\s*([-+]?\s*(?:Q\d+|\d*\.?\d+))/.exec(m[1]);
          let r = Math.hypot(p[0] - c0[0], p[1] - c0[1]), a = Math.atan2(p[1] - c0[1], p[0] - c0[0]) / D2R;
          if (pr) r = pr[1] ? r + val(pr[2]) : val(pr[2]);
          if (pa) a = pa[1] ? a + val(pa[2]) : val(pa[2]);
          const zc = coords(m[1]).Z;
          const to = [c0[0] + r * Math.cos(a * D2R), c0[1] + r * Math.sin(a * D2R), zc ? (zc.inc ? p[2] + zc.v : zc.v) : p[2]];
          line(to, { rapid: fo.rapid, f: fo.f, comp });
          moved = true;
        } else if ((m = /^C\b(.*)$/.exec(U)) || (m = /^CP\b(.*)$/.exec(U))) {
          const polar = /^CP/.test(U);
          const p = cur(), c0 = cc || [p[0], p[1]];
          const cw = /DR\s*-/.test(m[1]);
          if (!polar) {
            const to = target(coords(m[1]), p);
            arcTo(to, c0, cw, { f: fo.f, comp });
          } else {
            const pa = /(I?)PA\s*([-+]?\s*(?:Q\d+|\d*\.?\d+))/.exec(m[1]);
            const r = Math.hypot(p[0] - c0[0], p[1] - c0[1]), a0 = Math.atan2(p[1] - c0[1], p[0] - c0[0]) / D2R;
            let a1 = a0, turns = 0;
            if (pa) {
              if (pa[1]) { const ia = val(pa[2]); a1 = a0 + ia; turns = Math.max(0, Math.ceil(Math.abs(ia) / 360 - 1e-9) - 1); }
              else a1 = val(pa[2]);
            }
            const zc = coords(m[1]).Z;
            const to = [c0[0] + r * Math.cos(a1 * D2R), c0[1] + r * Math.sin(a1 * D2R), zc ? (zc.inc ? p[2] + zc.v : zc.v) : p[2]];
            arcTo(to, c0, cw, { f: fo.f, comp, turns });
          }
          moved = true;
        } else if ((m = /^CR\b(.*)$/.exec(U))) {
          flush();
          const to = target(coords(m[1]), cur());
          const r = /(?:^|\s)R\s*([-+]?\s*(?:Q\d+|\d*\.?\d+))/.exec(m[1]);
          if (comp) api.comp(comp);
          if (fo.f) api.feed(fo.f);
          api.exec({ g: [/DR\s*-/.test(m[1]) ? 2 : 3], w: { X: to[0], Y: to[1], Z: to[2], R: r ? val(r[1]) : 0 }, inc: { X: false, Y: false, Z: false } });
          moved = true;
        } else if ((m = /^CT\b(.*)$/.exec(U))) {
          flush();
          const to = target(coords(m[1]), cur());
          if (comp) api.comp(comp);
          if (fo.f) api.feed(fo.f);
          api.exec({ g: [1], w: { X: to[0], Y: to[1], Z: to[2] }, inc: { X: false, Y: false, Z: false }, ct: true });
          moved = true;
        } else if ((m = /^APPR\s+(LT|LN|CT|LCT|PLT|PLN|PCT|PLCT)\b(.*)$/.exec(U))) {
          // approach: drawn as a straight lead-in to the contour start point
          flush();
          const to = target(coords(m[2]), cur());
          if (comp) api.comp(comp);
          api.move({ x: to[0], y: to[1], z: to[2], f: fo.f, kind: api.K.LEADIN });
          moved = true;
        } else if ((m = /^DEP\s+(LT|LN|CT|LCT|PLT|PLN|PCT|PLCT)\b(.*)$/.exec(U))) {
          flush();
          const p = cur(), [dx, dy] = dir(), side = compNow === 42 ? -1 : 1;
          const len = /LEN\s*([-+]?\s*(?:Q\d+|\d*\.?\d+))/.exec(m[2]);
          api.comp(40); compNow = 40;
          if (m[1] === 'LT' && len) api.move({ x: p[0] + dx * val(len[1]), y: p[1] + dy * val(len[1]), f: fo.f, kind: api.K.LEADOUT });
          else if (m[1] === 'LN' && len) api.move({ x: p[0] - side * dy * Math.abs(val(len[1])), y: p[1] + side * dx * Math.abs(val(len[1])), f: fo.f, kind: api.K.LEADOUT });
          else if (m[1] === 'CT') {
            const r = /(?:^|\s)R\s*([-+]?\s*(?:Q\d+|\d*\.?\d+))/.exec(m[2]), cca = /CCA\s*([-+]?\s*(?:Q\d+|\d*\.?\d+))/.exec(m[2]);
            const R = r ? Math.abs(val(r[1])) : 5, A = (cca ? val(cca[1]) : 90) * D2R * side;
            const c0 = [p[0] - side * dy * R, p[1] + side * dx * R];
            const vx = p[0] - c0[0], vy = p[1] - c0[1];
            api.arc({ x: c0[0] + vx * Math.cos(A) - vy * Math.sin(A), y: c0[1] + vx * Math.sin(A) + vy * Math.cos(A), cx: c0[0], cy: c0[1], cw: side < 0, f: fo.f, kind: api.K.LEADOUT });
          } else {
            const to = target(coords(m[2]), p);
            api.move({ x: to[0], y: to[1], z: to[2], f: fo.f, kind: api.K.LEADOUT });
          }
          moved = true;
        }
        if (fo.f && !moved) api.feed(fo.f);
        if (ms.includes(99)) { callCycle(); modalCall = false; }
        else if (ms.includes(89)) { modalCall = true; if (moved) callCycle(); }
        else if (modalCall && moved) callCycle();
        if (ms.includes(30) || ms.includes(2)) { flush(); api.flow.halt(); }
      },
      end() { flush(); },
    };
  }

  // ------------------------------------------------------------ HEIDENHAIN DIN/ISO
  function heidenhainIso(api) {
    let cyc = null, collecting = false, cc = null;
    return {
      line(raw) {
        let s = raw.replace(/\r$/, '');
        const semi = s.indexOf(';');
        let cmt = '';
        if (semi >= 0) { cmt = s.slice(semi + 1); api.comment(cmt); s = s.slice(0, semi); }
        s = s.replace(/\*\s*$/, '').toUpperCase();
        let m;
        if ((m = /^\s*%\S+\s+G(70|71)\b/.exec(s))) { api.units(m[1] === '70'); return; }
        if (/^\s*%/.test(s)) { api.flow.halt(); return; }
        s = s.replace(/^\s*N\d+\s*/, '');
        if (collecting && /^Q\d+\s*=/.test(s)) {
          m = /^Q(\d+)\s*=\s*([-+]?\s*[\d.]+)/.exec(s);
          if (m) cyc.q[+m[1]] = parseFloat(m[2].replace(/\s+/g, ''));
          return;
        }
        collecting = false;
        if ((m = /^G(2\d\d)\b/.exec(s))) { cyc = { num: +m[1], q: {} }; collecting = true; return; }
        if (/^G79\b/.test(s)) { if (cyc) heidenhainCycle(api, cyc); return; }
        // I/J are absolute circle centres on HEIDENHAIN; G2/G3 without them use the last centre
        const w = {};
        const g = [], mm = [];
        const re = /([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;
        while ((m = re.exec(s))) { if (m[1] === 'G') g.push(+m[2]); else if (m[1] === 'M') mm.push(+m[2]); else w[m[1]] = +m[2]; }
        if (w.I !== undefined || w.J !== undefined) {
          const p = api.pos();
          cc = [w.I !== undefined ? w.I : p[0], w.J !== undefined ? w.J : p[1]];
          if (!g.some((v) => v === 2 || v === 3)) return; // G29-style centre only
        }
        if (w.T !== undefined) api.tool(w.T, cmt, w.S || 0);
        const arcG = g.find((v) => v === 2 || v === 3);
        if (arcG && w.R === undefined && cc) {
          const p = api.pos();
          api.arc({ x: w.X ?? p[0], y: w.Y ?? p[1], z: w.Z ?? p[2], cx: cc[0], cy: cc[1], cw: arcG === 2, f: w.F });
        } else {
          delete w.I; delete w.J; delete w.T;
          api.exec({ g: g.map((v) => (v === 70 ? 20 : v === 71 ? 21 : v)), m: mm, w, cmt });
        }
        if (mm.includes(99) && cyc) heidenhainCycle(api, cyc);
        if (mm.includes(30) || mm.includes(2)) api.flow.halt();
      },
    };
  }

  // ------------------------------------------------------------ Siemens SINUMERIK
  function sinumerik(api) {
    const lines = api.lines, V = api.vars;
    const labels = new Map(), blockIf = new Map(), loops = new Map();
    // labels and structured blocks (IF/ELSE/ENDIF, WHILE/ENDWHILE, FOR/ENDFOR, LOOP/ENDLOOP)
    const st = [];
    lines.forEach((l, i) => {
      const u = l.toUpperCase().replace(/;.*$/, '').replace(/^\s*N\d+\s*/, '').trim();
      const lm = /^([A-Z_][A-Z0-9_]*):/.exec(u);
      if (lm && !labels.has(lm[1])) labels.set(lm[1], i);
      const b = u.replace(/^[A-Z_][A-Z0-9_]*:\s*/, '');
      if (/^IF\b/.test(b) && !/\bGOTO[FBC]?\b/.test(b)) st.push({ k: 'IF', i });
      else if (/^ELSE\b/.test(b)) { const t = st[st.length - 1]; if (t && t.k === 'IF') t.else = i; }
      else if (/^ENDIF\b/.test(b)) { const t = st.pop(); if (t) { blockIf.set(t.i, { else: t.else, end: i }); if (t.else !== undefined) blockIf.set(t.else, { end: i }); } }
      else if (/^(WHILE|FOR|LOOP)\b/.test(b)) st.push({ k: b.slice(0, 3), i });
      else if (/^(ENDWHILE|ENDFOR|ENDLOOP)\b/.test(b)) { const t = st.pop(); if (t) { loops.set(t.i, i); loops.set(i, t.i); } }
    });
    const declared = new Set();
    let mcall = null, compNow = 40;
    const ADDR = /^(X|Y|Z|I|J|K|A|B|C|U|V|W|F|S|D|H|T|CR|AR|TURN|I1|J1|K1|RND|RNDM|CHF|CHR|DISR|DISCL|DISRP|FAD|AP|RP|SF|L|P|E|Q|R|O)$/;

    const evalv = (s) => {
      s = s.trim();
      if (/^"/.test(s)) return s.replace(/"/g, '');
      const v = api.evalx(s);
      return Number.isFinite(v) ? v : 0;
    };
    // split on whitespace outside () and ""
    function tokens(s) {
      const out = [];
      let cur = '', depth = 0, q = false;
      for (const ch of s) {
        if (ch === '"') q = !q;
        if (!q) { if (ch === '(' || ch === '[') depth++; else if (ch === ')' || ch === ']') depth--; }
        if (!q && depth === 0 && /\s/.test(ch)) { if (cur) out.push(cur); cur = ''; } else cur += ch;
      }
      if (cur) out.push(cur);
      // "G1X10Y20" compact words
      const res = [];
      for (const t of out) {
        if (/[=("]/.test(t) || !/^[A-Z]+[-+.\d]/.test(t) || /^[A-Z_]{3,}/.test(t)) { res.push(t); continue; }
        const re = /([A-Z]+)([-+]?\d*\.?\d+)/g;
        let m, last = 0;
        while ((m = re.exec(t))) { res.push(m[0]); last = re.lastIndex; }
        if (last < t.length) res.push(t.slice(last));
      }
      return res;
    }
    function args(s) {
      const out = [];
      let cur = '', depth = 0, q = false;
      for (const ch of s) {
        if (ch === '"') q = !q;
        if (!q) { if (ch === '(' || ch === '[') depth++; else if (ch === ')' || ch === ']') depth--; }
        if (!q && depth === 0 && ch === ',') { out.push(cur); cur = ''; } else cur += ch;
      }
      out.push(cur);
      return out.map((a) => (a.trim() === '' ? undefined : evalv(a)));
    }
    const jump = (name) => {
      const at = labels.get(name);
      if (at === undefined) { api.skip('GOTO ' + name); return; }
      api.flow.jump(at);
    };
    const tool = () => (api.toolInfo().name || '');

    // ---- cycles (classic 840D parameter order; SINUMERIK Operate keeps the leading parameters)
    function cycle(name, P) {
      const RTP = num(P[0]), RFP = num(P[1]), SDIS = Math.abs(num(P[2]));
      const DP = P[3], DPR = P[4];
      const bottom = typeof DP === 'number' ? DP : RFP - Math.abs(num(DPR));
      const base = { surface: RFP, setup: RFP + SDIS, bottom, retract: Math.max(RTP, RFP + SDIS) };
      const depth = RFP - bottom;
      switch (name) {
        case 'CYCLE81': case 'CYCLE82':
          return api.hole(Object.assign(base, { type: SPOT_RE.test(tool()) || (depth <= 3.5 && !/DRILL|MATKAP|BOHRER/.test(tool())) ? 'spot' : 'drill' }));
        case 'CYCLE83': {
          const FDEP = P[5], FDPR = P[6], DAM = num(P[7]), VARI = num(P[11], 1);
          const first = typeof FDEP === 'number' ? RFP - FDEP : Math.abs(num(FDPR));
          return api.hole(Object.assign(base, { type: first > 0 && first < depth ? (VARI === 0 ? 'chipbreak' : 'peck') : 'drill', q: first, dec: DAM, qMin: DAM }));
        }
        case 'CYCLE84': case 'CYCLE840': {
          const MPIT = num(P[name === 'CYCLE84' ? 7 : 9]), PIT = num(P[name === 'CYCLE84' ? 8 : 10]);
          const pitch = Math.abs(PIT) || METRIC_PITCH[Math.abs(MPIT)] || 0;
          return api.hole(Object.assign(base, { type: 'tap', pitch, d: Math.abs(MPIT) || undefined, lh: PIT < 0 || MPIT < 0 }));
        }
        case 'CYCLE85': return api.hole(Object.assign(base, { type: 'bore', feedOut: true }));
        case 'CYCLE86': case 'CYCLE87': case 'CYCLE88': case 'CYCLE89': return api.hole(Object.assign(base, { type: 'bore', feedOut: name === 'CYCLE89' }));
        case 'CYCLE90': {
          if (num(P[10]) === 1) { api.skip('CYCLE90 (outside thread)'); return; }
          return api.helixHole(Object.assign(base, { type: 'threadmill', x: P[11], y: P[12], d: num(P[5]), pitch: Math.abs(num(P[7])) }));
        }
        default: api.skip(name);
      }
    }
    const DRILL_CYCLES = /^CYCLE(8[1-9]|840)$/;
    function positions(name, P) {
      const pts = [];
      if (name === 'HOLES1') { // SPCA, SPCO, STA1, FDIS, DBH, NUM
        const a = num(P[2]) * D2R;
        for (let k = 0; k < num(P[5], 1); k++) { const d = num(P[3]) + k * num(P[4]); pts.push([num(P[0]) + d * Math.cos(a), num(P[1]) + d * Math.sin(a)]); }
      } else if (name === 'HOLES2') { // CPA, CPO, RAD, STA1, INDA, NUM
        const n = num(P[5], 1), inda = num(P[4]) || 360 / n;
        for (let k = 0; k < n; k++) { const a = (num(P[3]) + k * inda) * D2R; pts.push([num(P[0]) + num(P[2]) * Math.cos(a), num(P[1]) + num(P[2]) * Math.sin(a)]); }
      } else if (name === 'CYCLE801') { // SPCA, SPCO, STA, DIS1, DIS2, NUM1, NUM2
        const a = num(P[2]) * D2R;
        for (let j = 0; j < num(P[6], 1); j++) for (let i = 0; i < num(P[5], 1); i++) {
          const lx = i * num(P[3]), ly = j * num(P[4]);
          pts.push([num(P[0]) + lx * Math.cos(a) - ly * Math.sin(a), num(P[1]) + lx * Math.sin(a) + ly * Math.cos(a)]);
        }
      } else if (name === 'CYCLE802') { // XA, YA masks, then X0, Y0 ... X8, Y8
        for (let k = 2; k + 1 < Math.min(P.length, 20); k += 2) if (typeof P[k] === 'number' && typeof P[k + 1] === 'number') pts.push([P[k], P[k + 1]]);
      }
      return pts;
    }
    function callAt(pts) {
      if (!mcall) return;
      for (const [px, py] of pts) { api.move({ x: px, y: py, rapid: true }); cycle(mcall.name, mcall.P); }
    }

    function frameCmd(kw, rest) {
      const c = {};
      let m;
      const re = /\b(X|Y|Z|RPL)\s*=?\s*([^\s]+)/g;
      while ((m = re.exec(rest))) c[m[1]] = num(evalv(m[2]));
      const f = api.frameGet();
      if (kw === 'TRANS') api.frameSet(c.X || 0, c.Y || 0, c.Z || 0, 0);
      else if (kw === 'ATRANS') api.frameShift(c.X || 0, c.Y || 0, c.Z || 0);
      else if (kw === 'ROT') api.frameSet(0, 0, 0, c.RPL !== undefined ? c.RPL : c.Z || 0);
      else if (kw === 'AROT') api.frameSet(f.ox, f.oy, f.oz, f.deg + (c.RPL !== undefined ? c.RPL : c.Z || 0));
      else api.skip(kw);
    }

    return {
      line(raw) {
        let s = raw.replace(/\r$/, '');
        const idx = api.flow.next() - 1;
        const top = api.flow.top();
        if (top && top.kind === 'rep' && idx === top.stop) {
          if (--top.reps > 0) { api.flow.jump(top.start); return; }
          api.flow.ret();
          if (top.ret !== idx + 1) return; // REPEAT with an end label: continue after the REPEAT line
        }
        const semi = s.indexOf(';');
        let cmt = '';
        if (semi >= 0) { cmt = s.slice(semi + 1); api.comment(cmt); s = s.slice(0, semi); }
        let U = s.toUpperCase().trim();
        if (!U || U[0] === '%' || U[0] === '$') return;
        U = U.replace(/^N\d+\s*/, '').replace(/^:\d+\s*/, '').replace(/^[A-Z_][A-Z0-9_]*:\s*/, '');
        if (!U) return;
        let m;
        // ---- program flow
        if ((m = /^(?:IF\s+(.+?)\s+)?GOTO([FBC]?)\s+([A-Z_][A-Z0-9_]*|N\d+)/.exec(U))) {
          if (!m[1] || evalv(m[1])) jump(m[3]);
          return;
        }
        if ((m = /^IF\s+(.+)$/.exec(U))) {
          const b = blockIf.get(idx);
          if (b && !evalv(m[1])) api.flow.jump((b.else !== undefined ? b.else : b.end) + 1);
          return;
        }
        if (/^ELSE\b/.test(U)) { const b = blockIf.get(idx); if (b) api.flow.jump(b.end + 1); return; }
        if (/^ENDIF\b/.test(U)) return;
        if ((m = /^WHILE\s+(.+)$/.exec(U))) { if (!evalv(m[1]) && loops.has(idx)) api.flow.jump(loops.get(idx) + 1); return; }
        if (/^ENDWHILE\b/.test(U)) { if (loops.has(idx)) api.flow.jump(loops.get(idx)); return; }
        if ((m = /^FOR\s+([A-Z_][A-Z0-9_]*|R\d+)\s*=\s*(.+?)\s+TO\s+(.+)$/.exec(U))) {
          V[m[1]] = num(evalv(m[2]));
          if (V[m[1]] > num(evalv(m[3])) && loops.has(idx)) api.flow.jump(loops.get(idx) + 1);
          return;
        }
        if (/^ENDFOR\b/.test(U)) {
          const f = loops.get(idx);
          if (f !== undefined) {
            const fm = /FOR\s+([A-Z_][A-Z0-9_]*|R\d+)\s*=\s*(.+?)\s+TO\s+(.+)$/.exec(lines[f].toUpperCase().replace(/;.*$/, ''));
            if (fm) { V[fm[1]] = num(V[fm[1]]) + 1; if (V[fm[1]] <= num(evalv(fm[3]))) api.flow.jump(f + 1); }
          }
          return;
        }
        if (/^(LOOP|ENDLOOP)\b/.test(U)) { if (/^ENDLOOP/.test(U)) api.skip('LOOP (drawn once)'); return; }
        if ((m = /^REPEAT(B?)\s+([A-Z_][A-Z0-9_]*)(?:\s+([A-Z_][A-Z0-9_]*))?(?:\s+P\s*=\s*(\S+))?/.exec(U))) {
          const a = labels.get(m[2]), b = m[3] && m[3] !== 'P' ? labels.get(m[3]) : undefined;
          const reps = m[4] ? Math.round(num(evalv(m[4]))) : 1;
          if (a === undefined || reps < 1) return;
          if (m[1]) api.flow.call(a, { kind: 'rep', start: a, stop: a + 1, reps });
          else if (b !== undefined) api.flow.call(a, { kind: 'rep', start: a, stop: b + 1, reps });
          else api.flow.call(a, { kind: 'rep', start: a, stop: idx, reps });
          return;
        }
        if ((m = /^DEF\s+(?:REAL|INT|BOOL|CHAR|STRING\[\d+\]|AXIS|FRAME)\s+(.+)$/.exec(U))) {
          for (const part of m[1].split(',')) {
            const pm = /^\s*([A-Z_][A-Z0-9_]*)(?:\[[^\]]*\])?\s*(?:=\s*(.+))?$/.exec(part);
            if (pm) { declared.add(pm[1]); V[pm[1]] = pm[2] !== undefined ? num(evalv(pm[2])) : 0; }
          }
          return;
        }
        if (/^(M17|RET)\b/.test(U) || /\bM17\b/.test(U)) { if (!api.flow.ret()) api.flow.halt(); return; }
        if (/^(PROC|EXTERN|GROUP_|MSG|SETAL|STOPRE|WAITM|G4\b|OFFN|TRAFOOF|TRAORI|ORIWKS|ORIMKS|CYCLE832|CYCLE800\s*\(\s*\))/.test(U)) return;
        if ((m = /^(TRANS|ATRANS|ROT|AROT|MIRROR|AMIRROR|SCALE|ASCALE)\b(.*)$/.exec(U))) { frameCmd(m[1], m[2]); return; }
        if (/^CYCLE800\s*\(/.test(U)) { api.skip('CYCLE800 (swivel plane)'); return; }

        // ---- cycles and position patterns
        if ((m = /^(MCALL)?\s*([A-Z_][A-Z0-9_]*)\s*\((.*)\)\s*$/.exec(U))) {
          const name = m[2], P = args(m[3]);
          if (m[1]) { mcall = DRILL_CYCLES.test(name) ? { name, P } : null; if (!mcall) api.skip(name); return; }
          if (/^(HOLES[12]|CYCLE80[12])$/.test(name)) { callAt(positions(name, P)); return; }
          if (DRILL_CYCLES.test(name) || name === 'CYCLE90') { cycle(name, P); return; }
          if (!/^CYCLE83[0-9]|^CYCLE832/.test(name)) api.skip(name);
          return;
        }
        if (/^MCALL\s*$/.test(U)) { mcall = null; return; }

        // ---- words
        const b = { g: [], m: [], w: {}, inc: {}, centerAbs: {}, cmt };
        let assignOnly = true, any = false;
        for (const t of tokens(U)) {
          if ((m = /^([A-Z_$][A-Z0-9_]*(?:\[[^\]]*\])?)\s*=\s*(.+)$/.exec(t))) {
            const k = m[1].replace(/\[\s*(\d+)\s*\]$/, '$1'), v = m[2];
            if (ADDR.test(k)) {
              any = true; assignOnly = false;
              let am;
              if (k === 'T') { b.tool = /^"/.test(v) ? v.replace(/"/g, '') : num(evalv(v)); continue; }
              if ((am = /^(AC|IC)\s*\((.*)\)$/.exec(v))) {
                const n = num(evalv(am[2]));
                if (k === 'I' || k === 'J' || k === 'K') { b.w[k] = n; if (am[1] === 'AC') b.centerAbs[k] = true; }
                else { b.w[k] = n; b.inc[k] = am[1] === 'IC'; }
                continue;
              }
              const n = num(evalv(v));
              if (k === 'CR') b.cr = n;
              else if (k === 'TURN') b.turns = Math.max(0, Math.round(n));
              else if (k === 'I1' || k === 'J1') { b.cip = b.cip || [undefined, undefined]; b.cip[k === 'I1' ? 0 : 1] = n; }
              else if (k === 'AR') b.ar = n;
              else if (/^(RND|RNDM|CHF|CHR|DISR|DISCL|DISRP|FAD|AP|RP|SF|K1)$/.test(k)) { /* not drawn */ }
              else b.w[k] = n;
            } else if (!/^\$/.test(k)) {
              V[k] = num(evalv(v));
            }
            continue;
          }
          any = true; assignOnly = false;
          if (t === 'CIP') { b.g.push(2); b.cipMode = true; continue; }
          if (t === 'CT') { b.g.push(1); b.ct = true; continue; }
          if ((m = /^G(\d+)$/.exec(t))) {
            const g = +m[1];
            if (g === 70 || g === 700) b.g.push(20);
            else if (g === 71 || g === 710) b.g.push(21);
            else if (g === 147 || g === 247 || g === 347) { b.g.push(1); b.kind = api.K.LEADIN; }
            else if (g === 148 || g === 248 || g === 348) { b.g.push(1); b.kind = api.K.LEADOUT; }
            else if (g >= 0 && g <= 3 || g === 17 || g === 18 || g === 19 || g === 90 || g === 91 || g === 94 || g === 95 || g === 40 || g === 41 || g === 42) b.g.push(g);
            if (g === 41 || g === 42 || g === 40) compNow = g;
            continue;
          }
          if ((m = /^M(\d+)$/.exec(t))) { b.m.push(+m[1]); continue; }
          if ((m = /^([A-Z])([-+]?\d*\.?\d+)$/.exec(t))) {
            if (m[1] === 'T') b.tool = +m[2];
            else if (m[1] === 'R' && !b.g.length) { /* R parameters alone */ }
            else b.w[m[1]] = parseFloat(m[2]);
            continue;
          }
          if (/^(SUPA|G\d+\.\d+|D\d+|H\d+|FFWON|FFWOF|SOFT|BRISK|DRIVE|CFC|CFTCP|CFIN|G60[0-9]*|G64[0-9]*|G9)$/.test(t)) continue;
          if (/^[A-Z_][A-Z0-9_]*$/.test(t) && t.length > 2) { api.skip('call ' + t); continue; }
        }
        if (!any || assignOnly) return;
        if (b.cipMode) {
          // CIP: circle through the intermediate point I1/J1 (absolute)
          b.cip = [b.cip && b.cip[0] !== undefined ? b.cip[0] : api.pos()[0], b.cip && b.cip[1] !== undefined ? b.cip[1] : api.pos()[1]];
          b.g = b.g.filter((g) => g !== 2);
          b.g.push(2); // modal arc; execBlock uses b.cip
        } else delete b.cip;
        if (b.ar !== undefined && b.cr === undefined && b.w.I === undefined && b.w.J === undefined) {
          // opening angle with end point → radius
          const p = api.pos(), ex = b.w.X ?? p[0], ey = b.w.Y ?? p[1];
          const chord = Math.hypot(ex - p[0], ey - p[1]), r = chord / (2 * Math.sin(Math.min(b.ar, 359.999) * D2R / 2));
          b.cr = b.ar > 180 ? -Math.abs(r) : Math.abs(r);
        }
        const hadXY = b.w.X !== undefined || b.w.Y !== undefined;
        api.exec(b);
        if (mcall && hadXY) cycle(mcall.name, mcall.P);
        if (b.m.includes(30) || b.m.includes(2)) api.flow.halt();
      },
    };
  }

  self.GSDialects = { klartext, heidenhainIso, sinumerik };
})();
