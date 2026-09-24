// node tests/run.js  — runs every tests/*.test.js (parser regression checks, no dependencies)
'use strict';
const fs = require('fs'), path = require('path');

let failed = 0, passed = 0;
const t = {
  fixture: (n) => path.join(__dirname, 'fixtures', n),
  sample: (n) => path.join(__dirname, '..', 'samples', n),
  check(name, cond, got) {
    if (cond) { passed++; console.log('  ok   ' + name); }
    else { failed++; console.log('  FAIL ' + name + (got !== undefined ? '  → ' + JSON.stringify(got) : '')); }
  },
};

(async () => {
  for (const f of fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort()) {
    console.log(f);
    await require(path.join(__dirname, f))(t);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
