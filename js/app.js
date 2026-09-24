// GcodeScope — UI glue
import { Viewer } from './viewer.js';

const CFG = window.GS_CONFIG || {};
const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------- i18n
const I18N = {
  en: {
    soon: 'Coming soon', dzTitle: 'Drop a G-code file', dzSub: '.gcode · .nc · .ngc · .tap · .gco',
    pickFile: 'Choose file', trySample: 'or try a sample:', samplePrint: '3D print', sampleCnc: 'CNC part',
    privacy: 'Processed on your device. Your file is never uploaded.', loading: 'Reading file…',
    viewTop: 'Top view', viewFront: 'Front view', openOther: 'Open another file',
    showRapids: 'Rapid moves', showTravel: 'Travel moves', onlyCurrent: 'Current layer only',
    summary: 'Summary', modePrint: '3D print', modeCnc: 'CNC / CAM',
    sSize: 'Size (X × Y × Z)', sLayers: 'Layers', sLines: 'Lines', sMoves: 'Moves', sTime: 'Estimated time',
    sFilament: 'Filament', sSlicer: 'Slicer', sUnits: 'Units', sFeed: 'Feed range', sTools: 'Tools',
    sCutLen: 'Cutting length', sRapidLen: 'Rapid length', sMaterial: 'Material',
    fromFile: 'from file', rough: 'rough', unitsIn: 'inch (shown in mm)', unitsMm: 'mm',
    estNotePrint: '“rough” values are computed from distances and feed rates and ignore acceleration.',
    estNoteCnc: 'Time is a rough estimate: feed moves at programmed F, rapids assumed at 5000 mm/min, no acceleration.',
    layer: 'Layer', of: 'of', move: 'Move', line: 'line',
    appTitle: 'Mobile app — coming soon',
    appText: 'We’re building an ad-free mobile app that works offline at the machine — CNC-first (FANUC/HAAS, arcs, code ↔ toolpath sync) plus Bambu multi-plate .gcode.3mf.',
    faqTitle: 'About',
    faq1q: 'Is my file uploaded anywhere?', faq1a: 'No. The file is read and rendered by your browser. Nothing is sent to a server — you can even disconnect after the page loads.',
    faq2q: 'Which files work?', faq2a: 'G-code from slicers (PrusaSlicer, OrcaSlicer, Bambu Studio, Cura…) and CAM/CNC programs (.nc, .ngc, .tap). Arcs (G2/G3), inch/mm, absolute/incremental and basic drill cycles are supported.',
    faq3q: 'How accurate is the time estimate?', faq3a: 'If the slicer wrote a time into the file, we show that. Otherwise we compute a rough value from distances and feed rates, ignoring acceleration — real jobs usually take longer.',
    footer: 'Workshop tools that respect your time.',
    errParse: 'Could not read this file: ', errEmpty: 'No moves found in this file. Is it G-code?',
    err3mf: '.3mf / .gcode.3mf files are not supported yet — coming in the app. Export plain .gcode for now.',
  },
  tr: {
    soon: 'Yakında', dzTitle: 'G-code dosyasını bırak', dzSub: '.gcode · .nc · .ngc · .tap · .gco',
    pickFile: 'Dosya seç', trySample: 'ya da örnek dene:', samplePrint: '3D baskı', sampleCnc: 'CNC parça',
    privacy: 'Cihazında işlenir. Dosyan hiçbir yere yüklenmez.', loading: 'Dosya okunuyor…',
    viewTop: 'Üstten görünüm', viewFront: 'Önden görünüm', openOther: 'Başka dosya aç',
    showRapids: 'Hızlı hareketler', showTravel: 'Boş hareketler', onlyCurrent: 'Yalnızca bu katman',
    summary: 'Özet', modePrint: '3D baskı', modeCnc: 'CNC / CAM',
    sSize: 'Boyut (X × Y × Z)', sLayers: 'Katman', sLines: 'Satır', sMoves: 'Hareket', sTime: 'Tahmini süre',
    sFilament: 'Filament', sSlicer: 'Dilimleyici', sUnits: 'Birim', sFeed: 'İlerleme (F) aralığı', sTools: 'Takımlar',
    sCutLen: 'Kesme yolu', sRapidLen: 'Hızlı hareket yolu', sMaterial: 'Malzeme',
    fromFile: 'dosyadan', rough: 'kaba', unitsIn: 'inç (mm gösterilir)', unitsMm: 'mm',
    estNotePrint: '“kaba” değerler mesafe ve ilerleme hızından hesaplanır, ivmelenmeyi hesaba katmaz.',
    estNoteCnc: 'Süre kaba tahmindir: kesme hareketleri programlı F ile, hızlı hareketler 5000 mm/dk varsayımıyla, ivmelenme yok.',
    layer: 'Katman', of: '/', move: 'Hareket', line: 'satır',
    appTitle: 'Mobil uygulama — yakında',
    appText: 'Reklamsız, makine başında çevrimdışı çalışan bir mobil uygulama hazırlıyoruz — CNC öncelikli (FANUC/HAAS, yaylar, kod ↔ takım yolu senkronu) ve Bambu çok plakalı .gcode.3mf desteği.',
    faqTitle: 'Hakkında',
    faq1q: 'Dosyam bir yere yükleniyor mu?', faq1a: 'Hayır. Dosya tarayıcında okunur ve çizilir. Sunucuya hiçbir şey gönderilmez — sayfa açıldıktan sonra internet bağlantısını kesebilirsin.',
    faq2q: 'Hangi dosyalar çalışır?', faq2a: 'Dilimleyici çıktıları (PrusaSlicer, OrcaSlicer, Bambu Studio, Cura…) ve CAM/CNC programları (.nc, .ngc, .tap). Yaylar (G2/G3), inç/mm, mutlak/artımlı ve temel delme çevrimleri desteklenir.',
    faq3q: 'Süre tahmini ne kadar doğru?', faq3a: 'Dilimleyici dosyaya süre yazdıysa onu gösteririz. Yoksa mesafe ve ilerleme hızından kaba bir değer hesaplarız; ivmelenme hesaba katılmaz, gerçek iş genelde daha uzun sürer.',
    footer: 'Zamanına saygı duyan atölye araçları.',
    errParse: 'Dosya okunamadı: ', errEmpty: 'Bu dosyada hareket bulunamadı. G-code olduğundan emin misin?',
    err3mf: '.3mf / .gcode.3mf henüz desteklenmiyor — uygulamada gelecek. Şimdilik düz .gcode dışa aktar.',
  },
};
let lang = (() => {
  try { const s = localStorage.getItem('gs-lang'); if (s && I18N[s]) return s; } catch {}
  return 'en'; // English by default; Turkish only when chosen in the top bar
})();
const t = (k) => I18N[lang][k] ?? I18N.en[k] ?? k;

