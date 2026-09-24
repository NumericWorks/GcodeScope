// Controller languages and program flow: Klartext, HEIDENHAIN ISO, SINUMERIK, Fanuc macro B / subprograms,
// Haas patterns, Fagor and Okuma cycles
const { parseFile } = require('./harness');

const xy = (h) => `${+h.x.toFixed(2)},${+h.y.toFixed(2)}`;
const holes = (r) => r.holes.map(xy).join(' ');
const types = (r) => r.holes.map((h) => h.type).join(',');
// is there a cut vertex within tol of (px, py[, pz])?
function cutNear(r, px, py, pz, tol = 0.05) {
  const a = r.cutPos;
  for (let i = 0; i < a.length; i += 3) {
    if (Math.abs(a[i] - px) < tol && Math.abs(a[i + 1] - py) < tol && (pz === undefined || Math.abs(a[i + 2] - pz) < tol)) return true;
  }
  return false;
}
// cut vertices lying on a circle (cx, cy, R) at height pz, strictly inside the angular window [a0, a1] (deg)
function onArc(r, cx, cy, R, pz, a0, a1) {
  const a = r.cutPos;
  for (let i = 0; i < a.length; i += 3) {
    if (Math.abs(Math.hypot(a[i] - cx, a[i + 1] - cy) - R) > 0.01 || Math.abs(a[i + 2] - pz) > 1e-3) continue;
    const ang = Math.atan2(a[i + 1] - cy, a[i] - cx) * 180 / Math.PI;
    if (ang > a0 && ang < a1) return true;
  }
  return false;
}
function rapidTo(r, px, py, pz, tol = 1e-3) {
  const a = r.rapidPos;
  for (let i = 3; i < a.length; i += 6) if (Math.abs(a[i] - px) < tol && Math.abs(a[i + 1] - py) < tol && Math.abs(a[i + 2] - pz) < tol) return true;
  return false;
}

