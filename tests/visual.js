// node tests/visual.js [outDir] — loads programs into the real app in headless Chromium, checks what the
// page shows (controller, legend, holes, no error) and saves a screenshot of each. Needs Playwright.
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'screenshots'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

// file, what the stats panel must name, legend entries that must appear, expected hole count
const CASES = [
  ['samples/sample-heidenhain.h', /HEIDENHAIN/, ['Rapid G0', 'Feed', 'Lead-in', 'Lead-out'], (n) => n > 0],
  ['samples/sample-sinumerik.mpf', /SINUMERIK/, ['Rapid G0', 'Feed', 'Lead-in', 'Lead-out'], (n) => n > 0],
  ['samples/sample-cnc.nc', /ISO G-code/, ['Ramp', 'Lead-in', 'Tap', 'Bore milling'], (n) => n === 11],
  ['tests/fixtures/heidenhain-klartext.h', /HEIDENHAIN/, ['Spot drill', 'Tap', 'Bore milling', 'Thread milling'], (n) => n === 8],
  ['tests/fixtures/klartext-flow.h', /HEIDENHAIN/, ['Lead-in', 'Lead-out'], (n) => n > 4],
  ['tests/fixtures/siemens-840dsl.mpf', /SINUMERIK/, ['Spot drill', 'Drill / peck', 'Tap', 'Thread milling'], (n) => n === 7],
  ['tests/fixtures/fanuc-macro.nc', /FANUC/, ['Drill / peck'], (n) => n > 3],
  ['tests/fixtures/haas-patterns.nc', /Haas/i, ['Rapid G0'], (n) => n > 0],
  ['tests/fixtures/okuma-flow.min', /OKUMA|OSP/i, ['Rapid G0'], (n) => n > 0],
  ['tests/fixtures/fagor-cycles.pim', /FAGOR/i, ['Rapid G0'], (n) => n > 0],
  ['tests/fixtures/holes-iso.nc', /ISO G-code/, ['Spot drill', 'Tap', 'Bore / ream', 'Bore milling', 'Thread milling'], (n) => n === 8],
  ['tests/fixtures/leads-comp.nc', /ISO G-code/, ['Plunge', 'Ramp', 'Feed retract', 'Lead-in', 'Lead-out'], (n) => n === 0],
];

function serve() {
  const srv = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
    if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'text/plain' });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await serve();
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/cloudflareinsights/, (r) => r.abort());
  await page.goto(`http://127.0.0.1:${srv.address().port}/index.html`);

  let passed = 0, failed = 0;
  const check = (name, cond, got) => {
    if (cond) { passed++; console.log('  ok   ' + name); }
    else { failed++; console.log('  FAIL ' + name + (got !== undefined ? '  → ' + JSON.stringify(got) : '')); }
  };

  for (const [file, ctl, legend, holeCount] of CASES) {
    const name = path.basename(file);
    console.log(name);
    const before = errors.length;
    await page.evaluate(() => { const l = document.querySelector('#legend'); l.hidden = true; l.innerHTML = ''; document.querySelector('#stats').innerHTML = ''; });
    await page.locator('#fileInput2').setInputFiles(path.join(ROOT, file));
    await page.waitForFunction(() => !document.querySelector('#legend').hidden || document.querySelector('#dzError'), null, { timeout: 30000 });
    await page.waitForTimeout(400); // let the viewer frame the part and draw
    const s = await page.evaluate(() => ({
      error: document.querySelector('#dzError')?.textContent || '',
      stats: document.querySelector('#stats').innerText,
      legend: document.querySelector('#legend').innerText,
      canvas: (() => { const c = document.querySelector('#viewer canvas'); return c ? c.width * c.height : 0; })(),
    }));
    check(`${name}: loads without an error`, !s.error && errors.length === before, s.error || errors.slice(before));
    check(`${name}: controller ${ctl}`, ctl.test(s.stats), s.stats.split('\n').slice(0, 6));
    check(`${name}: legend shows ${legend.join(', ')}`, legend.every((k) => s.legend.includes(k)), s.legend);
    const n = +((/(?:Holes|Delikler) \((\d+)\)/.exec(s.stats) || [])[1] || 0);
    check(`${name}: hole count (${n})`, holeCount(n), n);
    check(`${name}: WebGL canvas drawn`, s.canvas > 0, s.canvas);
    await page.screenshot({ path: path.join(OUT, name.replace(/\W+/g, '_') + '.png') });
  }

  await browser.close();
  srv.close();
  console.log(`\n${passed} passed, ${failed} failed — screenshots in ${path.relative(process.cwd(), OUT) || '.'}`);
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