function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
  if (current) { renderSummary(current); renderLegend(current); updateLabel(); }
}
document.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.lang === lang) return;
  lang = b.dataset.lang;
  try { localStorage.setItem('gs-lang', lang); } catch {}
  applyLang();
}));

// ---------------------------------------------------------------- viewer
const viewer = new Viewer($('#viewer'));
let current = null;
let worker = null;

function setLoading(on, pct) {
  $('#loading').hidden = !on;
  $('#loadPct').textContent = pct != null ? Math.round(pct * 100) + '%' : '';
}

function showError(msg) {
  setLoading(false);
  $('#dropzone').hidden = false;
  let el = $('#dzError');
  if (!el) {
    el = document.createElement('p');
    el.id = 'dzError';
    el.className = 'error';
    $('.dz-inner').appendChild(el);
  }
  el.textContent = msg;
}

function openFile(file) {
  if (!file) return;
  if (/\.3mf$/i.test(file.name)) { showError(t('err3mf')); return; }
  $('#dzError')?.remove();
  stopPlay();
  setLoading(true, 0);
  worker?.terminate();
  worker = new Worker('js/parser.worker.js');
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'progress') setLoading(true, m.value);
    else if (m.type === 'error') { showError(t('errParse') + m.message); worker.terminate(); }
    else if (m.type === 'done') {
      worker.terminate(); worker = null;
      const r = m.result;
      if (r.cutPos.length === 0 && r.rapidPos.length === 0) { showError(t('errEmpty')); return; }
      r.fileSize = file.size;
      onLoaded(r);
    }
  };
  worker.onerror = (e) => showError(t('errParse') + (e.message || 'worker error'));
  worker.postMessage({ file, name: file.name });
}

