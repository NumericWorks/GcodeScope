# GcodeScope — web prototipi

NumericWorks'ün ücretsiz, tarayıcıda çalışan G-code görüntüleyicisi. Tamamen statik; GitHub Pages'e olduğu gibi konur. Build adımı yok.

**Gizlilik:** Dosya `File` API ile bir Web Worker'da okunur, hiçbir sunucuya gönderilmez. Three.js repoda (`vendor/`), CDN'e bağımlı değil.

## Özellikler
- `.gcode / .nc / .ngc / .tap / .gco` sürükle-bırak veya dosya seç (Android'de uzantı filtresi dosyaları gizlediği için `accept` bilerek yok)
- 3D baskı / CNC otomatik algılama (G1 satırında `E` varsa baskı)
- G0/G1/G2/G3, I/J/K ve R yayları, G17/18/19 düzlemleri, G20/G21, G90/G91, M82/M83, G92, G28, basit delme çevrimleri (G81/82/83/73, G98/G99)
- Baskı: katman kaydırıcı, "yalnızca bu katman", yüksekliğe göre renk
- CNC: hareket hareket oynatma, takım konisi, satır no + koordinat
- Hızlı/boş hareket göster/gizle, 3D/XY/XZ görünümleri, oynat (1×/4×/16×/64×)
- Özet: boyut (baskıda 1. katmandaki purge/skirt hariç), süre ve filament (dosyada varsa dilimleyici değeri, yoksa "kaba" hesap), dilimleyici, malzeme, F aralığı, takımlar
- **Kontrol ünitesi tespiti (CNC):** HEIDENHAIN (Klartext / DIN-ISO), Siemens SINUMERIK, FANUC, Mazak, Mitsubishi, Kitamura, Okuma, Haas, Brother, Fagor, DN Solutions, Hurco, DMG MORI, LinuxCNC, Mach, GRBL. Özette marka + nesil/versiyon (ör. "iTNC 530 veya üstü · 2004+", "840D sl / 828D (Operate)", "Series 0i-MF · 2015+"), güven seviyesi (tespit / muhtemel / tahmin), neye bakılarak bulunduğu ve varsa CAM yazılımı gösterilir. İki kaynak birleştirilir: yalnızca o kontrolün anladığı sözdizimi (`BEGIN PGM`, `CYCLE81(`, `G15 H1`, `#MSG`, `G187`…) ve post-processor'ın başlık yorumlarına yazdığı makine/kontrol adı. Fanuc uyumlu ISO kontroller (Fanuc/Mitsubishi/Mazak EIA/Kitamura) sözdiziminden ayırt edilemediği için başlık yoksa "Fanuc uyumlu" denir; versiyon, o nesilde gelen özelliklerden (G05.1 Q1, G43.4, G68.2, PLANE SPATIAL, CYCLE832 `_ORI_`…) çıkarılır.
- İki dil, iki ayrı statik sayfa: `/` (EN) ve `/tr/` (TR). EN | TR seçici bu sayfalara link verir; TR'yi seçen ziyaretçi kök sayfaya döndüğünde `/tr/`'ye yönlendirilir

## Yapılandırma (`index.html` en altı)
```js
window.GS_CONFIG = {
  cfAnalyticsToken: ''   // Cloudflare Web Analytics token
};
```
- **Cloudflare Web Analytics:** token girilirse beacon yüklenir (çerezsiz, onay çubuğu gerekmez). Paneldeki site: `numericworks.github.io`. Özel olay saymaz; sadece sayfa görüntülemesi.
- E-posta toplama yok; üst barda ve sayfada "iOS · Android — yakında" rozeti var.

## SEO
- `index.html` ve `tr/index.html` birbirini `hreflang` ile gösterir; canonical, Open Graph/Twitter etiketleri ve JSON-LD (`WebApplication` + `FAQPage`) içerir.
- **`tr/index.html` elle düzenlenmez:** `index.html` ya da `js/app.js` içindeki TR metinleri değişince `python3 tools/make_tr_page.py` çalıştırılır.
- `sitemap.xml` → Google Search Console ve Bing Webmaster Tools'a `https://numericworks.github.io/GcodeScope/sitemap.xml` olarak gönderilir. (`robots.txt` yalnızca alan adının kökünde geçerli olduğu için bu repoda yok.)
- `assets/og-image.png` (1200×630) paylaşım önizlemesidir.
- Kendi alan adına geçilirse `https://numericworks.github.io/GcodeScope/` adresini `index.html`, `tools/make_tr_page.py` ve `sitemap.xml` içinde değiştirin.

## Test
```sh
node tests/run.js
```

## Yerelde çalıştırma
Module worker ve import map `file://` üzerinden çalışmaz, küçük bir sunucu gerekir:
```sh
npx http-server -p 8080   # veya: python3 -m http.server 8080
```

## Dosyalar
```
index.html              sayfa + config (EN)
tr/index.html           TR sayfası (tools/make_tr_page.py üretir)
sitemap.xml             arama motorları için site haritası
css/style.css           arayüz (mobil öncelikli)
js/app.js               arayüz mantığı, i18n, analitik
js/viewer.js            Three.js sahnesi (drawRange ile katman/ilerleme)
js/parser.worker.js     G-code ayrıştırıcı (Web Worker)
js/controller.js        kontrol ünitesi / versiyon tespiti (worker'a importScripts ile yüklenir)
tests/                  node tests/run.js — ayrıştırıcı testleri (bağımlılık yok), fixtures/ örnek programlar
vendor/                 three.js r170 (MIT)
samples/                demo dosyalar (tools/make_samples.py ile üretilir)
assets/icon.svg         geçici ikon — Canva logosuyla değiştirilecek
```

## Kapsam dışı (2. aşama)
FANUC/HAAS lehçeleri (makrolar, alt programlar, G68 vb.), `.gcode.3mf` / Bambu çok plakalı, kod satırı ↔ takım yolu senkronu, çevrimdışı PWA.
