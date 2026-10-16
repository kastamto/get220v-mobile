/**
 * Push ke sistem luar (webhook) — untuk app yang lebih suka "dikirimi" daripada polling.
 *
 *  - telemetry : dari RealtimeHub, di-batch per WEBHOOK_BATCH_MS
 *  - alarm     : polling alarmsQuery per gedung, kirim alarm.created / alarm.updated / alarm.cleared
 *
 * Setiap POST ditandatangani: X-Get220v-Signature: sha256=HMAC_SHA256(secret, `${timestamp}.${body}`)
 */
import { createHmac, randomUUID } from 'node:crypto';

export function sign(secret, timestamp, body) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export class WebhookDispatcher {
  constructor({ gateway, hub, clients, config, fetchImpl = fetch, log = console, now = Date.now, retryDelaysMs = [1000, 5000, 25000] }) {
    this.gateway = gateway;
    this.hub = hub;
    this.config = config;
    this.fetch = fetchImpl;
    this.log = log;
    this.now = now;
    this.retryDelaysMs = retryDelaysMs;
    this.targets = clients.flatMap((c) => c.webhooks.map((w) => ({ client: c, hook: w })));
    this.unsubs = new Map(); // deviceId -> unsubscribe
    this.deviceBuildings = new Map(); // deviceId -> Set(buildingId)
    this.buffers = new Map(); // hookKey -> { timer, items[] }
    this.alarmState = new Map(); // buildingId -> Map(alarmId -> status) ; undefined = belum baseline
    this.timers = [];
    this.inflight = 0;
  }

  get enabled() {
    return this.targets.length > 0;
  }

  async start() {
    if (!this.enabled) return;
    // timer dipasang dulu: kalau TB belum siap saat boot, percobaan berikutnya tetap jalan
    const refresh = () => this.refresh().catch((e) => this.log.error('[webhook] refresh:', e.message));
    const poll = () => this.pollAlarms().catch((e) => this.log.error('[webhook] alarm poll:', e.message));
    const t1 = setInterval(refresh, 60_000);
    const t2 = setInterval(poll, this.config.alarmPollSec * 1000);
    for (const t of [t1, t2]) t.unref?.();
    this.timers.push(t1, t2);
    await refresh();
    await poll();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    for (const u of this.unsubs.values()) u();
    for (const b of this.buffers.values()) clearTimeout(b.timer);
  }

  async #buildingsFor(hook, client) {
    const all = await this.gateway.listBuildings(client);
    return all.filter((b) => hook.buildings.all || hook.buildings.ids.has(b.id)).map((b) => b.id);
  }

  /** Sinkronkan subscription telemetry dengan topologi gedung terbaru (tiap 60 dtk; topologi di-cache). */
  async refresh() {
    const want = new Map();
    for (const { client, hook } of this.targets) {
      if (!hook.events.has('telemetry')) continue;
      for (const bid of await this.#buildingsFor(hook, client)) {
        const topo = await this.gateway.topology(bid);
        for (const did of topo.devices.keys()) {
          if (!want.has(did)) want.set(did, new Set());
          want.get(did).add(bid);
        }
      }
    }
    for (const [did, u] of this.unsubs) {
      if (!want.has(did)) {
        u();
        this.unsubs.delete(did);
      }
    }
    for (const did of want.keys()) {
      if (!this.unsubs.has(did)) this.unsubs.set(did, this.hub.subscribe(did, (ev) => this.#onTelemetry(ev)));
    }
    this.deviceBuildings = want;
  }

  #onTelemetry({ deviceId, values }) {
    for (const bid of this.deviceBuildings.get(deviceId) ?? []) {
      for (const { client, hook } of this.targets) {
        if (!hook.events.has('telemetry')) continue;
        if (!(hook.buildings.all || hook.buildings.ids.has(bid))) continue;
        if (!client.buildings.all && !client.buildings.ids.has(bid)) continue;
        let v = values;
        if (hook.telemetryKeys) {
          v = Object.fromEntries(Object.entries(values).filter(([k]) => hook.telemetryKeys.has(k)));
          if (Object.keys(v).length === 0) continue;
        }
        this.#buffer(client, hook, bid, { deviceId, values: v });
      }
    }
  }

  #buffer(client, hook, buildingId, item) {
    const key = `${client.id}/${hook.id}/${buildingId}`;
    let b = this.buffers.get(key);
    if (!b) {
      b = { items: [], timer: null };
      this.buffers.set(key, b);
    }
    if (b.items.length < 5000) b.items.push(item); // batas memori bila endpoint lambat
    if (!b.timer) {
      b.timer = setTimeout(() => {
        this.buffers.delete(key);
        this.deliver(hook, 'telemetry', { buildingId, items: b.items });
      }, this.config.webhookBatchMs);
      b.timer.unref?.();
    }
  }

  async pollAlarms() {
    const byBuilding = new Map(); // bid -> [{client, hook}]
    for (const t of this.targets) {
      if (!t.hook.events.has('alarm')) continue;
      for (const bid of await this.#buildingsFor(t.hook, t.client)) {
        if (!byBuilding.has(bid)) byBuilding.set(bid, []);
        byBuilding.get(bid).push(t);
      }
    }
    for (const [bid, targets] of byBuilding) {
      const topo = await this.gateway.topology(bid);
      const list = await this.gateway.alarmsForTopology(topo, { status: 'ACTIVE', limit: 500, days: 30 });
      const prev = this.alarmState.get(bid);
      const cur = new Map(list.map((a) => [a.id, a]));
      this.alarmState.set(bid, new Map([...cur].map(([id, a]) => [id, `${a.status}|${a.severity}`])));
      if (!prev) continue; // poll pertama = baseline, jangan banjiri webhook dengan alarm lama
      const events = [];
      for (const [id, a] of cur) {
        if (!prev.has(id)) events.push({ event: 'alarm.created', alarm: a });
        else if (prev.get(id) !== `${a.status}|${a.severity}`) events.push({ event: 'alarm.updated', alarm: a });
      }
      for (const id of prev.keys()) if (!cur.has(id)) events.push({ event: 'alarm.cleared', alarm: { id } });
      if (events.length === 0) continue;
      for (const { hook } of targets) this.deliver(hook, 'alarm', { buildingId: bid, items: events });
    }
  }

  async deliver(hook, type, payload) {
    const body = JSON.stringify({ id: randomUUID(), type, sentAt: new Date(this.now()).toISOString(), ...payload });
    this.inflight++;
    try {
      for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
        const ts = String(Math.floor(this.now() / 1000));
        try {
          const r = await this.fetch(hook.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'get220v-building-gateway/1',
              'X-Get220v-Event': type,
              'X-Get220v-Timestamp': ts,
              'X-Get220v-Signature': sign(hook.secret, ts, body),
            },
            body,
            signal: AbortSignal.timeout(10_000),
          });
          if (r.ok) return true;
          if (r.status >= 400 && r.status < 500 && r.status !== 429) {
            this.log.error(`[webhook] ${hook.id} ditolak ${r.status}, tidak di-retry`);
            return false;
          }
        } catch (e) {
          if (attempt === this.retryDelaysMs.length) this.log.error(`[webhook] ${hook.id} gagal: ${e.message}`);
        }
        if (attempt < this.retryDelaysMs.length) await new Promise((res) => setTimeout(res, this.retryDelaysMs[attempt]));
      }
      this.log.error(`[webhook] ${hook.id} menyerah setelah ${this.retryDelaysMs.length + 1} percobaan (${type})`);
      return false;
    } finally {
      this.inflight--;
    }
  }
}
