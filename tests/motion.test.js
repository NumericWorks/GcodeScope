// Move classification: plunge / ramp / retract / lead-in / lead-out (cutKind)
const { parseFile } = require('./harness');

// kinds of the feed blocks in order (segments of one block share a kind)
const blocks = (r) => {
  const out = [];
  for (let i = 0; i < r.cutKind.length; i++) if (i === 0 || r.cutKind[i] !== r.cutKind[i - 1]) out.push(r.cutKind[i]);
  return out.join(',');
};
const K = { cut: 0, plunge: 1, ramp: 2, retract: 3, in: 4, out: 5 };

module.exports = async (t) => {
  let r = await parseFile(t.fixture('leads-cam.nc'));
  t.check('CAM leads: plunge, lead-in (line+arc), cut, lead-out (arc+line)', blocks(r) === [K.plunge, K.in, K.cut, K.out].join(','), blocks(r));

  r = await parseFile(t.fixture('leads-comp.nc'));
  t.check('G41/G40: plunge, lead-in, cut, lead-out, plunge, ramp, cut, retract',
    blocks(r) === [K.plunge, K.in, K.cut, K.out, K.plunge, K.ramp, K.cut, K.retract].join(','), blocks(r));

  r = await parseFile(t.sample('sample-cnc.nc'));
  t.check('sample: G41/G40 leads found, corner radii are not leads', r.kindCounts[K.in] > 0 && r.kindCounts[K.out] > 0, r.kindCounts);
  t.check('sample: helical pocket entry is a ramp', r.kindCounts[K.ramp] > 0, r.kindCounts);
  t.check('sample: drill cycle feeds are drill moves', r.kindCounts[7] >= 4, r.kindCounts);
};
