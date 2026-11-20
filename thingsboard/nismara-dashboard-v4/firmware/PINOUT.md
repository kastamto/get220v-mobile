# NISMARA — Pin config & wiring

Semua pin bisa diubah di `config.h` masing-masing sketch. Board: ESP32 DevKit (30/38 pin).

## 1. nismara_gwt  (GWT 2 tank + rain tank + flow 1")

| Fungsi | GPIO | Arah | Catatan |
|---|---|---|---|
| LCD 16x2 I2C SDA | 21 | I2C | alamat 0x27 (atau 0x3F) |
| LCD 16x2 I2C SCL | 22 | I2C | |
| GWT T1 HC-SR04 TRIG | 26 | out | |
| GWT T1 HC-SR04 ECHO | 27 | in | **pembagi tegangan** |
| GWT T2 HC-SR04 TRIG | 32 | out | |
| GWT T2 HC-SR04 ECHO | 33 | in | **pembagi tegangan** |
| Rain tank HC-SR04 TRIG | 18 | out | |
| Rain tank HC-SR04 ECHO | 19 | in | **pembagi tegangan** |
| Flow sensor 1" (signal) | 4 | in, pull-up, interrupt | kabel merah 5–24V sesuai sensor, hitam GND |
| Status LED | 2 | out | cepat = WiFi putus, sedang = TB putus, lambat = OK |

HC-SR04 dicatu **5V**. ECHO mengeluarkan 5V, ESP32 hanya toleran 3.3V:

```
HC-SR04 ECHO ──[1 kΩ]──┬──► GPIO ESP32
                       └──[2 kΩ]──► GND
```
Pastikan jarak sensor ke permukaan air ≥ 20 cm (blind zone). `dist_cm = -1` di telemetry = sensor tidak terbaca.

## 2. nismara_irrigation — profil Garden Lt.1 (2 zone)

| Fungsi | GPIO | Catatan |
|---|---|---|
| Z1 soil sensor 1 (AOUT) | 34 | ADC1, input only |
| Z1 soil sensor 2 | 35 | ADC1, input only |
| Z2 soil sensor 1 | 32 | ADC1 |
| Z2 soil sensor 2 | 33 | ADC1 |
| Z1 relay (solenoid 1) | 26 | modul relay IN1 |
| Z2 relay (solenoid 2) | 27 | modul relay IN2 |
| Z1 tombol manual | 13 | ke GND, pull-up internal |
| Z2 tombol manual | 14 | ke GND, pull-up internal |
| Status LED | 2 | onboard |

## 3. nismara_irrigation — profil Garden Roof (1 zone)

| Fungsi | GPIO | Catatan |
|---|---|---|
| Z1 soil sensor 1 / 2 | 34 / 35 | ADC1 |
| Z1 relay (solenoid) | 26 | modul relay IN1 |
| Z1 tombol manual | 13 | ke GND |
| Status LED | 2 | onboard |

## 4. Wiring daya (irigasi)

```
Adaptor 12/24V ──┬─► relay COM ─► relay NO ─► solenoid (+) ─┐
                 │                         solenoid (−) ──────┴─► adaptor (−)
                 └─ dioda flyback 1N4007 PARALEL solenoid (katoda ke +)
5V (buck/USB) ──► ESP32 VIN, VCC modul relay (JD-VCC dilepas bila opto-isolasi dipakai terpisah)
GND semua catu daya DISATUKAN
Soil capacitive: VCC 3.3V · GND · AOUT → GPIO ADC1
```

Catatan:
- Pakai pin **ADC1** (32–39) untuk soil sensor; ADC2 tidak bisa dibaca saat WiFi aktif.
- Hindari GPIO 0, 2 (selain LED), 12, 15 untuk relay/tombol — strapping pins.
- Modul relay `active-low` (umum): `RELAY_ACTIVE_LOW 1`. Set 0 jika relay menyala saat boot.
- Kalibrasi soil: baca `raw` di udara → `SOIL_RAW_DRY`, di air → `SOIL_RAW_WET`.

## 5. Library & board

Arduino IDE → board **ESP32 Dev Module** (core 2.0.x atau 3.x).
Library: `PubSubClient`, `ArduinoJson` v7, `LiquidCrystal_I2C` (hanya GWT).
Sketch sudah lolos cek sintaks kedua profil; uji di hardware tetap perlu dilakukan.