function onLoaded(r) {
  current = r;
  setLoading(false);
  $('#dropzone').hidden = true;
  $('#viewTools').hidden = false;
  $('#controls').hidden = false;
  $('#summary').hidden = false;
  viewer.load(r);
  const slider = $('#slider');
  slider.max = r.stepCut.length - 1;
  slider.value = slider.max;
  $('#onlyCurrentWrap').hidden = r.mode !== 'print';
  $('#onlyCurrent').checked = false;
  viewer.setOnlyCurrent(false);
  viewer.setShowRapids($('#rapidToggle').checked);
  $('#rapidLabel').textContent = t(r.mode === 'print' ? 'showTravel' : 'showRapids');
  $('#rapidLabel').dataset.i18n = r.mode === 'print' ? 'showTravel' : 'showRapids';
  renderLegend(r);
  renderSummary(r);
  updateLabel();
}

function renderLegend(r) {
  const el = $('#legend');
  el.hidden = false;
  el.innerHTML = r.mode === 'print'
    ? `<span><i style="background:#9fb9ca"></i>${lang === 'tr' ? 'Ekstrüzyon' : 'Extrusion'}</span><span><i style="background:#ff7a1a"></i>${lang === 'tr' ? 'Bu katman' : 'Current'}</span>`
    : `<span><i style="background:#4fc3f7"></i>G1/G2/G3</span><span><i style="background:#ff4d4f"></i>G0</span>`;
}

