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
- EN/TR arayüz (tarayıcı diline göre, elle değiştirilebilir)

## Yapılandırma (`index.html` en altı)
```js
window.GS_CONFIG = {
  formEndpoint: '',      // ör. https://formspree.io/f/xxxxxx
  cfAnalyticsToken: ''   // Cloudflare Web Analytics token
};
```
- **E-posta formu:** `email`, `use` (3d-printer/cnc/both), `platform` (android/ios), `lang`, `lastFileType` alanlarını FormData olarak POST eder, `Accept: application/json` başlığıyla. Formspree ücretsiz planıyla doğrudan uyumlu. `_gotcha` bot tuzağı alanı var.
- **Analitik:** token girilirse Cloudflare beacon'ı yüklenir (çerezsiz). Not: CF Web Analytics özel olay (ör. "dosya açıldı") saymaz; sadece sayfa görüntülemesi.

## Yerelde çalıştırma
Module worker ve import map `file://` üzerinden çalışmaz, küçük bir sunucu gerekir:
```sh
npx http-server -p 8080   # veya: python3 -m http.server 8080
```

## Dosyalar
```
index.html              sayfa + config
css/style.css           arayüz (mobil öncelikli)
js/app.js               arayüz mantığı, i18n, form, analitik
js/viewer.js            Three.js sahnesi (drawRange ile katman/ilerleme)
js/parser.worker.js     G-code ayrıştırıcı (Web Worker)
vendor/                 three.js r170 (MIT)
samples/                demo dosyalar (tools/make_samples.py ile üretilir)
assets/icon.svg         geçici ikon — Canva logosuyla değiştirilecek
```

## Kapsam dışı (2. aşama)
FANUC/HAAS lehçeleri (makrolar, alt programlar, G68 vb.), `.gcode.3mf` / Bambu çok plakalı, kod satırı ↔ takım yolu senkronu, çevrimdışı PWA.
