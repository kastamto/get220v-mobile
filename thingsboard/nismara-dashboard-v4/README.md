# NISMARA Water & Irrigation — dashboard v4

```
widget.html / widget.js     sumber widget (bisa di-paste manual ke tab HTML / JS widget Time series)
build_bundle.js             node build_bundle.js  ->  nismara_water_bundle.json
nismara_water_bundle.json   WIDGETS BUNDLE (import ke ThingsBoard)
firmware/PINOUT.md           tabel pin, wiring, kalibrasi
firmware/nismara_gwt/        ESP32 GWT: 2 tank + rain tank + flow 1"   (config.h = semua pin & WiFi/token)
firmware/nismara_irrigation/ ESP32 irigasi: profil Garden Lt.1 (2 zone) / Garden Roof (1 zone)  (config.h)
preview.html                 preview standalone dengan data simulasi (node build_preview.js)
```

## Import
Widgets Library → Widgets bundles → Import → `nismara_water_bundle.json`
Berisi 3 widget: **Water System Overview** (semua tab), **Water System**, **Smart Irrigation**.
Setelah `widget.html/js` diubah, jalankan `node build_bundle.js` lagi.

## Datasource
Assign device ke widget (urutan bebas, routing otomatis berdasarkan key):
GWT, Transfer flow, Roof tank, Garden Lt.1 (nama TANPA "roof"), Garden Roof (nama mengandung "roof"/"atap").
Tambahkan data key sesuai header `widget.html`. Time window ≥ 24 jam.

## Kontrol irigasi
Tombol AUTO/MANUAL, Open 5/10/15m, Stop, dan threshold menulis **shared attribute** device
(`zN_cmd`, `zN_auto`, `zN_start_pct`, `zN_stop_pct`). Firmware membacanya, jadi user dashboard
butuh hak tulis atribut. Matikan dengan setting `irrigControl = false`.
