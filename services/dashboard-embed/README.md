# get220v-dashboard-embed

Service supaya **aplikasi lain** (portal web Rukita, app mobile lain, layar lobby, dll) bisa
**me-render dashboard ThingsBoard** `iot.get220v.com` lewat `<iframe>` / WebView —
tanpa kredensial TB ada di client.

Node ≥ 20.12, **tanpa dependency** (cukup `node`). Port default `3010`.

## Cara kerja

```
App lain (backend) --X-Api-Key--> POST /dash-embed/api/v1/embed {dashboardId}
                                   │  1. cek API key + allowlist dashboard app
                                   │  2. tenant admin (server-side) minta token USER EMBED
                                   │     via GET /api/user/{userId}/token
                                   │  3. TB cek: user embed boleh lihat dashboard ini?
                                   ▼
                     { embedUrl: https://iot.get220v.com/dash-embed/e/<ticket> }   (60 dtk, sekali pakai)
App lain (frontend) iframe/WebView src=embedUrl
                                   ▼  302
            https://iot.get220v.com/dashboard/<id>?accessToken=<token user embed>&hideToolbar=true
```

- Kredensial tenant admin **hanya** di `.env` server. Client hanya pernah memegang token
  user embed (sebaiknya **customer user read-only**), dan itupun hanya lewat redirect.
- Hak akses ditegakkan **dua lapis**: allowlist di `apps.json` + permission TB sendiri
  (dashboard harus di-assign ke customer si user embed).
- Mode `public`: untuk dashboard yang dijadikan *public* di TB → redirect ke
  `/dashboard/<id>?publicId=<publicCustomerId>`, tanpa token sama sekali.

## API

Semua `/api/*` butuh header `X-Api-Key: <key>`.

| Method | Path | Keterangan |
|---|---|---|
| `GET` | `/dash-embed/health` | status service |
| `GET` | `/dash-embed/api/v1/dashboards?search=&page=0&pageSize=20` | daftar dashboard yang boleh di-embed app ini |
| `POST` | `/dash-embed/api/v1/embed` | buat link embed (lihat body di bawah) |
| `GET` | `/dash-embed/e/<ticket>` | dibuka oleh iframe/WebView → 302 ke dashboard TB |

Body `POST /embed`:

```jsonc
{
  "dashboardId": "UUID",            // wajib
  "hideToolbar": true,              // opsional, default dari apps.json defaultParams
  // opsional — buka state tertentu untuk 1 entity (mis. detail 1 pompa):
  "stateId": "default",
  "entity": { "id": "DEVICE_UUID", "entityType": "DEVICE" },
  "entityName": "Pompa Dwi Warna",
  // atau kirim "state" mentah (base64, sama seperti param ?state= di URL TB)
}
```

Response:

```json
{
  "embedUrl": "https://iot.get220v.com/dash-embed/e/Xy…",
  "ticketExpiresAt": "2026-10-16T08:01:00Z",
  "sessionExpiresAt": "2026-10-16T10:30:00Z",
  "dashboard": { "id": "…", "title": "Fleet Pompa" }
}
```

`sessionExpiresAt` = kapan token user embed habis (default TB 2,5 jam). Sebelum itu,
minta `embedUrl` baru dan reload iframe (contoh di `examples/frontend-iframe.html`).
Kalau app di-set `includeRefreshToken: true`, TB memperpanjang sesi sendiri
(`sessionExpiresAt: null`) — konsekuensinya refresh token ikut ke client.

Error: `401` key salah, `403` dashboard tidak diizinkan / tidak di-assign, `404`,
`429` rate limit, `502` TB tidak bisa dihubungi.

## Setup di VPS

1. **Buat user embed di TB** (sekali per app/klien):
   Customers → (mis. `Rukita`) → Users → tambah `embed-rukita@get220v.id`.
   Assign dashboard yang boleh dilihat ke customer itu. Salin **User ID** (ikon copy di detail user).
   Untuk mode public: Dashboards → ⋮ → *Make dashboard public*.
2. **Akun tenant admin service**: disarankan buat tenant admin khusus `embed-svc@…`
   (jangan pakai akun admin harian; kalau password-nya bocor dari handoff/chat, ganti).
3. Deploy:

   ```bash
   mkdir -p /opt/get220v/get220v-dashboard-embed
   # salin isi folder services/dashboard-embed/ ke sana (git clone / scp)
   cd /opt/get220v/get220v-dashboard-embed
   cp .env.example .env && chmod 600 .env && nano .env      # isi TB_TENANT_*
   npm run hash-key                                          # generate API key per app
   cp apps.example.json apps.json && chmod 600 apps.json && nano apps.json
   npm test                                                  # 10 test, pakai mock TB
   pm2 start deploy/ecosystem.config.cjs && pm2 save
   ```

4. Nginx: tambahkan `deploy/nginx-dash-embed.conf` ke server block `iot.get220v.com`,
   `nginx -t && systemctl reload nginx`. Cek juga catatan `X-Frame-Options` di file itu
   bila dashboard mau di-iframe dari domain lain.
5. Tes:

   ```bash
   curl -s https://iot.get220v.com/dash-embed/health
   curl -s https://iot.get220v.com/dash-embed/api/v1/dashboards -H "X-Api-Key: $KEY"
   curl -s -X POST https://iot.get220v.com/dash-embed/api/v1/embed \
     -H "X-Api-Key: $KEY" -H 'Content-Type: application/json' \
     -d '{"dashboardId":"<uuid>"}'
   # buka embedUrl di browser dalam 60 detik
   ```

## `apps.json`

| field | |
|---|---|
| `id` | nama app (dipakai di log & rate limit) |
| `keySha256` | hash API key (`npm run hash-key`); key asli hanya diberikan ke backend app tsb |
| `mode` | `user` (token user embed) atau `public` (dashboard public TB) |
| `tbUserId` | UUID user embed TB (mode `user`) |
| `allowedDashboards` | list UUID, atau `["*"]` = semua yang bisa diakses user embed |
| `allowedOrigins` | origin browser yang boleh memanggil API langsung (CORS). Kosongkan bila dipanggil dari backend — **disarankan**, karena API key di browser = bocor |
| `includeRefreshToken` | `false` (default) atau `true` |
| `defaultParams` | mis. `{ "hideToolbar": true }` |

Rotasi key: generate key baru, ganti `keySha256`, `pm2 restart get220v-dashboard-embed`.

## Catatan

- Ticket disimpan in-memory → jalankan **1 instance** PM2. Restart = ticket yang belum
  dipakai hangus (hanya berumur 60 detik, aman).
- Token embed tetap muncul di URL TB setelah redirect (mekanisme login-by-URL TB, sama
  dengan yang dipakai app mobile ini di `dashboard_widget.dart`). Karena itu pakai user
  embed read-only dengan scope sekecil mungkin, bukan tenant admin.
- Widget door sensor yang masih hardcode kredensial admin bisa dipindah ke pola yang sama
  (security TODO #5 di handoff).
