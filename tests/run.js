// node tests/run.js  — parser regression checks (no dependencies)
'use strict';
const path = require('path');
const { parseFile } = require('./harness');

const F = (n) => path.join(__dirname, 'fixtures', n);
let failed = 0;
const check = (name, cond, got) => {
  if (cond) console.log('  ok  ' + name);
  else { failed++; console.log('  FAIL ' + name + (got !== undefined ? '  → ' + JSON.stringify(got) : '')); }
};

const controllers = [
  ['heidenhain-klartext.h', 'heidenhain', 'klartext', /iTNC 530|TNC 6/],
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

(async () => {
  console.log('controller detection');
  for (const [file, family, dialect, model] of controllers) {
    const r = await parseFile(F(file));
    const c = r.controller || {};
    check(`${file}: ${family}/${dialect} ${model}`, c.family === family && c.dialect === dialect && model.test(c.model || ''), c);
  }
  const print = await parseFile(path.join(__dirname, '..', 'samples', 'sample-print.gcode'));
  check('3D print file has no controller', print.controller === null, print.controller);

  if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch((e) => { console.error(e); process.exit(1); });
