# NISMARA Water & Irrigation — dashboard v5 (redesign)

```
widget.html / widget.js     sumber widget (bisa di-paste manual ke tab HTML / JS widget Time series)
build_bundle.js             node build_bundle.js  ->  nismara_water_bundle.json
build_dashboard.js          node build_dashboard.js  ->  nismara_dashboard.json + nismara_irrigation_dashboard.json
nismara_water_bundle.json   WIDGETS BUNDLE (import ke ThingsBoard)
firmware/PINOUT.md           tabel pin, wiring, kalibrasi
firmware/nismara_gwt/        ESP32 GWT: 2 tank + rain tank + flow 1"   (config.h = semua pin & WiFi/token)
firmware/nismara_irrigation/ ESP32 irigasi: profil Garden Lt.1 (2 zone) / Garden Roof (1 zone)  (config.h)
preview.html                 preview standalone dengan data simulasi (node build_preview.js)
```

## Import (2 langkah)
1. **Widgets bundle dulu**: Widgets Library → Widgets bundles → Import → `nismara_water_bundle.json`
2. **Dashboard**: Dashboards → Import → `nismara_dashboard.json` (lengkap, semua tab)
   atau `nismara_irrigation_dashboard.json` (khusus irigasi, cocok untuk HP).

Dashboard memakai 1 entity alias **"NISMARA Devices"** = semua device bertipe DEVICE yang namanya diawali `nismara`
(mis. `nismara gwt`, `nismara flow`, `nismara roof`, `nismara garden lt1`, `nismara garden roof`).
Jika nama device Anda berbeda: Dashboard → Edit → Entity aliases → ubah *name filter*, atau jalankan
`NAME_PREFIX=awalan node build_dashboard.js` lalu import ulang.
Garden Roof harus punya kata "roof"/"atap" di namanya; Garden Lt.1 tidak boleh.

### Jika muncul "Problem loading widget configuration"
Artinya dashboard tidak menemukan tipe widget. Cek: (1) bundle sudah di-import lebih dulu; (2) di Widgets Library, bundle
**NISMARA Water & Irrigation** berisi 3 widget; (3) jika bundle Anda ter-import sebagai *system* (bukan tenant),
buat ulang dashboard dengan `WIDGET_SCOPE=system node build_dashboard.js`. Cara paling aman: di dashboard klik
widget → Edit → hapus lalu **Add widget** dari bundle NISMARA, kemudian set datasource ke alias "NISMARA Devices".

## Import widget saja
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
