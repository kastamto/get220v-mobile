# Get220v Water Monitor — Dashboard ThingsBoard

Dashboard ThingsBoard untuk device air Get220v. Dashboard ini hanya memakai telemetry
aktif device (`flow_*`, `tank_*`, `pump_*`, `alarm_level_*`, `rssi`, `evt`, `secs_today`, `uptime_s`).

| Tab | Isi |
|---|---|
| **Alert** | Alert aktif (kritis / peringatan / info), alarm server ThingsBoard (Ack/Clear), notifikasi browser, riwayat alert |
| **Live** | Pemakaian hari ini vs baseline (+ proyeksi akhir hari), biaya hari ini & per kamar, L/kamar, flow, tangki, pompa, grafik 24 jam level & flow |
| **Pemakaian harian** | Tabel 7/14/30 hari: kamar terisi (bisa diedit per hari), liter, L/kamar, biaya, biaya/kamar, % baseline, runtime pompa; grafik L/kamar vs baseline; ekspor CSV |
| **Setup** | Jumlah kamar & kamar terisi, tarif air (Rp/m³), baseline biaya air (Rp/kamar/hari), ambang alert lain |
| **Kalibrasi flow** | Uji ember, perbandingan meter PDAM, set/reset faktor manual, riwayat kalibrasi |

## Cara pasang (ThingsBoard 3.6+ / 4.x) — 3 file

Widget terdiri dari 3 file di `src/`: `widget.html`, `widget.css`, `widget.js`.

1. **Widget library → Widgets → + → Create new widget → Static widget**.
2. Di editor widget:
   - tab **HTML**: hapus isinya, paste `widget.html`
   - tab **CSS**: hapus isinya, paste `widget.css`
   - tab **JavaScript**: hapus seluruh isinya, paste `widget.js`
3. Klik **Run** untuk pratinjau, lalu **Save** dengan nama mis. `Get220v Water Monitor`.
4. Buka/buat dashboard → **Edit → + Add widget** → cari `Get220v Water Monitor` → **Add**.
   Perbesar widget (mis. selebar dashboard, tinggi ±14 baris) lalu simpan dashboard.
5. Di widget: pilih device dari dropdown, buka tab **Setup**, isi kamar, tarif dan baseline → **Simpan setup**.

Tidak perlu entity alias, datasource atau data key. Dropdown hanya berisi device yang
mengirim telemetry aktif `flow_total_l` dan `tank_level_pct`. Jika tidak ada device seperti itu,
semua device ditampilkan dengan pemberitahuan. Device yang dipilih dan tab terakhir diingat
per browser.

Untuk customer user: device harus di-assign ke customer tersebut agar muncul di dropdown.
Agar Setup, okupansi dan kalibrasi bisa disimpan, akun butuh izin menulis atribut device
(tenant admin, atau customer user pemilik device).

## Rumus

- Baseline L/kamar/hari = baseline biaya (Rp/kamar/hari) ÷ tarif (Rp/m³) × 1000
- Baseline hari ini = baseline L/kamar/hari × kamar terisi hari ini
- Pemakaian = `flow_today_l` × faktor kalibrasi (riwayat: nilai MAX per hari)
- Biaya = pemakaian ÷ 1000 × tarif; biaya/kamar = biaya ÷ kamar terisi hari itu
- Status: **Normal** < ambang peringatan (default 80%) ≤ **Peringatan** < 100% ≤ **Kritis**
- Faktor kalibrasi = volume aktual ÷ volume terukur sensor (mentah)

## Alert yang dihitung di dashboard

| Alert | Level | Kondisi |
|---|---|---|
| Pemakaian melebihi baseline | Kritis | pemakaian hari ini ≥ 100% baseline |
| Pemakaian mendekati baseline | Peringatan | ≥ ambang peringatan |
| Proyeksi melebihi baseline | Peringatan | laju hari ini (setelah 3 jam) diproyeksikan > baseline |
| Level tangki rendah | Kritis | `tank_level_pct` < batas, atau `alarm_level_low` = 1 |
| Level tangki tinggi / overflow | Peringatan | `tank_level_pct` > batas, atau `alarm_level_high` = 1 |
| Aliran terus-menerus (bocor) | Kritis | `flow_lpm` > 0 tanpa henti ≥ N menit |
| Pompa menyala terlalu lama | Peringatan | `pump_session_s` > batas |
| Pompa terlalu sering start | Peringatan | `pump_starts_today` > batas |
| Device offline | Kritis | tidak ada telemetry > N menit |
| Sinyal lemah / event device / setup belum lengkap | Info | `rssi`, `evt`, setup kosong |

Alert ini hanya berjalan saat dashboard terbuka. Untuk alarm yang tetap jalan saat dashboard
tertutup (dan push notification ke aplikasi Get220v), buat alarm rule di server:

## Alarm server (opsional, disarankan)

Setiap kali setup/okupansi/kalibrasi disimpan, dashboard juga menulis atribut server turunan:

| Atribut | Arti |
|---|---|
| `wm_baseline_day_raw_l` | baseline hari ini dalam satuan **mentah** sensor (sudah dibagi faktor kalibrasi) |
| `wm_warn_day_raw_l` | ambang peringatan, satuan mentah |
| `wm_baseline_day_l`, `wm_baseline_room_l`, `wm_occ_today` | baseline terkalibrasi, per kamar, kamar terisi hari ini |
| `wm_tank_low_pct` | batas level tangki rendah |

Di **Device profiles → (profile device air) → Alarm rules**, tambahkan:

1. **Pemakaian melebihi baseline**: severity *Critical*, kondisi `flow_today_l` (Time series) *greater than*
   nilai dinamis → *Current device* → atribut `wm_baseline_day_raw_l`.
   Clear condition: `flow_today_l` *less or equal* `wm_baseline_day_raw_l` (otomatis clear saat counter reset tengah malam).
2. **Pemakaian mendekati baseline**: severity *Warning*, `flow_today_l` > `wm_warn_day_raw_l`.
3. **Level tangki rendah**: severity *Critical*, `tank_level_pct` < atribut `wm_tank_low_pct`.

Lalu di **Notification center → Rules** buat rule trigger *Alarm* untuk mengirim notifikasi
(mobile app / email). Alarm ini juga muncul di panel Alert dashboard.

Catatan: kamar terisi di-update manual (Setup atau kolom tabel). Bila tidak diisi untuk suatu hari,
dipakai nilai "Kamar terisi hari ini" terakhir (ditampilkan abu-abu miring di tabel).

## Atribut konfigurasi (SERVER_SCOPE)

`wm_rooms_total`, `wm_rooms_occupied`, `wm_occ_log` (JSON tanggal → kamar terisi), `wm_tariff_m3`,
`wm_baseline_cost_room_day`, `wm_warn_pct`, `wm_tank_low_pct`, `wm_tank_high_pct`, `wm_leak_min`,
`wm_pump_max_min`, `wm_pump_starts_max`, `wm_offline_min`, `wm_rssi_min`, `wm_cal_factor`,
`wm_cal_log` (JSON 10 kalibrasi terakhir).

Kalibrasi diterapkan di dashboard/threshold, **tidak** mengubah firmware. Jika nanti faktor
kalibrasi ditanam di firmware (K-factor pulsa/liter), reset faktor di dashboard ke 1.

## Pengembangan

Ubah file di `src/`, lalu uji di Chromium (butuh playwright); screenshot disimpan di `test/out/`:

```bash
node thingsboard/water-monitor/test/smoke.js
```
