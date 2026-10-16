/**
 * Satu koneksi WebSocket bersama ke ThingsBoard (/api/ws) untuk semua subscriber
 * (SSE client + webhook). Subscription per device di-refcount: device yang sama
 * dipantau 10 client tetap 1 subscription di TB.
 */
import { normalizeLatest } from './gateway.js';

export class RealtimeHub {
  constructor({ wsUrl, getToken, WebSocketImpl = globalThis.WebSocket, log = console, idleCloseMs = 30_000 }) {
    this.wsUrl = wsUrl;
    this.getToken = getToken;
    this.WebSocketImpl = WebSocketImpl;
    this.log = log;
    this.idleCloseMs = idleCloseMs;
    this.subs = new Map(); // deviceId -> { cmdId, listeners:Set }
    this.byCmd = new Map(); // cmdId -> deviceId
    this.nextCmd = 1;
    this.ws = null;
    this.ready = false;
    this.connecting = false;
    this.backoff = 1000;
    this.idleTimer = null;
    this.reconnectTimer = null;
    this.closed = false;
  }

  /** @returns {() => void} fungsi unsubscribe */
  subscribe(deviceId, listener) {
    let s = this.subs.get(deviceId);
    if (!s) {
      s = { cmdId: this.nextCmd++, listeners: new Set() };
      this.subs.set(deviceId, s);
      this.byCmd.set(s.cmdId, deviceId);
      if (this.ready) this.#send({ cmds: [this.#cmd(deviceId, s.cmdId)] });
    }
    s.listeners.add(listener);
    clearTimeout(this.idleTimer);
    this.#ensureConnected();
    return () => this.#unsubscribe(deviceId, listener);
  }

  get size() {
    return this.subs.size;
  }

  close() {
    this.closed = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  #cmd(deviceId, cmdId, unsubscribe = false) {
    return { type: 'TIMESERIES', entityType: 'DEVICE', entityId: deviceId, scope: 'LATEST_TELEMETRY', cmdId, ...(unsubscribe ? { unsubscribe: true } : {}) };
  }

  #unsubscribe(deviceId, listener) {
    const s = this.subs.get(deviceId);
    if (!s) return;
    s.listeners.delete(listener);
    if (s.listeners.size > 0) return;
    this.subs.delete(deviceId);
    this.byCmd.delete(s.cmdId);
    if (this.ready) this.#send({ cmds: [this.#cmd(deviceId, s.cmdId, true)] });
    if (this.subs.size === 0) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (this.subs.size === 0) this.ws?.close();
      }, this.idleCloseMs);
      this.idleTimer.unref?.();
    }
  }

  #send(obj) {
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (e) {
      this.log.error('[realtime] send gagal:', e.message);
    }
  }

  async #ensureConnected() {
    if (this.ws || this.connecting || this.closed) return;
    this.connecting = true;
    let token;
    try {
      token = await this.getToken();
    } catch (e) {
      this.connecting = false;
      this.log.error('[realtime] gagal ambil token TB:', e.message);
      return this.#scheduleReconnect();
    }
    this.connecting = false;
    if (this.subs.size === 0 || this.closed) return;
    const ws = new this.WebSocketImpl(this.wsUrl);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.ready = true;
      this.backoff = 1000;
      const cmds = [...this.subs.entries()].map(([id, s]) => this.#cmd(id, s.cmdId));
      this.#send({ authCmd: { cmdId: 0, token }, cmds });
    });
    ws.addEventListener('message', (ev) => this.#onMessage(ev.data));
    ws.addEventListener('close', () => {
      this.ws = null;
      this.ready = false;
      if (this.subs.size > 0 && !this.closed) this.#scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      /* 'close' menyusul; reconnect ditangani di sana */
    });
  }

  #scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30_000);
    this.reconnectTimer = setTimeout(() => this.#ensureConnected(), delay);
    this.reconnectTimer.unref?.();
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
    } catch {
      return;
    }
    if (msg.errorCode) {
      this.log.error(`[realtime] TB error cmd ${msg.subscriptionId}: ${msg.errorMsg}`);
      return;
    }
    const deviceId = this.byCmd.get(msg.subscriptionId);
    if (!deviceId || !msg.data) return;
    const values = normalizeLatest(msg.data);
    if (Object.keys(values).length === 0) return;
    for (const l of this.subs.get(deviceId)?.listeners ?? []) {
      try {
        l({ deviceId, values });
      } catch (e) {
        this.log.error('[realtime] listener error:', e.message);
      }
    }
  }
}
