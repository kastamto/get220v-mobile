# get220v-building-gateway

Satu pintu integrasi untuk **aplikasi luar** (app Rukita, BMS vendor, portal klien, Power BI,
n8n/Zapier, dll) ke ThingsBoard `iot.get220v.com`, **dibatasi per building**.

App luar tidak perlu tahu cara kerja TB (JWT, entity query, format WS). Cukup pakai API key,
lalu pilih protokol yang cocok:

| Kebutuhan app luar | Protokol | Endpoint |
|---|---|---|
| Ambil data / daftar device | **REST JSON** (OpenAPI 3) | `GET /v1/buildings/...` |
| Data realtime (live) | **SSE** (Server-Sent Events, HTTP biasa) | `GET /v1/buildings/{id}/stream` |
| Dikirimi data/alarm tanpa polling | **Webhook** (HTTP POST + HMAC) | konfigurasi di `clients.json` |
| Kontrol device | **REST → RPC TB** | `POST .../devices/{id}/rpc` |
| Tampilkan dashboard TB | **iframe / WebView** (link sekali pakai) | `POST .../dashboards/{id}/embed` |
| Generate SDK (TS, Python, Java, Dart, …) | **OpenAPI** | `GET /openapi.yaml` |

Node ≥ 22, **tanpa dependency**. Port default `3011`, nginx `/building-api/`.

## Model building di ThingsBoard

Pakai fitur bawaan TB, tanpa database tambahan:

```
Asset type "building"  (mis. "Rukita Amani")
 ├─ Contains → Asset "Lantai 1"            (opsional, boleh bertingkat sampai 5 level)
 │    └─ Contains → Device "Pompa A"
 └─ Contains → Device "Sensor Gerbang Amani"

Server attribute building:  dashboards = [{"id":"<dashUuid>","stateId":"default"}]
```

- Device yang **tidak** ada di bawah building tidak bisa diakses lewat building itu, walau
  ID-nya ditebak (dicek ke topologi, bukan sekadar UUID valid).
- Rename device di TB aman, karena relasi memakai ID.
- Nama type & relasi bisa diubah lewat `.env` (`BUILDING_ASSET_TYPE`, `BUILDING_RELATION_TYPE`)
  kalau di TB sudah ada konvensi lain.

### Setup data building (helper)

```bash
npm run setup -- list                                   # building yang ada + jumlah device
npm run setup -- create --name "Rukita Amani" --apply
npm run setup -- link --building "Rukita Amani" --match "Amani"          # DRY-RUN dulu
npm run setup -- link --building "Rukita Amani" --match "Amani" --apply  # tulis relasi
npm run setup -- dashboards --building "Rukita Amani" --set <dashUuid> --apply
npm run setup -- show --building "Rukita Amani"          # pohon gedung
```

Semua perintah tulis default **dry-run**. Hasilnya bisa dicek di TB UI (Assets → Relations).

### Bulk: semua device sekaligus lewat CSV / Excel

```bash
npm run setup -- export --out devices.csv     # semua device + building sekarang + saran (dari customer)
# edit devices.csv di Excel/Sheets: isi kolom "building" (dan "space" opsional, mis. "Lantai 2")
npm run setup -- bulk --file devices.csv      # DRY-RUN: tampilkan rencana
npm run setup -- bulk --file devices.csv --apply
npm run setup -- undo --file bulk-undo-<waktu>.json --apply   # kalau perlu dibatalkan
```

- Kolom yang dibaca: `id` (atau `name` kalau nama device unik), `building`, `space`.
  Kolom lain diabaikan. Baris dengan `building` kosong dilewati. CSV dengan pemisah `;`
  (Excel locale Indonesia) juga bisa.
- Building yang belum ada dibuat otomatis (asset type `building`). Space dibuat sebagai
  asset type `space` (`SPACE_ASSET_TYPE`) dengan nama `"<Building> - <Space>"`, karena nama asset
  harus unik di tenant.
- Device yang pindah gedung: relasi lamanya dilepas dan relasi baru dibuat. Bisa dijalankan
  berulang kali (idempotent).
- **Flag di device:** setiap device yang ada di CSV diberi server attribute `building`,
  `buildingId`, dan `space`. Flag ini bisa dipakai untuk filter atau alias dashboard, FMEA, dan
  rule engine tanpa query relasi. Sumber kebenaran tetap relasi `Contains`; flag ditulis ulang
  setiap kali bulk dijalankan.
- Kalau ada satu error saja di CSV (device tidak ditemukan, nama ganda, baris dobel), **tidak
  ada yang ditulis**.
- Setiap `--apply` membuat file `bulk-undo-*.json`. Kalau gagal di tengah jalan, file itu
  berisi semua langkah yang sudah terjadi.
