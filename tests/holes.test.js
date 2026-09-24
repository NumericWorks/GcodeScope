// Hole making: canned cycles and helical bore / thread milling become holes
const { parseFile } = require('./harness');

module.exports = async (t) => {
  const r = await parseFile(t.fixture('holes-iso.nc'));
  const H = r.holes;
  const types = H.map((h) => h.type).join(',');
  t.check('hole types in order', types === 'spot,spot,peck,chipbreak,tap,bore,boremill,threadmill', types);
  const peck = H.find((h) => h.type === 'peck');
  t.check('G83 Q5 to Z-20 from R2: pecks at -3, -8, -13, -18', peck && peck.pecks.map((v) => +v.toFixed(3)).join() === '-3,-8,-13,-18', peck);
  const cb = H.find((h) => h.type === 'chipbreak');
  t.check('G73 drills at the new X, G98 returns to initial level', cb && cb.x === 30 && cb.pecks.length === 4, cb);
  const tap = H.find((h) => h.type === 'tap');
  t.check('G84 pitch = F/S = 1.5, M10 from tool comment', tap && Math.abs(tap.pitch - 1.5) < 1e-9 && tap.d === 10, tap);
  const spot = H.find((h) => h.type === 'spot');
  t.check('spot drill diameter from tool table comment (D=10.)', spot && spot.d === 10 && spot.dKnown, spot);
  const bm = H.find((h) => h.type === 'boremill');
  t.check('bore milling: path Ø20 + tool Ø10 = Ø30, 6 mm deep', bm && Math.abs(bm.d - 30) < 1e-6 && bm.bottom === -6 && bm.x === 50 && bm.y === 40, bm);
  const tm = H.find((h) => h.type === 'threadmill');
  t.check('thread milling: ascending helix, pitch 2, Ø4+12 = 16', tm && Math.abs(tm.pitch - 2) < 1e-6 && Math.abs(tm.d - 16) < 1e-6, tm);

  const s = await parseFile(t.sample('sample-cnc.nc'));
  const st = s.holes.map((h) => h.type).join();
  t.check('sample: helical pocket entry is not a hole; spot, peck, tap, bore milling are', st === 'spot,spot,spot,spot,peck,peck,peck,peck,tap,tap,boremill', st);
};
