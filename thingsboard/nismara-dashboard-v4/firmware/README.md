# NISMARA firmware — folder, cara flash, RPC

## 1. Struktur folder — FLASH DARI `ready_to_flash/`

```
firmware/
├── ready_to_flash/                 ← 3 FOLDER SIAP FLASH (satu per device) — pakai ini
│   ├── nismara_gwt/                    device GWT              (.ino + config.h)
│   ├── nismara_garden_lt1/             device Garden Lt.1      (.ino + config.h, PROFILE_GARDEN_LT1 sudah aktif)
│   └── nismara_garden_roof/            device Garden Roof      (.ino + config.h, PROFILE_GARDEN_ROOF sudah aktif)
├── nismara_gwt/                    ← SUMBER GWT        (edit di sini)
├── nismara_irrigation/             ← SUMBER IRIGASI    (satu kode untuk Lt.1 & Roof, edit di sini)
├── make_ready_to_flash.py          ← menyalin sumber → ready_to_flash/ (dengan profil & token placeholder per device)
├── schematics/   tests/   PINOUT.md   SOIL_SENSOR.md   README.md
```

| Device | Folder untuk di-flash | Yang diisi di `config.h` |
|---|---|---|
| GWT (`nismara gwt`) | `ready_to_flash/nismara_gwt/` | WiFi, `TB_TOKEN`, geometri tangki |
| Garden Lt.1 | `ready_to_flash/nismara_garden_lt1/` | WiFi, `TB_TOKEN` (placeholder `TOKEN_GARDEN_LT1`) |
| Garden Roof | `ready_to_flash/nismara_garden_roof/` | WiFi, `TB_TOKEN` (placeholder `TOKEN_GARDEN_ROOF`) |

**Kenapa ada sumber + hasil generate?** Logika irigasi (auto, RPC, LCD, keselamatan) hanya ditulis **sekali** di `nismara_irrigation/`.
Folder `ready_to_flash/` hanyalah salinan per device yang dibuat otomatis, sehingga Lt.1 dan Roof tidak pernah berbeda versi.
Jangan edit `ready_to_flash/` langsung. Setelah mengubah sumber: `python3 -I firmware/make_ready_to_flash.py`
(`tests/run_host_tests.sh` akan gagal bila `ready_to_flash/` belum disinkronkan).

## 2. Cara flash (Arduino IDE)
1. Salin **satu** folder dari `ready_to_flash/` (mis. `nismara_garden_lt1`) utuh ke `Documents/Arduino/`
   (`.ino` dan `config.h` harus satu folder; nama `.ino` = nama folder).
2. Buka `.ino` di dalamnya. Edit `config.h`: WiFi, host & **token ThingsBoard device itu**, kalibrasi.
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