- Kenapa tidak lewat SQL langsung ke database TB: TB menyimpan relasi di cache, jadi tulisan
  SQL tidak terlihat sampai TB di-restart. SQL juga melewati audit log dan rule engine, dan
  skema tabel bisa berubah antar versi TB. Lewat API, 100 device selesai dalam hitungan detik.

## Playground (uji langsung di browser)

`https://iot.get220v.com/building-api/playground`: halaman uji interaktif yang memakai API
ini dengan data asli. Masukkan API key, lalu:

- **Building & Device**: atribut gedung, lantai/ruang, tabel device (online/offline, aktivitas
  terakhir), dan snapshot nilai terakhir semua device.
- **Detail Device**: nilai terakhir, grafik histori per key (1 jam sampai 30 hari, dengan
  agregasi), dan attribute.
- **Live (SSE)**: tile yang ter-update realtime dari `/stream`, plus event mentahnya.
- **Alarm**: alarm aktif/cleared dengan severity.
- **Dashboard Embed**: preview iframe dari `embedUrl`.
- **Log API**: setiap request dan response beserta perintah `curl`-nya (key ditulis `$KEY`),
  siap disalin ke guide integrasi.

Halaman ini statis, tidak berisi rahasia, dan tidak memuat script dari luar. CSP-nya hanya
mengizinkan koneksi ke API di origin yang sama dan tidak bisa di-iframe. API key disimpan
di `sessionStorage` tab itu saja.

## API ringkas

