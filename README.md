# GcodeScope — web prototipi

NumericWorks'ün ücretsiz, tarayıcıda çalışan G-code görüntüleyicisi. Tamamen statik; GitHub Pages'e olduğu gibi konur. Build adımı yok.

**Gizlilik:** Dosya `File` API ile bir Web Worker'da okunur, hiçbir sunucuya gönderilmez. Three.js repoda (`vendor/`), CDN'e bağımlı değil.

## Özellikler
- `.gcode / .nc / .ngc / .tap / .gco / .h / .mpf / .spf / .eia / .min / .pim` sürükle-bırak veya dosya seç (Android'de uzantı filtresi dosyaları gizlediği için `accept` bilerek yok)
- 3D baskı / CNC otomatik algılama (G1 satırında `E` varsa baskı)
- G0/G1/G2/G3, I/J/K ve R yayları, G17/18/19 düzlemleri, G20/G21, G90/G91, M82/M83, G92, G28, basit delme çevrimleri (G81/82/83/73, G98/G99)
- Baskı: katman kaydırıcı, "yalnızca bu katman", yüksekliğe göre renk
- CNC: hareket hareket oynatma, takım konisi, satır no + koordinat
- Hızlı/boş hareket göster/gizle, 3D/XY/XZ görünümleri, oynat (1×/4×/16×/64×)
- Özet: boyut (baskıda 1. katmandaki purge/skirt hariç), süre ve filament (dosyada varsa dilimleyici değeri, yoksa "kaba" hesap), dilimleyici, malzeme, F aralığı, takımlar
- **Kontrol ünitesi tespiti (CNC):** HEIDENHAIN (Klartext / DIN-ISO), Siemens SINUMERIK, FANUC, Mazak, Mitsubishi, Kitamura, Okuma, Haas, Brother, Fagor, DN Solutions, Hurco, DMG MORI, LinuxCNC, Mach, GRBL. Özette marka + nesil/versiyon (ör. "iTNC 530 veya üstü · 2004+", "840D sl / 828D (Operate)", "Series 0i-MF · 2015+"), güven seviyesi (tespit / muhtemel / tahmin), neye bakılarak bulunduğu ve varsa CAM yazılımı gösterilir. İki kaynak birleştirilir: yalnızca o kontrolün anladığı sözdizimi (`BEGIN PGM`, `CYCLE81(`, `G15 H1`, `#MSG`, `G187`…) ve post-processor'ın başlık yorumlarına yazdığı makine/kontrol adı. Fanuc uyumlu ISO kontroller (Fanuc/Mitsubishi/Mazak EIA/Kitamura) sözdiziminden ayırt edilemediği için başlık yoksa "Fanuc uyumlu" denir; versiyon, o nesilde gelen özelliklerden (G05.1 Q1, G43.4, G68.2, PLANE SPATIAL, CYCLE832 `_ORI_`…) çıkarılır.
- **Hareket renkleri (CNC):** CAM simülatörlerinin ortak kuralına göre — hızlı (G0) kırmızı kesikli, kesme (G1/G2/G3) mavi, dalma turuncu, rampa/helis giriş sarı, ilerlemeyle geri çekme gri, giriş (lead-in) yeşil, çıkış (lead-out) mor. Giriş/çıkış önce takım telafisinden okunur (G41/G42 açıldığı hareket + ardından gelen teğet yay = giriş, G40 hareketi + öncesindeki teğet yay = çıkış); telafi yoksa malzemeye girişten hemen sonraki / çıkıştan hemen önceki kısa teğet yay (+ çizgi) aranır ve yalnızca kontur o noktada kapanıyorsa kabul edilir (köşe radyüsleri giriş sayılmaz). Lejant yalnızca dosyada bulunan hareket türlerini gösterir; alt satırda o anki hareketin türü yazar.
- **Delik çevrimleri (CNC):** G73/G74/G76/G81–G89 tam çevrim olarak işlenir (başlangıç seviyesi, R, G98/G99, G91 + K/L tekrar) ve her delik 3B yarı saydam gövde olarak çizilir: punta 90° konik havşa, matkap 118° uçlu silindir, gagalama (G83) ve talaş kırma (G73) her gaga derinliğinde halka, kılavuz (G84/G74, sol el) ve diş frezesi adımında helis çizgisi, bara/rayba düz tabanlı silindir. Aynı merkezli helisel yaylar (G2/G3 + Z) sonrasında takım dışarı çıkıyorsa **helisel delik frezeleme** (inen) veya **diş frezeleme** (çıkan ya da takım adı "THREAD/DİŞ" içeren) olarak tanınır; cebin helisel giriş rampası delik sayılmaz. Çap takım yorumlarından okunur (`D=10.`, `Ø8.5`, `DIA. - 10.`, `10MM`, `M10X1.5`); kılavuz adımı F/S (G94) veya F (G95) ile hesaplanır. Punta, takım adından (SPOT/CENTER/PUNTA…) ya da sığ derinlikten ayırt edilir. Özette delik tipleri ve ölçüleri (ör. "Kılavuz M10×1,5 ×2"), alt satırda o anki deliğin türü ve gaga sayısı gösterilir; "Delik gövdeleri" anahtarı gövdeleri gizler. Delik üstü ISO çevrimlerinde R düzlemidir (yüzey dosyada yazmaz).
- **Kontrol ünitesi dilleri (CNC):** tespit edilen lehçeye göre ayrıştırılır (`js/dialects.js`, `js/expr.js`):
  - **HEIDENHAIN Klartext** (TNC 426/430, iTNC 530, TNC 320/620/640, TNC7): `L`, `CC`/`C`, `CR`, `CT`, `LP`/`CP` (helis dahil), `RND`/`CHF` köşeleri, `APPR`/`DEP` giriş/çıkış, `RL`/`RR`/`R0`, `FMAX`, `TOOL CALL` (numara veya isim), `CYCL DEF 200–209, 240, 241, 262–265` ve eski `1, 2, 17, 18`, `CYCL DEF 7` sıfır kaydırma / `10` döndürme / `TRANS DATUM`, `PATTERN DEF` (POS, ROW, PAT, FRAME, CIRC, PITCHCIRC), `CYCL CALL`/`CYCL CALL PAT`/`CYCL CALL POS`/`M99`/`M89`, `LBL`/`CALL LBL … REP`, `Q` parametreleri, `FN 0–13` ve koşullu atlamalar.
  - **HEIDENHAIN DIN/ISO:** `%PGM G71 *`, mutlak `I/J` merkez, `G200`-serisi çevrimler + `Q` parametreleri, `G79`.
  - **Siemens SINUMERIK** (840D / 840D sl / 828D / ONE): `=AC()`/`=IC()`, `CR=`, `AR=`, `TURN=` (helis), `CIP`, `CT`, `G70/G71` inç/mm, `T="isim"`, `MCALL` + `CYCLE81–89`, `CYCLE840`, `CYCLE90`, konum desenleri `HOLES1/HOLES2/CYCLE801/CYCLE802`, `TRANS/ATRANS/ROT/AROT`, `R` parametreleri ve `DEF` değişkenleri, `IF…GOTOF/GOTOB`, `IF/ELSE/ENDIF`, `WHILE`, `FOR`, `REPEAT`, `G147/G148…` (SAR giriş/çıkış).
  - **Fanuc ailesi** (FANUC, Mazak EIA, Mitsubishi, Kitamura, Doosan, Brother…): makro B (`#` değişkenleri, `[ifade]`, `IF…GOTO`, `IF…THEN`, `WHILE…DO/END`), alt programlar `M98 P… L…` / `M99`, `G65` makro çağrısı (A–Z → #1–#26), `G52`, `G68/G69` döndürme.
  - **Haas:** `M97` yerel alt program, `G70/G71/G72` delik desenleri, `G12/G13` dairesel cep. **Fagor 8055/8060:** `G81–G86/G89/G69` (Z = referans düzlemi, I = derinlik, G83 I = adım · J = adet), `G87/G88` cep listelenir. **Okuma OSP:** `VC` değişkenleri, `G71` dönüş seviyesi, `NCYL`, `CALL O… Q…` / `RTS`, `IF […] N…`.
  - Çizilemeyenler (eğik düzlem `PLANE`/`CYCLE800`/`G68.2`, cep çevrimleri, FK serbest kontur, harici alt programlar…) özette **"Çizilmeyen"** satırında adetiyle listelenir. Sonsuz döngülere karşı 3 milyon satır / 32 çağrı derinliği sınırı var.
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
js/dialects.js          Heidenhain Klartext / DIN-ISO ve SINUMERIK çevirmenleri
js/expr.js              makro/parametre ifadeleri (#100, R1, Q1, VC1)
tests/                  node tests/run.js — ayrıştırıcı testleri (bağımlılık yok), fixtures/ örnek programlar
vendor/                 three.js r170 (MIT)
samples/                demo dosyalar: 3D baskı, CNC (Fanuc), HEIDENHAIN, SINUMERIK (tools/make_samples.py ile üretilir)
assets/icon.svg         geçici ikon — Canva logosuyla değiştirilecek
```

## Kapsam dışı (2. aşama)
5 eksen / eğik düzlem çizimi (PLANE, CYCLE800, G68.2, TCPM), cep ve kanal çevrimleri (CYCL DEF 25x, POCKET, G150), FK serbest kontur, MAZATROL konuşmalı (ikili) programlar, torna çevrimleri, `,R`/`,C` köşe yuvarlatma, `.gcode.3mf` / Bambu çok plakalı, kod satırı ↔ takım yolu senkronu, çevrimdışı PWA.