// ---------------------------------------------------------------- summary
const fmtNum = (v, d = 1) => v.toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 });
function fmtTime(s) {
  if (!(s > 0)) return '—';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}${lang === 'tr' ? 'sa' : 'h'} ${m}${lang === 'tr' ? 'dk' : 'm'}`;
  if (m) return `${m}${lang === 'tr' ? 'dk' : 'm'} ${sec}${lang === 'tr' ? 'sn' : 's'}`;
  return `${sec}${lang === 'tr' ? 'sn' : 's'}`;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderSummary(r) {
  const b = r.bounds;
  $('#fileName').textContent = r.name;
  $('#modePill').textContent = t(r.mode === 'print' ? 'modePrint' : 'modeCnc');
  $('#modePill').className = 'pill ' + r.mode;
  const rows = [];
  const tag = (k) => ` <small class="tag">${t(k)}</small>`;
  rows.push([t('sSize'), `${fmtNum(b.maxX - b.minX)} × ${fmtNum(b.maxY - b.minY)} × ${fmtNum(b.maxZ - b.minZ)} mm`]);
  const metaTime = r.meta.time;
  rows.push([t('sTime'), metaTime ? fmtTime(metaTime) + tag('fromFile') : fmtTime(r.estTime) + tag('rough')]);
  if (r.mode === 'print') {
    rows.push([t('sLayers'), fmtNum(r.layers, 0)]);
    let fil;
    if (r.meta.filamentMm || r.meta.filamentG) {
      const parts = [];
      if (r.meta.filamentMm) parts.push(`${fmtNum(r.meta.filamentMm / 1000, 2)} m`);
      if (r.meta.filamentG) parts.push(`${fmtNum(r.meta.filamentG, 1)} g`);
      fil = parts.join(' · ') + tag('fromFile');
    } else if (r.filamentMm > 0) {
      // 1.75 mm PLA: 2.405 mm² × 1.24 g/cm³
      const g = r.filamentMm * Math.PI * 0.875 * 0.875 * 1.24 / 1000;
      fil = `${fmtNum(r.filamentMm / 1000, 2)} m · ≈${fmtNum(g, 0)} g` + tag('rough');
    } else fil = '—';
    rows.push([t('sFilament'), fil]);
    if (r.meta.material) rows.push([t('sMaterial'), esc(r.meta.material)]);
    if (r.meta.slicer || r.meta.flavor) rows.push([t('sSlicer'), esc(r.meta.slicer || r.meta.flavor)]);
  } else {
    rows.push([t('sCutLen'), `${fmtNum(r.cutLen / 1000, 2)} m`]);
    rows.push([t('sRapidLen'), `${fmtNum(r.rapidLen / 1000, 2)} m`]);
    if (r.maxF > 0) rows.push([t('sFeed'), `${fmtNum(r.minF, 0)} – ${fmtNum(r.maxF, 0)} mm/min`]);
    if (r.tools.length) rows.push([t('sTools'), r.tools.map((x) => 'T' + x).join(', ')]);
    rows.push([t('sUnits'), t(r.inch ? 'unitsIn' : 'unitsMm')]);
  }
  rows.push([t('sLines'), fmtNum(r.lines, 0)]);
  rows.push([t('sMoves'), fmtNum(r.motionCount, 0)]);
  $('#stats').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  $('#estNote').textContent = t(r.mode === 'print' ? 'estNotePrint' : 'estNoteCnc');
}

function updateLabel() {
  const r = current;
  if (!r) return;
  const i = +$('#slider').value, n = r.stepCut.length;
  const z = r.stepPos[i * 3 + 2];
  if (r.mode === 'print') {
    $('#stepLabel').textContent = `${t('layer')} ${fmtNum(i + 1, 0)} ${t('of')} ${fmtNum(n, 0)} · Z ${fmtNum(layerZ(r, i), 2)} mm`;
  } else {
    const x = r.stepPos[i * 3], y = r.stepPos[i * 3 + 1];
    $('#stepLabel').textContent = `${t('move')} ${fmtNum(i + 1, 0)} ${t('of')} ${fmtNum(n, 0)} · ${t('line')} ${fmtNum(r.stepLine[i], 0)} · X${fmtNum(x, 3)} Y${fmtNum(y, 3)} Z${fmtNum(z, 3)}`;
  }
}
function layerZ(r, i) {
  // z of the last extrusion segment in this layer
  const end = r.stepCut[i];
  return end > 0 ? r.cutZ[end - 1] : 0;
}

// ---------------------------------------------------------------- controls
const slider = $('#slider');
slider.addEventListener('input', () => { viewer.setStep(+slider.value); updateLabel(); });
$('#rapidToggle').addEventListener('change', (e) => viewer.setShowRapids(e.target.checked));
$('#onlyCurrent').addEventListener('change', (e) => viewer.setOnlyCurrent(e.target.checked));
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => viewer.fit(b.dataset.view)));

const SPEEDS = [1, 4, 16, 64];
let speedIdx = 0, playing = false, playTimer = 0;
$('#speedBtn').addEventListener('click', () => {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  $('#speedBtn').textContent = SPEEDS[speedIdx] + '×';
});
function setPlayIcon() {
  $('#playIcon').innerHTML = playing
    ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/>'
    : '<path d="M7 5v14l12-7z" fill="currentColor"/>';
}
function stopPlay() { playing = false; cancelAnimationFrame(playTimer); setPlayIcon(); }
$('#playBtn').addEventListener('click', () => {
  if (!current) return;
  if (playing) { stopPlay(); return; }
  playing = true; setPlayIcon();
  const max = +slider.max;
  if (+slider.value >= max) slider.value = 0;
  // base rate: whole job in ~20 s for layers, ~60 s for CNC moves, at 1×
  const base = (max + 1) / (current.mode === 'print' ? 20 : 60);
  let last = performance.now(), acc = +slider.value;
  const tick = (now) => {
    if (!playing) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    acc += Math.max(base, 2) * SPEEDS[speedIdx] * dt;
    const v = Math.min(max, Math.floor(acc));
    if (v !== +slider.value) { slider.value = v; viewer.setStep(v); updateLabel(); }
    if (v >= max) { stopPlay(); return; }
    playTimer = requestAnimationFrame(tick);
  };
  playTimer = requestAnimationFrame(tick);
});
slider.addEventListener('pointerdown', stopPlay);

// ---------------------------------------------------------------- file input / DnD / samples
for (const id of ['#fileInput', '#fileInput2']) {
  $(id).addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
}
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const f = e.dataTransfer?.files?.[0];
  if (f) openFile(f);
});
document.querySelectorAll('[data-sample]').forEach((b) => b.addEventListener('click', async () => {
  setLoading(true);
  try {
    const res = await fetch(b.dataset.sample);
    if (!res.ok) throw new Error(res.status);
    const blob = await res.blob();
    openFile(new File([blob], b.dataset.sample.split('/').pop()));
  } catch (err) { showError(t('errParse') + err.message); }
}));

// ---------------------------------------------------------------- analytics (Cloudflare, cookie-free)
if (CFG.cfAnalyticsToken) {
  const s = document.createElement('script');
  s.defer = true;
  s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  s.dataset.cfBeacon = JSON.stringify({ token: CFG.cfAnalyticsToken });
  document.head.appendChild(s);
}

$('#year').textContent = new Date().getFullYear();
applyLang();