Header: `X-Api-Key: <key>`. Spesifikasi lengkap: `GET /building-api/openapi.yaml`
(buka di https://editor.swagger.io atau generate client dengan `openapi-generator`).

| Method | Path | Scope |
|---|---|---|
| GET | `/v1/buildings` | read |
| GET | `/v1/buildings/{b}` (atribut, lantai, jumlah device) | read |
| GET | `/v1/buildings/{b}/devices?type=&search=` | read |
| GET | `/v1/buildings/{b}/devices/{d}` | read |
| GET | `/v1/buildings/{b}/telemetry/latest?keys=` (semua device) | telemetry |
| GET | `/v1/buildings/{b}/devices/{d}/telemetry/latest?keys=` | telemetry |
| GET | `/v1/buildings/{b}/devices/{d}/telemetry?keys=&startTs=&endTs=&agg=&interval=` | history |
| GET | `/v1/buildings/{b}/devices/{d}/attributes?scope=&keys=` | attributes |
| GET | `/v1/buildings/{b}/alarms?status=ACTIVE&days=30` | alarms |
| POST | `/v1/buildings/{b}/devices/{d}/rpc` `{method, params, timeout, oneway}` | rpc |
| GET | `/v1/buildings/{b}/dashboards` | dashboards |
| POST | `/v1/buildings/{b}/dashboards/{dash}/embed` `{deviceId?}` | dashboards |
| GET | `/v1/buildings/{b}/stream?keys=&devices=` (SSE) | stream |

Nilai telemetry sudah dikonversi: `"2.5"` → `2.5`, `"true"` → `true`, JSON string → objek.

### Contoh

```bash
KEY=g220v_xxx; API=https://iot.get220v.com/building-api
curl -s $API/v1/buildings -H "X-Api-Key: $KEY"
curl -s "$API/v1/buildings/$B/devices" -H "X-Api-Key: $KEY"
curl -s "$API/v1/buildings/$B/telemetry/latest?keys=water_level,pump_running" -H "X-Api-Key: $KEY"
curl -N "$API/v1/buildings/$B/stream" -H "X-Api-Key: $KEY"          # realtime
curl -s -X POST "$API/v1/buildings/$B/devices/$D/rpc" -H "X-Api-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"method":"setRelay","params":{"on":true}}'
```

Realtime dari JavaScript (fetch bisa kirim header, `EventSource` tidak):

```js
const r = await fetch(`${API}/v1/buildings/${B}/stream`, { headers: { 'X-Api-Key': KEY } });
const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
for (let buf = ''; ; ) {
  const { value, done } = await reader.read(); if (done) break;
  buf += value;
  let i; while ((i = buf.indexOf('\n\n')) >= 0) {
    const block = buf.slice(0, i); buf = buf.slice(i + 2);
    const data = block.split('\n').find((l) => l.startsWith('data: '));
    if (block.startsWith('event: telemetry')) console.log(JSON.parse(data.slice(6)));
  }
}
```

Embed dashboard (iframe/WebView). `embedUrl` berlaku 60 detik dan hanya bisa dibuka sekali.
Dashboard otomatis dibuka dengan **entity = building tersebut** (atau device kalau ada
`deviceId`). Jadi satu dashboard template bisa dipakai untuk semua gedung, asalkan alias
dashboard memakai *"Entity from dashboard state"*.

### Webhook

POST JSON ke URL app luar:

```json
{ "id": "uuid", "type": "alarm", "sentAt": "...", "buildingId": "...",
  "items": [ { "event": "alarm.created", "alarm": { "id": "...", "type": "High Temp", "severity": "MAJOR", "deviceId": "...", "deviceName": "Pompa A" } } ] }
```

- `type: "telemetry"`: `items: [{deviceId, values:{key:{ts,value}}}]`, di-batch tiap `WEBHOOK_BATCH_MS`.
  Batasi dengan `telemetryKeys` supaya tidak membanjiri.
- `type: "alarm"`: `alarm.created` / `alarm.updated` / `alarm.cleared`, polling tiap `ALARM_POLL_SEC`.
  Alarm yang sudah aktif saat service start dijadikan baseline, tidak dikirim ulang.
- Verifikasi di sisi penerima:
  `X-Get220v-Signature == "sha256=" + hex(HMAC_SHA256(secret, X-Get220v-Timestamp + "." + rawBody))`,
  dan tolak timestamp yang lebih tua dari 5 menit.
- Retry 3× (1 dtk, 5 dtk, 25 dtk) untuk 5xx/timeout. 4xx tidak di-retry.

## `clients.json`

| field | |
|---|---|
| `id`, `name` | identitas client (log, rate limit) |
| `keySha256` | hash API key (`npm run hash-key`) |
| `buildings` | UUID asset building, atau `["*"]` |
| `scopes` | `read telemetry history attributes alarms stream dashboards rpc webhooks` |
| `rpcMethods` | allowlist method RPC (disarankan diisi kalau scope `rpc`) |
| `embedUserId` | UUID **customer user read-only** TB untuk embed dashboard |
| `includeRefreshToken` | default `false` |
| `allowedOrigins` | CORS untuk panggilan langsung dari browser (kosongkan kalau dari backend) |
| `maxStreams` | maks SSE bersamaan, default 5 |
| `webhooks[]` | `{id, url(https), secret(≥16), buildings, events:["alarm","telemetry"], telemetryKeys}` |

Contoh lengkap: `clients.example.json`.

## Deploy di VPS

```bash
mkdir -p /opt/get220v/get220v-building-gateway   # salin isi folder ini ke sana
cd /opt/get220v/get220v-building-gateway
cp .env.example .env && chmod 600 .env && nano .env
cp clients.example.json clients.json && chmod 600 clients.json
npm run hash-key                                  # 1 key per client
nano clients.json
npm test                                          # test dengan mock TB
npm run setup -- list                             # cek koneksi TB + building
pm2 start deploy/ecosystem.config.cjs && pm2 save
# nginx: tambahkan deploy/nginx-building-api.conf, lalu nginx -t && systemctl reload nginx
curl -s https://iot.get220v.com/building-api/health
```

Kalau Node sistem di VPS < 22 (`node -v`), jangan upgrade Node sistem (bisa mempengaruhi service PM2 lain). Pasang
Node 22 terpisah, misalnya:

```bash
curl -fsSL -o /tmp/node22.tar.xz https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz
mkdir -p /opt/nodejs && tar -xJf /tmp/node22.tar.xz -C /opt/nodejs && mv /opt/nodejs/node-v22.14.0-linux-x64 /opt/nodejs/node22
```

lalu tambahkan `interpreter: '/opt/nodejs/node22/bin/node'` di `apps[0]` pada `deploy/ecosystem.config.cjs` sebelum
`pm2 start` (path lokal, jangan di-commit kalau beda per server).

## Keamanan

- Kredensial tenant admin hanya ada di `.env` server. App luar hanya memegang API key, yang
  bisa di-rotasi atau dicabut per client tanpa menyentuh TB.
- Akses dicek berlapis: API key → scope → allowlist building → device harus ada di topologi
  building → (embed) permission user embed di TB.
- Token TB tidak pernah dikirim di response JSON. Untuk embed, token user read-only hanya
  muncul di redirect `/e/<ticket>`.
- Akun tenant admin yang dipakai sebaiknya khusus untuk service ini.

## Hubungan dengan `dashboard-embed`

Service ini mencakup fitur embed dashboard dari `services/dashboard-embed`, ditambah
scoping per building. Setelah versi produksi `dashboard-embed` di VPS di-sync ke repo,
client lama bisa dipindah ke sini, lalu `dashboard-embed` dimatikan.

## Belum ada (bisa ditambah kalau dibutuhkan)

- **MQTT untuk app luar**: bridge yang mem-publish telemetry building ke broker
  (mis. topik `get220v/buildings/{id}/devices/{id}`). Sekarang yang tersedia SSE + webhook.
- Write telemetry/attribute dari app luar (sekarang read + RPC saja).
- Building berbasis Customer TB (sekarang berbasis Asset).
