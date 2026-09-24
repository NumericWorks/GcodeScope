// Controller family / version detection (js/controller.js)
const { parseFile } = require('./harness');

const CASES = [
  ['heidenhain-klartext.h', 'heidenhain', 'klartext', /iTNC 530|TNC 6/],
  ['heidenhain-iso.h', 'heidenhain', 'heidenhainIso', /DIN\/ISO/],
  ['siemens-flow.mpf', 'siemens', 'sinumerik', /840D sl/],
  ['okuma-flow.min', 'okuma', 'okuma', /OSP-P300/],
  ['siemens-840dsl.mpf', 'siemens', 'sinumerik', /840D sl/],
  ['fanuc-0imf.nc', 'fanuc', 'iso', /0i-MF/],
  ['mazak-smoothg.eia', 'mazak', 'iso', /SmoothG/],
  ['mitsubishi-m80.nc', 'mitsubishi', 'iso', /M80/],
  ['kitamura.nc', 'kitamura', 'iso', /Arumatik-Mi Neo/],
  ['okuma-p300.min', 'okuma', 'okuma', /OSP-P300/],
  ['haas-ngc.nc', 'haas', 'iso', /.+/],
  ['fagor-8065.pim', 'fagor', 'fagor', /806/],
  ['generic.nc', 'iso', 'iso', /Fanuc-compatible/],
];

module.exports = async (t) => {
  for (const [file, family, dialect, model] of CASES) {
    const c = (await parseFile(t.fixture(file))).controller || {};
    t.check(`${file}: ${family}/${dialect} ${model}`, c.family === family && c.dialect === dialect && model.test(c.model || ''), c);
  }
  const print = await parseFile(t.sample('sample-print.gcode'));
  t.check('3D print file has no controller', print.controller === null, print.controller);
};