module.exports = async (t) => {
  // ---- HEIDENHAIN Klartext
  let r = await parseFile(t.fixture('heidenhain-klartext.h'));
  t.check('Klartext: cycles 240/203/207/208/262 → spot, peck, tap, bore milling, thread milling',
    types(r) === 'spot,spot,peck,peck,tap,tap,boremill,threadmill', types(r));
  const tap = r.holes.find((h) => h.type === 'tap'), tm = r.holes.find((h) => h.type === 'threadmill'), bm = r.holes.find((h) => h.type === 'boremill');
  t.check('Klartext: tap M10 pitch 1.5 (Q239, tool name), bore Ø30 (Q335), thread Ø16 P2', tap.d === 10 && tap.pitch === 1.5 && bm.d === 30 && tm.d === 16 && tm.pitch === 2, [tap, bm, tm]);
  t.check('Klartext: peck depths from surface Q203 by Q202', r.holes[2].pecks.join() === '-5,-10,-15', r.holes[2].pecks);
  t.check('Klartext: APPR/DEP are lead-in/out', r.kindCounts[4] > 0 && r.kindCounts[5] > 0, r.kindCounts);
  t.check('Klartext: C full circle around CC X+50 Y+50', onArc(r, 50, 50, 15, -3, 170, 190), null);

  r = await parseFile(t.fixture('klartext-flow.h'));
  t.check('Klartext: LBL / CALL LBL REP 2 with FN 1 and Q parameter in X', holes(r).startsWith('20,0 40,0 60,0 '), holes(r));
  t.check('Klartext: CYCL DEF 7 datum shift + PATTERN DEF CIRC1', holes(r).endsWith('220,0 200,20 180,0 200,-20'), holes(r));
  t.check('Klartext: RND R10 corner becomes an arc', onArc(r, 40, 110, 10, -2, -80, -10), null);
  t.check('Klartext: RL/R0 → lead-in/out, subprogram LBL 5 runs before M30', r.kindCounts[4] > 0 && r.kindCounts[5] > 0 && cutNear(r, -10, 100, -2), r.kindCounts);

  r = await parseFile(t.fixture('heidenhain-iso.h'));
  t.check('HEIDENHAIN ISO: G200 + Q parameters + G79 → peck at 30,20', types(r) === 'peck' && holes(r) === '30,20' && r.holes[0].pecks.join() === '-5,-10', r.holes);
  t.check('HEIDENHAIN ISO: I/J absolute centre, full circle', onArc(r, 50, 50, 10, -2, 170, 190), null);

  // ---- SINUMERIK
  r = await parseFile(t.fixture('siemens-840dsl.mpf'));
  t.check('SINUMERIK: MCALL CYCLE81/83/84 + CYCLE90', types(r) === 'spot,spot,peck,peck,tap,tap,threadmill', types(r));
  t.check('SINUMERIK: CYCLE83 degression, CYCLE84 M10 P1.5, CYCLE90 Ø16 P2',
    r.holes[2].pecks.slice(0, 3).join() === '-5,-9,-12' && r.holes[4].d === 10 && r.holes[4].pitch === 1.5 && r.holes[6].d === 16 && r.holes[6].pitch === 2, r.holes);
  t.check('SINUMERIK: G41 / G40 leads, X=AC() Y=IC(), CR=', r.kindCounts[4] > 0 && r.kindCounts[5] > 0 && cutNear(r, 100, 70) && r.bounds.maxX > 101, r.kindCounts);

  r = await parseFile(t.fixture('siemens-flow.mpf'));
  t.check('SINUMERIK: HOLES2 with MCALL', holes(r).startsWith('130,100 100,130 70,100 100,70'), holes(r));
  t.check('SINUMERIK: TRANS + AROT RPL=90 → cycle at current point, then X10 → world 200,10', holes(r).includes('100,70 20,-20 200,10 '), holes(r));
  t.check('SINUMERIK: R parameter loop with GOTOB, FOR loop', rapidTo(r, 45, 0, 50) && !rapidTo(r, 60, 0, 50) && rapidTo(r, 20, -20, 50), null);
  const sb = r.holes.find((h) => h.type === 'boremill');
  t.check('SINUMERIK: G3 I=AC() J=AC() TURN=2 helix → bore milling Ø30', sb && sb.d === 30 && sb.bottom === -6 && xy(sb) === '300,0', sb);
  t.check('SINUMERIK: CIP through I1/J1', onArc(r, 410, 0, 10, -1, 80, 100), null);

  // ---- Fanuc family: macro B, subprograms, frames
  r = await parseFile(t.fixture('fanuc-macro.nc'));
  t.check('Fanuc: WHILE loop with #vars, M98 P L2 incremental rows, G68 R90, G52',
    holes(r) === '10,0 20,0 30,0 10,30 20,30 30,30 40,30 0,10 100,0', holes(r));
  t.check('Fanuc: IF [..] GOTO skips the block', r.bounds.maxX < 999, r.bounds);

  r = await parseFile(t.fixture('haas-patterns.nc'));
  t.check('Haas: G70 bolt circle (L0 on the cycle line), inch', r.holes.filter((h) => h.type === 'spot').length === 6
    && r.holes.every((h) => h.type !== 'spot' || Math.abs(Math.hypot(h.x - 50.8, h.y - 50.8) - 25.4) < 1e-6), holes(r));
  const hb = r.holes.find((h) => h.type === 'boremill');
  t.check('Haas: G13 circular pocket K0.75 → Ø38.1, Z-0.5 incremental', hb && Math.abs(hb.d - 38.1) < 1e-9 && Math.abs(hb.bottom + 10.16) < 1e-9, hb);

  r = await parseFile(t.fixture('fagor-cycles.pim'));
  t.check('Fagor: G81 Z=reference I=depth, G83 I=step J=count, G88 pocket not drawn',
    types(r) === 'drill,drill,peck' && r.holes[0].bottom === -15 && r.holes[2].bottom === -14 && r.unsupported.some((u) => /G88/.test(u.what)), r.holes);

  r = await parseFile(t.fixture('okuma-flow.min'));
  t.check('Okuma: NCYL skips a hole, CALL O.. Q2 with VC variables', holes(r) === '10,10 30,10 10,30 20,30', holes(r));
};
