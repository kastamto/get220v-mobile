// Contoh di BACKEND app lain (API key jangan pernah dikirim ke browser/APK).
// Endpoint ini dipanggil frontend app tsb, lalu embedUrl dipasang di <iframe> / WebView.
const EMBED_API = 'https://iot.get220v.com/dash-embed/api/v1';
const API_KEY = process.env.GET220V_EMBED_KEY;

export async function getDashboardEmbedUrl(dashboardId, deviceId) {
  const res = await fetch(`${EMBED_API}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
    body: JSON.stringify({
      dashboardId,
      hideToolbar: true,
      // opsional: buka langsung state detail untuk 1 device
      ...(deviceId ? { stateId: 'default', entity: { id: deviceId, entityType: 'DEVICE' } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`embed gagal: ${res.status} ${(await res.json()).error}`);
  return res.json(); // { embedUrl, ticketExpiresAt, sessionExpiresAt, dashboard }
}
