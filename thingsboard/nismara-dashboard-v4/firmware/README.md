# NISMARA firmware — folder, cara flash, RPC

## 1. Struktur folder (3 device = 2 sketch)

```
firmware/
├── nismara_gwt/                  ← device 1: GWT (2 tank + rain tank + flow 1" + LCD 20x4)
│   ├── nismara_gwt.ino           (nama .ino HARUS sama dengan nama foldernya)
│   └── config.h                  (pin, WiFi, token, kalibrasi)
├── nismara_irrigation/           ← device 2 DAN 3: Garden Lt.1 & Garden Roof
│   ├── nismara_irrigation.ino    (sketch yang sama untuk kedua device)
│   └── config.h                  (pilih profil: PROFILE_GARDEN_LT1 atau PROFILE_GARDEN_ROOF)
├── SOIL_SENSOR.md                detail wiring, pemasangan & kalibrasi soil sensor
├── schematics/                   diagram wiring + pin config (+ soil_sensor_wiring.svg)
├── tests/                        uji logika di komputer (RPC, relay) — tanpa hardware
├── PINOUT.md
└── README.md
```

| Device | Folder sketch | Setting di `config.h` | Token TB |
|---|---|---|---|
| GWT (`nismara gwt`) | `nismara_gwt/` | — | token device GWT |
| Garden Lt.1 | `nismara_irrigation/` | `#define PROFILE_GARDEN_LT1` | token device Garden Lt.1 |
| Garden Roof | `nismara_irrigation/` | `#define PROFILE_GARDEN_ROOF` | token device Garden Roof |

Garden Lt.1 dan Garden Roof memakai **satu sketch**; bedanya hanya profil (jumlah zona & pin) dan token.
Flash dua kali: sekali dengan profil Lt.1 + token Lt.1, lalu ganti profil ke Roof + token Roof.

## 2. Cara flash (Arduino IDE)
1. Salin folder `nismara_gwt/` atau `nismara_irrigation/` **utuh** (berikut `config.h`) ke `Documents/Arduino/`.
2. Buka file `.ino` di dalamnya. Edit `config.h`: WiFi, host & token ThingsBoard, profil (irigasi), kalibrasi.
3. Board **ESP32 Dev Module**. Library: `PubSubClient`, `ArduinoJson` v7, `LiquidCrystal_I2C` (ketiga device).
4. Upload. Buka Serial Monitor 115200 untuk melihat pembacaan sensor.

## 3. RPC — ON/OFF relay (valve) dari ThingsBoard
Berlaku untuk device **irigasi** (Garden Lt.1 & Garden Roof); GWT tidak punya relay.
Device subscribe `v1/devices/me/rpc/request/+` dan membalas ke `.../response/<id>`.

| Method | Params | Fungsi / balasan |
|---|---|---|
| `setValve` (alias `setRelay`) | `{"zone":1,"state":true,"minutes":10}` | ON selama `minutes` (default 10, maks 60). `{"zone":1,"state":false}` = OFF. Balasan: status zona |
| `setValveN` (mis. `setValve2`) | `true` / `false` | ON/OFF zona N — untuk widget **Switch control** |
| `getValveN` (mis. `getValve1`) | – | balasan `true`/`false` — pasangan `setValveN` |
| `getValve` | `{"zone":1}` | status zona (objek JSON) |
| `setAuto` | `{"zone":1,"auto":true}` | mode AUTO / MANUAL |
| `setThresholds` | `{"zone":1,"start":30,"stop":55}` | ambang mulai/stop siram (0 ≤ start < stop ≤ 100) |
| `getState` | `{"zone":1}` atau kosong | status satu zona / semua zona |
| `closeAll` | – | tutup semua valve |

Contoh (ThingsBoard → Device → RPC / atau REST `POST /api/rpc/twoway/{deviceId}`):
```json
{"method":"setValve","params":{"zone":2,"state":true,"minutes":5}}
```
Keselamatan: valve **tidak pernah ON tanpa batas waktu** (ON tanpa `minutes` = `RPC_DEFAULT_MIN`), maksimal `MAX_MANUAL_MIN`,
di Lt.1 hanya satu valve aktif sekaligus (zona lain otomatis ditutup), dan perintah ditolak dengan `{"error":...}` bila parameter tidak valid.

**Widget Switch control** (satu per zona): *Target device* = device irigasi, *RPC set value method* = `setValve1`,
*RPC get value method* = `getValve1`, *Value type* = Boolean. Zona 2 → `setValve2` / `getValve2`.

## 3b. Peringatan saat compile (normal) & error umum
- `WARNING: library LiquidCrystal_I2C claims to run on all architecture(s)...` → **aman diabaikan** (metadata library, bukan error).
- `conflicting declaration 'const TankCfg T1'` / `'Reading' does not name a type` → sudah diperbaiki (v1.2 GWT): nama `T1/T2` bentrok dengan
  konstanta pin touch bawaan board ESP32, dan tipe harus didefinisikan sebelum fungsi pertama (aturan prototipe otomatis Arduino IDE).
  Jika Anda menambah kode: **jangan** memakai nama `T0–T9, A0–A19, SDA, SCL, SS, MOSI, MISO, SCK, TX, RX`, definisikan `struct` di atas
  fungsi pertama, dan jangan pakai default argument pada fungsi di `.ino`. `tests/run_host_tests.sh` memeriksa aturan ini otomatis.

## 4. Uji tanpa hardware
```bash
bash firmware/tests/run_host_tests.sh   # aturan Arduino IDE (prototipe otomatis, bentrok nama) + RPC, relay, batas waktu, LCD (Lt.1, Roof, GWT)
```
Ini menguji logika, bukan wiring/ADC/MQTT sungguhan — tetap uji di board.
