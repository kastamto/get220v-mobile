# Soil sensor — detail wiring & kalibrasi

Diagram: `schematics/soil_sensor_wiring.svg` (juga ada di `schematics/schematics.html`).
Sensor: **Capacitive Soil Moisture Sensor v1.2** (3 pin). Jangan pakai sensor resistif (2 probe logam) — korosi dalam hitungan minggu.

## 1. Pin sensor → ESP32

| Pin sensor | Warna kabel | Ke ESP32 | Catatan |
|---|---|---|---|
| VCC | merah | **3V3** | 3,3 V (spek sensor 3,3–5,5 V, keluaran AOUT 0–3,0 V). 3,3 V dipilih karena aman untuk ADC ESP32. Jika memakai 5V atau sensor tiruan: **ukur AOUT dengan multimeter dulu** (harus ≤ 3,3 V), dan kalibrasi ulang — nilai `raw` berubah mengikuti tegangan catu |
| GND | hitam | GND | semua GND disatukan |
| AOUT | kuning | GPIO ADC1 | + kapasitor 100 nF AOUT–GND di sisi ESP32 |

Urutan pin di PCB v1.2: **GND – VCC – AOUT** (cek silkscreen, varian lain bisa berbeda).

## 2. Pin per device (sesuai `config.h`)

| Device | Zona | Sensor | GPIO |
|---|---|---|---|
| Garden Lt.1 | Z1 | S1 / S2 | 34 / 35 |
| Garden Lt.1 | Z2 | S1 / S2 | 32 / 33 |
| Garden Roof | Z1 | S1 / S2 | 34 / 35 |

Hanya **ADC1** (GPIO32–39): ADC2 tidak bisa dibaca saat WiFi aktif. GPIO34/35 input-only — aman untuk ADC.
Catu: 4 sensor ± 20 mA dari pin 3V3 ESP32 (aman). Lebih dari ±6 sensor → regulator 3,3 V terpisah, GND disatukan.

## 3. Kabel & pemasangan
- Kabel 3-core 0,22–0,5 mm² (kabel sensor/CCTV). ≤ 5 m kabel biasa; 5–15 m **shielded**, shield ke GND di sisi ESP32 saja.
- Jangan satu jalur dengan kabel solenoid 12/24 V (induksi membuat bacaan loncat).
- Sambungan: solder + heat-shrink berperekat atau terminal di junction box IP65. **Segel** konektor dan tepi atas PCB (epoxy/hot-glue/cat kedap) — bagian ini yang paling sering rusak oleh air.
- Beri *drip loop* (kabel melengkung ke bawah sebelum naik) agar air tidak merambat ke konektor.
- Pasang tegak lurus, kedalaman 5–10 cm (zona akar), **jangan melewati garis MAX** di PCB. Padatkan tanah di sekitar probe tanpa celah udara.
- 2 sensor per zona di titik berbeda (±1/3 dan 2/3 lebar bedeng), jauh dari tetesan/sprinkler langsung.

## 4. Kalibrasi (wajib, sekali per jenis sensor/tanah)
1. Di `nismara_irrigation/config.h` set `#define SOIL_CAL_MODE 1`, upload, buka Serial Monitor **115200**.
   Sketch hanya mencetak nilai mentah tiap 0,5 detik (valve tidak pernah dinyalakan, WiFi tidak dipakai):
   ```
   Z1-S1 GPIO34 raw=3187  ->   1%
   ```
2. Sensor **di udara** (kering, bersih) → catat `raw` stabil → `SOIL_RAW_DRY` (tipikal 2800–3300).
3. Sensor **dicelup air sampai garis MAX** → catat `raw` → `SOIL_RAW_WET` (tipikal 1200–1600).
4. Isi kedua nilai di `config.h`, set `SOIL_CAL_MODE` kembali **0**, upload ulang.
5. Cek di tanah asli: tanah kering ≈ 10–30 %, lembap ≈ 40–60 %, basah kuyup ≈ 80–100 %. Sesuaikan `start/stop` dari dashboard bila perlu.

Bacaan di luar rentang 300–4000 dianggap **sensor error** (kabel lepas/korslet) → dashboard menampilkan "ERR", zona tetap bekerja dengan sensor yang tersisa, dan valve ditutup bila kedua sensor zona error.

## 5. Diagnosa cepat (nilai `raw`)
| Gejala | Kemungkinan penyebab |
|---|---|
| `raw` ≈ 0 atau < 300 | AOUT lepas/short ke GND, atau sensor mati |
| `raw` ≈ 4095 atau > 4000 | AOUT mengambang (kabel putus), VCC tidak tersambung |
| `raw` loncat-loncat ±200 | kabel panjang tanpa shield / dekat kabel solenoid / belum ada 100 nF / GND longgar |
| `raw` tidak berubah di air | sensor tersambung ke 5V/pin salah, PCB rusak karena air masuk |
| Dua sensor 1 zona selisih besar | posisi berbeda (tanah tidak merata) atau salah satu belum dikalibrasi |
