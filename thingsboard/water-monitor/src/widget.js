// Get220v Water Monitor — ThingsBoard custom widget (tipe "latest values").
//
// Satu kode, beberapa tampilan yang dipilih lewat settings.view:
//   alerts | live | usage | setup | calibration
//
// Semua konfigurasi (okupansi kamar, tarif, baseline, ambang alert, faktor
// kalibrasi) disimpan sebagai SERVER_SCOPE attribute di device, sehingga:
//   - semua widget/pengguna melihat setup yang sama secara realtime, dan
//   - alarm rule di Device Profile bisa memakai baseline sebagai threshold
//     dinamis (lihat README).

const TELEMETRY_KEYS = [
  'alarm_level_high', 'alarm_level_low', 'evt', 'flow_lpm', 'flow_mode',
  'flow_today_l', 'flow_total_l', 'pump_last_run_s', 'pump_runtime_today_s',
  'pump_runtime_total_s', 'pump_session_s', 'pump_starts_today',
  'pump_starts_total', 'pump_state', 'rssi', 'secs_today', 'tank_capacity_l',
  'tank_dist_cm', 'tank_level_pct', 'tank_volume_l', 'uptime_s',
];

const CFG_DEFAULTS = {
  wm_rooms_total: 0,
  wm_rooms_occupied: 0,
  wm_tariff_m3: 0,
  wm_baseline_cost_room_day: 0,
  wm_warn_pct: 80,
  wm_tank_low_pct: 20,
  wm_tank_high_pct: 98,
  wm_leak_min: 30,
  wm_pump_max_min: 20,
  wm_pump_starts_max: 40,
  wm_offline_min: 10,
  wm_rssi_min: -85,
  wm_cal_factor: 1,
};

const DAY_MS = 86400000;
const STATUS = {
  good: { color: '#0ca30c', icon: '✔', label: 'Normal' },
  warning: { color: '#fab219', icon: '▲', label: 'Peringatan' },
  critical: { color: '#d03b3b', icon: '■', label: 'Kritis' },
  info: { color: '#2a78d6', icon: 'ℹ', label: 'Info' },
  none: { color: '#8a8984', icon: '–', label: 'Belum di-setup' },
};
const SERIES = '#2a78d6';
const HARI = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

let W = null;

self.onInit = function () {
  const settings = self.ctx.settings || {};
  W = {
    view: settings.view || 'live',
    root: self.ctx.$container[0].querySelector('.wm-root'),
    latest: {},
    entity: null,
    daily: null,
    dailyErr: null,
    range: 14,
    chart24: null,
    leak: false,
    serverAlarms: null,
    prevAlertIds: null,
    timers: [],
    pendingRender: false,
    setupDirty: false,
  };
  W.root.classList.add('wm-view-' + W.view);
  W.onClick = (e) => handleClick(e);
  W.onChange = (e) => handleChange(e);
  W.onInput = (e) => handleInput(e);
  W.onFocusOut = () => {
    setTimeout(() => {
      if (W && W.pendingRender && !hasFocus()) render();
    }, 0);
  };
  W.onMove = (e) => handleTip(e);
  W.onLeave = () => hideTip();
  W.root.addEventListener('click', W.onClick);
  W.root.addEventListener('change', W.onChange);
  W.root.addEventListener('input', W.onInput);
  W.root.addEventListener('focusout', W.onFocusOut);
  W.root.addEventListener('mousemove', W.onMove);
  W.root.addEventListener('mouseleave', W.onLeave);

  every(30000, render); // agar status online/"x menit lalu" tetap segar
  if (W.view === 'live') every(5 * 60000, fetchChart24);
  if (W.view === 'usage') every(10 * 60000, fetchDaily);
  if (W.view === 'alerts') {
    every(2 * 60000, checkLeak);
    every(60000, fetchServerAlarms);
  }
  self.onDataUpdated();
};

self.onDataUpdated = function () {
  if (!W) return;
  const changed = readData();
  if (changed) onEntityChanged();
  render();
};

self.onResize = function () {
  if (W) render(true);
};

self.onDestroy = function () {
  if (!W) return;
  W.timers.forEach((t) => clearInterval(t));
  W.root.removeEventListener('click', W.onClick);
  W.root.removeEventListener('change', W.onChange);
  W.root.removeEventListener('input', W.onInput);
  W.root.removeEventListener('focusout', W.onFocusOut);
  W.root.removeEventListener('mousemove', W.onMove);
  W.root.removeEventListener('mouseleave', W.onLeave);
  W = null;
};

self.typeParameters = function () {
  return {
    maxDatasources: 1,
    dataKeysOptional: false,
    singleEntity: true,
  };
};

// ---------------------------------------------------------------- data ----

function every(ms, fn) {
  W.timers.push(setInterval(() => W && fn(), ms));
}

function readData() {
  let entity = null;
  const latest = {};
  (self.ctx.data || []).forEach((item) => {
    const ds = item.datasource || {};
    if (!entity && ds.entityId) {
      entity = {
        id: ds.entityId,
        type: ds.entityType || 'DEVICE',
        name: ds.entityLabel || ds.entityName || '',
      };
    }
    const d = item.data;
    if (d && d.length) {
      const p = d[d.length - 1];
      if (p && p[1] !== undefined && p[1] !== null && p[1] !== '') {
        latest[item.dataKey.name] = { ts: p[0], v: p[1] };
      }
    }
  });
  W.latest = latest;
  const changed = !!entity && (!W.entity || W.entity.id !== entity.id);
  if (entity) W.entity = entity;
  return changed;
}

function onEntityChanged() {
  W.daily = null;
  W.chart24 = null;
  W.leak = false;
  W.serverAlarms = null;
  W.prevAlertIds = null;
  W.setupDirty = false;
  if (W.view === 'live') fetchChart24();
  if (W.view === 'usage') fetchDaily();
  if (W.view === 'alerts') {
    checkLeak();
    fetchServerAlarms();
  }
}

function num(key, def) {
  const x = W.latest[key];
  if (!x) return def;
  const n = parseFloat(x.v);
  return isNaN(n) ? def : n;
}

function json(key, def) {
  const x = W.latest[key];
  if (!x) return def;
  if (typeof x.v === 'object') return x.v;
  try {
    const v = JSON.parse(x.v);
    return v && typeof v === 'object' ? v : def;
  } catch (e) {
    return def;
  }
}

function cfg() {
  const c = {};
  Object.keys(CFG_DEFAULTS).forEach((k) => (c[k] = num(k, CFG_DEFAULTS[k])));
  if (!(c.wm_cal_factor > 0)) c.wm_cal_factor = 1;
  c.occLog = json('wm_occ_log', {});
  c.calLog = json('wm_cal_log', []);
  if (!Array.isArray(c.calLog)) c.calLog = [];
  return c;
}

function occupancyFor(c, day) {
  const v = c.occLog[day];
  if (v !== undefined && v !== null && !isNaN(parseFloat(v))) {
    return { rooms: parseFloat(v), isDefault: false };
  }
  return { rooms: c.wm_rooms_occupied, isDefault: true };
}

function baselineRoomL(c) {
  return c.wm_tariff_m3 > 0 ? (c.wm_baseline_cost_room_day / c.wm_tariff_m3) * 1000 : 0;
}

function usageStatus(pct, c) {
  if (pct === null) return 'none';
  if (pct >= 100) return 'critical';
  if (pct >= c.wm_warn_pct) return 'warning';
  return 'good';
}

function lastTelemetryTs() {
  let ts = 0;
  TELEMETRY_KEYS.forEach((k) => {
    const x = W.latest[k];
    if (x && x.ts > ts) ts = x.ts;
  });
  return ts;
}

function metrics() {
  const c = cfg();
  const now = Date.now();
  const today = dayKey(now);
  const cal = c.wm_cal_factor;
  const occ = occupancyFor(c, today);
  const usage = num('flow_today_l', 0) * cal;
  const bRoomL = baselineRoomL(c);
  const bDayL = bRoomL * occ.rooms;
  const cost = (usage / 1000) * c.wm_tariff_m3;
  const secsToday = num('secs_today', (now - startOfDay(now)) / 1000);
  const dayFrac = Math.min(1, Math.max(0, secsToday / 86400));
  const pct = bDayL > 0 ? (usage / bDayL) * 100 : null;
  const lastTs = lastTelemetryTs();
  return {
    c,
    now,
    today,
    cal,
    occ,
    usage,
    bRoomL,
    bDayL,
    cost,
    costRoom: occ.rooms > 0 ? cost / occ.rooms : null,
    lRoom: occ.rooms > 0 ? usage / occ.rooms : null,
    pct,
    status: usageStatus(pct, c),
    dayFrac,
    projected: dayFrac >= 0.125 ? usage / dayFrac : null,
    lastTs,
    online: lastTs > 0 && now - lastTs <= c.wm_offline_min * 60000,
    flow: num('flow_lpm', 0) * cal,
    total: num('flow_total_l', 0) * cal,
    level: num('tank_level_pct', null),
    pumpOn: num('pump_state', 0) === 1,
  };
}

// Atribut turunan yang ikut disimpan setiap kali setup berubah. Dipakai
// alarm rule Device Profile sebagai threshold dinamis. Nilai *_raw_l sudah
// dibagi faktor kalibrasi agar bisa dibandingkan langsung dengan
// telemetry mentah flow_today_l.
function derivedAttrs(c) {
  const today = dayKey(Date.now());
  const occ = occupancyFor(c, today).rooms;
  const roomL = baselineRoomL(c);
  const dayL = roomL * occ;
  const cal = c.wm_cal_factor > 0 ? c.wm_cal_factor : 1;
  return {
    wm_occ_today: occ,
    wm_baseline_room_l: round(roomL, 2),
    wm_baseline_day_l: round(dayL, 2),
    wm_baseline_day_raw_l: round(dayL / cal, 2),
    wm_warn_day_raw_l: round(((dayL / cal) * c.wm_warn_pct) / 100, 2),
    wm_updated_ts: Date.now(),
  };
}

// --------------------------------------------------------------- alerts ---

function evalAlerts(m) {
  const c = m.c;
  const out = [];
  const add = (id, level, title, msg) => out.push({ id, level, title, msg });

  if (!(c.wm_tariff_m3 > 0) || !(c.wm_baseline_cost_room_day > 0) || !(m.occ.rooms > 0)) {
    add('setup', 'info', 'Setup baseline belum lengkap',
      'Isi tarif air, baseline biaya/kamar/hari dan jumlah kamar terisi di panel Setup.');
  }
  if (m.lastTs > 0 && !m.online) {
    add('offline', 'critical', 'Device offline',
      'Data terakhir ' + ago(m.lastTs) + ' (batas ' + c.wm_offline_min + ' menit). Nilai lain mungkin tidak akurat.');
  }
  if (m.pct !== null) {
    const detail = fmtL(m.usage) + ' dari baseline ' + fmtL(m.bDayL) + ' (' +
      fmtNum(m.pct, 0) + '%) · biaya ' + fmtRp(m.cost) +
      (m.costRoom !== null ? ' = ' + fmtRp(m.costRoom) + '/kamar' : '');
    if (m.pct >= 100) {
      add('usage_over', 'critical', 'Pemakaian melebihi baseline', detail);
    } else if (m.pct >= c.wm_warn_pct) {
      add('usage_near', 'warning', 'Pemakaian mendekati baseline', detail);
    } else if (m.projected !== null && m.projected > m.bDayL) {
      add('usage_projected', 'warning', 'Proyeksi hari ini melebihi baseline',
        'Dengan laju sekarang diperkirakan ' + fmtL(m.projected) + ' (' +
        fmtNum((m.projected / m.bDayL) * 100, 0) + '% baseline) sampai akhir hari.');
    }
  }
  const lowFlag = num('alarm_level_low', 0) === 1;
  if (lowFlag || (m.level !== null && m.level < c.wm_tank_low_pct)) {
    add('tank_low', 'critical', 'Level tangki rendah',
      'Level ' + fmtNum(m.level, 1) + '% (batas ' + c.wm_tank_low_pct + '%)' +
      (lowFlag ? ' · sensor alarm level rendah aktif' : ''));
  }
  const highFlag = num('alarm_level_high', 0) === 1;
  if (highFlag || (m.level !== null && m.level > c.wm_tank_high_pct)) {
    add('tank_high', 'warning', 'Level tangki tinggi / potensi overflow',
      'Level ' + fmtNum(m.level, 1) + '% (batas ' + c.wm_tank_high_pct + '%)' +
      (highFlag ? ' · sensor alarm level tinggi aktif' : ''));
  }
  if (W.leak) {
    add('leak', 'critical', 'Aliran terus-menerus (indikasi bocor)',
      'Flow > 0 tanpa henti selama ≥ ' + c.wm_leak_min + ' menit. Cek keran/pipa/pelampung.');
  }
  const session = num('pump_session_s', 0);
  if (m.pumpOn && session > c.wm_pump_max_min * 60) {
    add('pump_long', 'warning', 'Pompa menyala terlalu lama',
      'Sesi sekarang ' + fmtDur(session) + ' (batas ' + c.wm_pump_max_min + ' menit). Cek sumber air / dry-run.');
  }
  const starts = num('pump_starts_today', 0);
  if (starts > c.wm_pump_starts_max) {
    add('pump_cycling', 'warning', 'Pompa terlalu sering start',
      starts + '× hari ini (batas ' + c.wm_pump_starts_max + '×). Indikasi bocor kecil atau pressure switch.');
  }
  const rssi = num('rssi', null);
  if (rssi !== null && rssi < c.wm_rssi_min) {
    add('rssi', 'info', 'Sinyal WiFi lemah', 'RSSI ' + rssi + ' dBm (batas ' + c.wm_rssi_min + ' dBm).');
  }
  const evt = num('evt', 0);
  if (evt) add('evt', 'info', 'Event dari device', 'Kode event: ' + evt);

  const rank = { critical: 0, warning: 1, info: 2 };
  out.sort((a, b) => rank[a.level] - rank[b.level]);
  return out;
}

function trackAlerts(alerts) {
  const ids = alerts.map((a) => a.id);
  if (W.prevAlertIds) {
    const fresh = alerts.filter((a) => W.prevAlertIds.indexOf(a.id) < 0 && a.level !== 'info');
    const gone = W.prevAlertIds.filter((id) => ids.indexOf(id) < 0);
    fresh.forEach((a) => {
      logAlert({ ts: Date.now(), level: a.level, title: a.title, msg: a.msg });
      notify(a);
    });
    gone.forEach((id) => logAlert({ ts: Date.now(), level: 'good', title: 'Pulih: ' + id, msg: '' }));
  }
  W.prevAlertIds = ids;
}

function storeKey(name) {
  return 'get220v_wm_' + name + '_' + (W.entity ? W.entity.id : 'x');
}

function store(name, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(storeKey(name)) || 'null');
    localStorage.setItem(storeKey(name), JSON.stringify(value));
  } catch (e) {
    return null;
  }
  return value;
}

function logAlert(entry) {
  const log = store('log') || [];
  log.unshift(entry);
  store('log', log.slice(0, 30));
}

function notify(a) {
  if (!store('notify') || typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  try {
    new Notification((W.entity ? W.entity.name + ': ' : '') + a.title, { body: a.msg });
  } catch (e) {
    // Beberapa browser mobile tidak mengizinkan Notification di luar service worker.
  }
}

function checkLeak() {
  if (!W.entity) return;
  const c = cfg();
  const winMs = c.wm_leak_min * 60000;
  const end = Date.now();
  const start = end - winMs;
  api('get', tsUrl(['flow_lpm'], start, end, 'NONE', 0, 1000), null, (res) => {
    const pts = toPoints(res, 'flow_lpm');
    let leak;
    if (!pts.length) {
      // Device tidak mengirim data baru dalam jendela; nilai terakhir masih > 0.
      const x = W.latest.flow_lpm;
      leak = !!x && parseFloat(x.v) > 0 && x.ts <= start;
    } else {
      // Harus ada sampel di awal jendela (agar benar-benar "selama X menit")
      // dan semuanya > 0.
      const coversWindow = pts[0][0] - start <= winMs * 0.2;
      leak = pts.length >= 2 && coversWindow && pts.every((p) => p[1] > 0);
    }
    if (leak !== W.leak) {
      W.leak = leak;
      render();
    }
  });
}

function fetchServerAlarms() {
  if (!W.entity) return;
  const url = '/api/alarm/' + W.entity.type + '/' + W.entity.id +
    '?searchStatus=ACTIVE&pageSize=20&page=0&sortProperty=createdTime&sortOrder=DESC';
  api('get', url, null, (res) => {
    W.serverAlarms = (res && res.data) || [];
    render();
  }, () => {
    W.serverAlarms = [];
    render();
  });
}

// ---------------------------------------------------------------- http ----

function api(method, url, body, ok, fail) {
  let obs;
  try {
    obs = method === 'get' ? self.ctx.http.get(url) : self.ctx.http.post(url, body);
  } catch (e) {
    if (fail) fail(e);
    return;
  }
  obs.subscribe(
    (res) => ok && ok(res),
    (err) => {
      if (fail) fail(err);
      else toast('Gagal memuat data: ' + errMsg(err), true);
    },
  );
}

function errMsg(err) {
  return (err && err.error && err.error.message) || (err && err.message) || 'error';
}

function tsUrl(keys, start, end, agg, interval, limit) {
  let url = '/api/plugins/telemetry/' + W.entity.type + '/' + W.entity.id +
    '/values/timeseries?keys=' + keys.join(',') + '&startTs=' + Math.floor(start) +
    '&endTs=' + Math.floor(end) + '&agg=' + agg + '&limit=' + (limit || 1000) +
    '&orderBy=ASC&useStrictDataTypes=false';
  if (interval) url += '&interval=' + interval;
  return url;
}

function toPoints(res, key) {
  return ((res && res[key]) || [])
    .map((p) => [p.ts, parseFloat(p.value)])
    .filter((p) => !isNaN(p[1]))
    .sort((a, b) => a[0] - b[0]);
}

function saveAttrs(values, okMsg, done) {
  if (!W.entity) {
    toast('Device belum terpilih', true);
    return;
  }
  const url = '/api/plugins/telemetry/' + W.entity.type + '/' + W.entity.id + '/attributes/SERVER_SCOPE';
  api('post', url, values, () => {
    toast(okMsg || 'Tersimpan');
    if (done) done(true);
  }, (err) => {
    toast('Gagal menyimpan: ' + errMsg(err) + ' (butuh izin tulis atribut device)', true);
    if (done) done(false);
  });
}

function toast(msg, isError) {
  try {
    if (isError) self.ctx.showErrorToast(msg, 'bottom', 'center', self.ctx.toastTargetId);
    else self.ctx.showSuccessToast(msg, 2500, 'bottom', 'center', self.ctx.toastTargetId);
  } catch (e) {
    console.log('[water-monitor]', msg);
  }
}

function fetchChart24() {
  if (!W.entity) return;
  const end = Date.now();
  const start = end - DAY_MS;
  const res = {};
  let pending = 2;
  const done = () => {
    if (--pending === 0) {
      W.chart24 = res;
      render();
    }
  };
  api('get', tsUrl(['tank_level_pct'], start, end, 'AVG', 15 * 60000, 200), null, (r) => {
    res.level = toPoints(r, 'tank_level_pct');
    done();
  }, () => {
    res.level = [];
    done();
  });
  api('get', tsUrl(['flow_lpm'], start, end, 'MAX', 15 * 60000, 200), null, (r) => {
    res.flow = toPoints(r, 'flow_lpm');
    done();
  }, () => {
    res.flow = [];
    done();
  });
}

function fetchDaily() {
  if (!W.entity) return;
  const end = Date.now();
  const start = startOfDay(end) - (W.range - 1) * DAY_MS;
  // Bucket harian dimulai dari tengah malam lokal (startTs), jadi MAX dari
  // counter harian = total hari tsb.
  const keys = ['flow_today_l', 'flow_total_l', 'pump_runtime_today_s', 'pump_starts_today'];
  W.dailyErr = null;
  api('get', tsUrl(keys, start, end, 'MAX', DAY_MS, 1000), null, (res) => {
    const days = {};
    for (let t = start; t <= end; t += DAY_MS) {
      days[dayKey(t + 3600000)] = {};
    }
    keys.forEach((k) => {
      toPoints(res, k).forEach((p) => {
        const d = dayKey(p[0]);
        if (days[d]) days[d][k] = p[1];
      });
    });
    W.daily = days;
    render();
  }, (err) => {
    W.dailyErr = errMsg(err);
    W.daily = {};
    render();
  });
}

// ------------------------------------------------------------- render -----

function hasFocus() {
  const a = document.activeElement;
  return !!a && W.root.contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName);
}

function render(force) {
  if (!W) return;
  // Jangan menimpa input yang sedang diketik; render ulang setelah blur.
  if (!force && hasFocus()) {
    W.pendingRender = true;
    return;
  }
  W.pendingRender = false;
  if (!W.entity) {
    W.root.innerHTML = '<div class="wm-empty">Menunggu data device… Pastikan entity alias menunjuk ke device yang aktif.</div>';
    return;
  }
  W.root.classList.toggle('wm-wide', W.root.clientWidth > 720);
  const m = metrics();
  const html = {
    alerts: renderAlerts,
    live: renderLive,
    usage: renderUsage,
    setup: renderSetup,
    calibration: renderCalibration,
  }[W.view] || renderLive;
  if (W.view === 'setup' && W.setupDirty) return;
  W.root.innerHTML = html(m) + '<div class="wm-tip" hidden></div>';
}

function badge(level, text) {
  const s = STATUS[level] || STATUS.none;
  return '<span class="wm-badge" style="--c:' + s.color + '"><i>' + s.icon + '</i>' + esc(text || s.label) + '</span>';
}

function tile(label, value, sub, extra) {
  return '<div class="wm-tile"><div class="wm-tile-label">' + label + '</div>' +
    '<div class="wm-tile-value">' + value + '</div>' +
    (sub ? '<div class="wm-tile-sub">' + sub + '</div>' : '') + (extra || '') + '</div>';
}

function meter(pct, level) {
  const s = STATUS[level] || STATUS.none;
  const w = Math.max(0, Math.min(100, pct || 0));
  return '<div class="wm-meter"><span style="width:' + w + '%;background:' + s.color + '"></span></div>';
}

// --- alerts view ---

function renderAlerts(m) {
  const alerts = evalAlerts(m);
  trackAlerts(alerts);
  const count = (lv) => alerts.filter((a) => a.level === lv).length;
  const worst = count('critical') ? 'critical' : count('warning') ? 'warning' : 'good';
  let h = '<div class="wm-head">' +
    '<div class="wm-title">' + esc(W.entity.name) + ' ' +
    badge(m.online ? 'good' : 'critical', m.online ? 'Online' : 'Offline') +
    ' <span class="wm-muted">update ' + (m.lastTs ? ago(m.lastTs) : '—') + '</span></div>' +
    '<div class="wm-actions">' +
    '<label class="wm-check"><input type="checkbox" data-act="notify"' + (store('notify') ? ' checked' : '') + '> Notifikasi browser</label>' +
    '</div></div>';

  h += '<div class="wm-summary wm-summary-' + worst + '">' +
    badge(worst, worst === 'good' ? 'Semua normal' : count('critical') + ' kritis · ' + count('warning') + ' peringatan') +
    '<span class="wm-muted">Pemakaian hari ini ' + fmtL(m.usage) +
    (m.pct !== null ? ' · ' + fmtNum(m.pct, 0) + '% baseline' : '') + '</span></div>';

  if (alerts.length) {
    h += '<ul class="wm-alerts">' + alerts.map((a) =>
      '<li class="wm-alert" style="--c:' + STATUS[a.level].color + '">' +
      badge(a.level) + '<div><b>' + esc(a.title) + '</b><div class="wm-muted">' + esc(a.msg) + '</div></div></li>',
    ).join('') + '</ul>';
  }

  const sa = W.serverAlarms;
  h += '<div class="wm-sec">Alarm ThingsBoard (aktif)</div>';
  if (sa === null) {
    h += '<div class="wm-muted">Memuat…</div>';
  } else if (!sa.length) {
    h += '<div class="wm-muted">Tidak ada alarm aktif dari server. Alarm server muncul jika alarm rule Device Profile sudah dibuat (lihat README).</div>';
  } else {
    h += '<div class="wm-scroll"><table class="wm-table"><thead><tr><th>Waktu</th><th>Tipe</th><th>Severity</th><th>Status</th><th></th></tr></thead><tbody>' +
      sa.map((a) => {
        const lv = /CRITICAL|MAJOR/.test(a.severity) ? 'critical' : /MINOR|WARNING/.test(a.severity) ? 'warning' : 'info';
        const id = a.id && a.id.id;
        return '<tr><td>' + fmtTime(a.createdTime) + '</td><td>' + esc(a.type) + '</td><td>' + badge(lv, a.severity) +
          '</td><td>' + esc(a.status || '') + '</td><td class="wm-nowrap">' +
          (a.acknowledged ? '' : '<button class="wm-btn wm-btn-s" data-act="ack" data-id="' + esc(id) + '">Ack</button> ') +
          '<button class="wm-btn wm-btn-s" data-act="clear" data-id="' + esc(id) + '">Clear</button></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  const log = store('log') || [];
  if (log.length) {
    h += '<div class="wm-sec">Riwayat alert (browser ini) <button class="wm-link" data-act="clearlog">hapus</button></div>' +
      '<ul class="wm-log">' + log.slice(0, 10).map((l) =>
        '<li><span class="wm-dot" style="background:' + (STATUS[l.level] || STATUS.info).color + '"></span>' +
        fmtTime(l.ts) + ' — ' + esc(l.title) + '</li>').join('') + '</ul>';
  }
  return h;
}

// --- live view ---

function renderLive(m) {
  const c = m.c;
  const cap = num('tank_capacity_l', 0);
  const vol = num('tank_volume_l', 0);
  const levelSt = m.level === null ? 'none'
    : m.level < c.wm_tank_low_pct ? 'critical'
      : m.level > c.wm_tank_high_pct ? 'warning' : 'good';
  const rssi = num('rssi', null);

  let h = '<div class="wm-head"><div class="wm-title">' + esc(W.entity.name) + ' ' +
    badge(m.online ? 'good' : 'critical', m.online ? 'Online' : 'Offline') +
    ' <span class="wm-muted">update ' + (m.lastTs ? ago(m.lastTs) : '—') +
    ' · RSSI ' + (rssi === null ? '—' : rssi + ' dBm') +
    ' · uptime ' + fmtDur(num('uptime_s', 0)) + '</span></div>' +
    (m.cal !== 1 ? '<span class="wm-muted">Kalibrasi flow ×' + fmtNum(m.cal, 4) + '</span>' : '') + '</div>';

  h += '<div class="wm-tiles">';
  h += tile('Pemakaian hari ini', fmtL(m.usage),
    m.pct !== null
      ? badge(m.status, fmtNum(m.pct, 0) + '% baseline') + ' <span class="wm-muted">dari ' + fmtL(m.bDayL) + '</span>'
      : '<span class="wm-muted">Baseline belum di-setup</span>',
    (m.pct !== null ? meter(m.pct, m.status) : '') +
    (m.projected !== null ? '<div class="wm-tile-sub wm-muted">Proyeksi akhir hari: ' + fmtL(m.projected) + '</div>' : ''));
  h += tile('Biaya hari ini', fmtRp(m.cost),
    m.costRoom !== null
      ? fmtRp(m.costRoom) + '/kamar <span class="wm-muted">· baseline ' + fmtRp(c.wm_baseline_cost_room_day) + '</span>'
      : '<span class="wm-muted">Tarif ' + fmtRp(c.wm_tariff_m3) + '/m³</span>');
  h += tile('Per kamar terisi', m.lRoom !== null ? fmtL(m.lRoom) : '—',
    '<span class="wm-muted">baseline ' + fmtL(m.bRoomL) + '/kamar/hari</span>',
    '<div class="wm-tile-sub">' + fmtNum(m.occ.rooms, 0) + (c.wm_rooms_total ? ' / ' + fmtNum(c.wm_rooms_total, 0) : '') +
    ' kamar terisi' + (c.wm_rooms_total ? ' (' + fmtNum((m.occ.rooms / c.wm_rooms_total) * 100, 0) + '%)' : '') + '</div>');
  h += tile('Flow sekarang', fmtNum(m.flow, 1) + ' <small>L/menit</small>',
    '<span class="wm-muted">Meter total ' + fmtL(m.total) + ' · mode ' + num('flow_mode', 0) + '</span>');
  h += '<div class="wm-tile wm-tank-tile"><div><div class="wm-tile-label">Tangki</div>' +
    '<div class="wm-tile-value">' + (m.level === null ? '—' : fmtNum(m.level, 1) + '%') + '</div>' +
    '<div class="wm-tile-sub">' + fmtL(vol) + ' / ' + fmtL(cap) + '</div>' +
    '<div class="wm-tile-sub">' + badge(levelSt, levelSt === 'critical' ? 'Rendah' : levelSt === 'warning' ? 'Tinggi' : null) +
    ' <span class="wm-muted">jarak ' + fmtNum(num('tank_dist_cm', 0), 0) + ' cm</span></div></div>' +
    '<div class="wm-tank"><span style="height:' + Math.max(0, Math.min(100, m.level || 0)) + '%;background:' +
    (levelSt === 'good' ? SERIES : STATUS[levelSt].color) + '"></span></div></div>';
  h += tile('Pompa', badge(m.pumpOn ? 'info' : 'none', m.pumpOn ? 'ON' : 'OFF'),
    (m.pumpOn ? 'Sesi ' + fmtDur(num('pump_session_s', 0)) + ' · ' : '') +
    'Hari ini ' + fmtDur(num('pump_runtime_today_s', 0)) + ', ' + num('pump_starts_today', 0) + '× start',
    '<div class="wm-tile-sub wm-muted">Terakhir ' + fmtDur(num('pump_last_run_s', 0)) +
    ' · total ' + fmtDur(num('pump_runtime_total_s', 0)) + ', ' + num('pump_starts_total', 0) + '×</div>');
  h += '</div>';

  const ch = W.chart24;
  const width = Math.max(260, (W.root.clientWidth || 600) / (W.root.classList.contains('wm-wide') ? 2 : 1) - 24);
  h += '<div class="wm-charts">';
  h += '<div class="wm-chart"><div class="wm-sec">Level tangki 24 jam (%)</div>' +
    (ch ? lineChart(ch.level, { width, yMin: 0, yMax: 100, unit: '%', refs: [
      { v: c.wm_tank_low_pct, label: 'batas rendah ' + c.wm_tank_low_pct + '%' },
    ] }) : '<div class="wm-muted">Memuat…</div>') + '</div>';
  const flow = ch ? ch.flow.map((p) => [p[0], p[1] * m.cal]) : null;
  h += '<div class="wm-chart"><div class="wm-sec">Flow 24 jam (L/menit, maks per 15 menit)</div>' +
    (ch ? lineChart(flow, { width, yMin: 0, unit: ' L/menit' }) : '<div class="wm-muted">Memuat…</div>') + '</div>';
  h += '</div>';
  return h;
}

// --- usage view ---

function usageRows(m) {
  const c = m.c;
  const days = W.daily || {};
  const keys = Object.keys(days).sort();
  const cal = m.cal;
  const bRoomL = m.bRoomL;
  let prevTotal = null;
  return keys.map((d) => {
    const r = days[d];
    let raw = r.flow_today_l;
    if (d === m.today && W.latest.flow_today_l) raw = num('flow_today_l', raw);
    if (raw === undefined && r.flow_total_l !== undefined && prevTotal !== null && r.flow_total_l >= prevTotal) {
      raw = r.flow_total_l - prevTotal; // cadangan bila counter harian tidak ada
    }
    if (r.flow_total_l !== undefined) prevTotal = r.flow_total_l;
    const liters = raw === undefined ? null : raw * cal;
    const occ = occupancyFor(c, d);
    const rooms = occ.rooms;
    const cost = liters === null ? null : (liters / 1000) * c.wm_tariff_m3;
    const lRoom = liters !== null && rooms > 0 ? liters / rooms : null;
    const costRoom = cost !== null && rooms > 0 ? cost / rooms : null;
    const pct = lRoom !== null && bRoomL > 0 ? (lRoom / bRoomL) * 100 : null;
    let runtime = r.pump_runtime_today_s;
    let starts = r.pump_starts_today;
    if (d === m.today) {
      runtime = num('pump_runtime_today_s', runtime);
      starts = num('pump_starts_today', starts);
    }
    return {
      day: d, liters, rooms, occDefault: occ.isDefault, cost, lRoom, costRoom, pct,
      status: usageStatus(pct, c), runtime, starts, isToday: d === m.today,
    };
  });
}

function renderUsage(m) {
  const c = m.c;
  let h = '<div class="wm-head"><div class="wm-title">Pemakaian harian · ' + esc(W.entity.name) + '</div>' +
    '<div class="wm-actions">' +
    [7, 14, 30].map((n) => '<button class="wm-btn wm-btn-s' + (W.range === n ? ' wm-on' : '') +
      '" data-act="range" data-n="' + n + '">' + n + ' hari</button>').join('') +
    '<button class="wm-btn wm-btn-s" data-act="refresh">↻</button>' +
    '<button class="wm-btn wm-btn-s" data-act="csv">CSV</button></div></div>';

  if (!W.daily) return h + '<div class="wm-muted">Memuat riwayat…</div>';
  if (W.dailyErr) h += '<div class="wm-error">Gagal memuat riwayat: ' + esc(W.dailyErr) + '</div>';

  const rows = usageRows(m);
  W.rows = rows;
  const withData = rows.filter((r) => r.liters !== null);
  const sum = (f) => withData.reduce((a, r) => a + (r[f] || 0), 0);
  const totalL = sum('liters');
  const totalCost = sum('cost');
  const roomDays = withData.reduce((a, r) => a + (r.rooms > 0 ? r.rooms : 0), 0);
  const avgRoomL = roomDays > 0 ? totalL / roomDays : null;
  const avgPct = avgRoomL !== null && m.bRoomL > 0 ? (avgRoomL / m.bRoomL) * 100 : null;
  const over = rows.filter((r) => r.status === 'critical').length;

  h += '<div class="wm-tiles">' +
    tile('Total ' + W.range + ' hari', fmtL(totalL), fmtNum(totalL / 1000, 2) + ' m³') +
    tile('Total biaya', fmtRp(totalCost), 'Tarif ' + fmtRp(c.wm_tariff_m3) + '/m³') +
    tile('Rata-rata per kamar/hari', avgRoomL === null ? '—' : fmtL(avgRoomL),
      avgPct === null ? '<span class="wm-muted">Baseline belum di-setup</span>'
        : badge(usageStatus(avgPct, c), fmtNum(avgPct, 0) + '% baseline') +
          ' <span class="wm-muted">' + fmtRp(roomDays > 0 ? totalCost / roomDays : 0) + '/kamar/hari</span>') +
    tile('Hari melebihi baseline', String(over), '<span class="wm-muted">dari ' + withData.length + ' hari ber-data</span>') +
    '</div>';

  const width = Math.max(280, (W.root.clientWidth || 700) - 24);
  h += '<div class="wm-chart"><div class="wm-sec">Liter per kamar per hari vs baseline</div>' +
    barChart(rows, m.bRoomL, width) +
    '<div class="wm-legend"><span><i style="background:' + SERIES + '"></i>Liter/kamar</span>' +
    '<span><i class="wm-dash"></i>Baseline ' + fmtL(m.bRoomL) + '/kamar</span>' +
    '<span>' + badge('warning', '≥ ' + c.wm_warn_pct + '%') + '</span><span>' + badge('critical', '≥ 100%') + '</span></div></div>';

  h += '<div class="wm-scroll"><table class="wm-table"><thead><tr>' +
    '<th>Tanggal</th><th class="r">Kamar terisi</th><th class="r">Pemakaian</th><th class="r">L/kamar</th>' +
    '<th class="r">Biaya</th><th class="r">Biaya/kamar</th><th>vs Baseline</th><th class="r">Pompa</th></tr></thead><tbody>';
  rows.slice().reverse().forEach((r) => {
    h += '<tr' + (r.isToday ? ' class="wm-today"' : '') + '><td class="wm-nowrap">' + fmtDay(r.day) + (r.isToday ? ' <small>(hari ini)</small>' : '') + '</td>' +
      '<td class="r"><input class="wm-occ' + (r.occDefault ? ' wm-default' : '') + '" type="number" min="0" step="1" data-day="' + r.day +
      '" value="' + (r.rooms || 0) + '" title="' + (r.occDefault ? 'Belum diisi, memakai nilai default. ' : '') + 'Ubah lalu tekan Enter"></td>' +
      '<td class="r">' + (r.liters === null ? '—' : fmtL(r.liters)) + '</td>' +
      '<td class="r">' + (r.lRoom === null ? '—' : fmtL(r.lRoom)) + '</td>' +
      '<td class="r">' + (r.cost === null ? '—' : fmtRp(r.cost)) + '</td>' +
      '<td class="r">' + (r.costRoom === null ? '—' : fmtRp(r.costRoom)) + '</td>' +
      '<td>' + (r.pct === null ? '<span class="wm-muted">—</span>' : badge(r.status, fmtNum(r.pct, 0) + '%')) + '</td>' +
      '<td class="r wm-nowrap">' + (r.runtime === undefined ? '—' : fmtDur(r.runtime) + ' · ' + (r.starts || 0) + '×') + '</td></tr>';
  });
  h += '</tbody><tfoot><tr><td>Total / rata-rata</td><td class="r">' + fmtNum(roomDays, 0) + ' kamar·hari</td>' +
    '<td class="r">' + fmtL(totalL) + '</td><td class="r">' + (avgRoomL === null ? '—' : fmtL(avgRoomL)) + '</td>' +
    '<td class="r">' + fmtRp(totalCost) + '</td><td class="r">' + (roomDays > 0 ? fmtRp(totalCost / roomDays) : '—') + '</td>' +
    '<td>' + (avgPct === null ? '' : badge(usageStatus(avgPct, c), fmtNum(avgPct, 0) + '%')) + '</td><td></td></tr></tfoot></table></div>' +
    '<div class="wm-note">Kolom “Kamar terisi” bisa diedit per hari (Enter untuk simpan). Angka abu-abu miring = belum diisi dan memakai jumlah kamar terisi default dari Setup. ' +
    'Pemakaian = MAX harian <code>flow_today_l</code> × faktor kalibrasi ' + fmtNum(m.cal, 4) + '.</div>';
  return h;
}

function exportCsv() {
  const rows = W.rows || [];
  const lines = [['tanggal', 'kamar_terisi', 'pemakaian_l', 'l_per_kamar', 'biaya_rp', 'biaya_per_kamar_rp', 'persen_baseline', 'pompa_runtime_s', 'pompa_start']];
  rows.forEach((r) => lines.push([
    r.day, r.rooms, opt(r.liters, 2), opt(r.lRoom, 2), opt(r.cost, 0), opt(r.costRoom, 0), opt(r.pct, 1),
    r.runtime === undefined ? '' : r.runtime, r.starts === undefined ? '' : r.starts,
  ]));
  const blob = new Blob([lines.map((l) => l.join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'pemakaian-air-' + (W.entity.name || 'device').replace(/[^\w-]+/g, '_') + '-' + dayKey(Date.now()) + '.csv';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

function saveOccupancy(day, rooms) {
  const c = cfg();
  const log = Object.assign({}, c.occLog);
  log[day] = rooms;
  // Simpan 120 hari terakhir saja agar atribut tidak membengkak.
  const keep = Object.keys(log).sort().slice(-120);
  const trimmed = {};
  keep.forEach((k) => (trimmed[k] = log[k]));
  c.occLog = trimmed;
  const values = { wm_occ_log: JSON.stringify(trimmed) };
  if (day === dayKey(Date.now())) {
    values.wm_rooms_occupied = rooms;
    c.wm_rooms_occupied = rooms;
  }
  Object.assign(values, derivedAttrs(c));
  saveAttrs(values, 'Okupansi ' + fmtDay(day) + ' = ' + rooms + ' kamar');
}

// --- setup view ---

const SETUP_FIELDS = [
  ['Kamar & okupansi', [
    ['wm_rooms_total', 'Jumlah kamar total', 'kamar', 1],
    ['wm_rooms_occupied', 'Kamar terisi hari ini', 'kamar', 1],
  ]],
  ['Tarif & baseline', [
    ['wm_tariff_m3', 'Tarif air', 'Rp/m³', 1],
    ['wm_baseline_cost_room_day', 'Baseline biaya air', 'Rp/kamar/hari', 1],
    ['wm_warn_pct', 'Peringatan mulai', '% baseline', 1],
  ]],
  ['Ambang alert lain', [
    ['wm_tank_low_pct', 'Level tangki rendah', '%', 1],
    ['wm_tank_high_pct', 'Level tangki tinggi', '%', 1],
    ['wm_leak_min', 'Flow tanpa henti (bocor)', 'menit', 1],
    ['wm_pump_max_min', 'Sesi pompa maksimum', 'menit', 1],
    ['wm_pump_starts_max', 'Start pompa maksimum', '×/hari', 1],
    ['wm_offline_min', 'Offline jika tak ada data', 'menit', 1],
    ['wm_rssi_min', 'RSSI minimum', 'dBm', 1],
  ]],
];

function renderSetup(m) {
  const c = m.c;
  let h = '<form class="wm-form" data-form="setup" onsubmit="return false">';
  SETUP_FIELDS.forEach((g) => {
    h += '<fieldset><legend>' + g[0] + '</legend>';
    g[1].forEach((f) => {
      h += '<label><span>' + f[1] + '</span><span class="wm-in"><input type="number" step="any" name="' + f[0] +
        '" value="' + c[f[0]] + '"><em>' + f[2] + '</em></span></label>';
    });
    h += '</fieldset>';
  });
  h += '<div class="wm-preview" data-preview>' + setupPreview(c) + '</div>' +
    '<div class="wm-actions"><button class="wm-btn wm-primary" data-act="save-setup">Simpan setup</button>' +
    '<button class="wm-btn" data-act="reset-setup">Batal</button></div></form>';
  return h;
}

function readSetupForm() {
  const c = cfg();
  W.root.querySelectorAll('[data-form="setup"] input[name]').forEach((el) => {
    const v = parseFloat(el.value);
    c[el.name] = isNaN(v) ? CFG_DEFAULTS[el.name] : v;
  });
  return c;
}

function setupPreview(c) {
  const roomL = baselineRoomL(c);
  const occ = c.wm_rooms_occupied;
  const d = derivedAttrs(Object.assign({}, c, { occLog: {} }));
  return '<b>Baseline</b>: ' + fmtRp(c.wm_baseline_cost_room_day) + ' ÷ ' + fmtRp(c.wm_tariff_m3) + '/m³ = <b>' +
    fmtL(roomL) + '/kamar/hari</b>' +
    '<br>Hari ini: ' + fmtNum(occ, 0) + ' kamar × ' + fmtL(roomL) + ' = <b>' + fmtL(roomL * occ) + '</b> (' +
    fmtRp(c.wm_baseline_cost_room_day * occ) + ')' +
    '<br><span class="wm-muted">Peringatan di ' + fmtL((roomL * occ * c.wm_warn_pct) / 100) +
    ' · threshold alarm server (mentah): ' + fmtNum(d.wm_baseline_day_raw_l, 1) + ' L</span>';
}

function saveSetup() {
  const c = readSetupForm();
  const errs = [];
  if (c.wm_rooms_total < 0 || c.wm_rooms_occupied < 0) errs.push('jumlah kamar tidak boleh negatif');
  if (c.wm_rooms_total > 0 && c.wm_rooms_occupied > c.wm_rooms_total) errs.push('kamar terisi melebihi kamar total');
  if (c.wm_tariff_m3 < 0 || c.wm_baseline_cost_room_day < 0) errs.push('tarif/baseline tidak boleh negatif');
  if (c.wm_warn_pct <= 0 || c.wm_warn_pct > 100) errs.push('persen peringatan harus 1–100');
  if (errs.length) {
    toast('Periksa: ' + errs.join(', '), true);
    return;
  }
  const values = {};
  SETUP_FIELDS.forEach((g) => g[1].forEach((f) => (values[f[0]] = c[f[0]])));
  const today = dayKey(Date.now());
  const log = Object.assign({}, c.occLog);
  log[today] = c.wm_rooms_occupied;
  c.occLog = log;
  values.wm_occ_log = JSON.stringify(log);
  Object.assign(values, derivedAttrs(c));
  saveAttrs(values, 'Setup tersimpan', (ok) => {
    if (ok) {
      W.setupDirty = false;
      render(true);
    }
  });
}

// --- calibration view ---

function renderCalibration(m) {
  const c = m.c;
  const raw = num('flow_total_l', null);
  const rawTs = W.latest.flow_total_l ? W.latest.flow_total_l.ts : 0;
  const run = store('cal');
  let h = '<div class="wm-cal-grid">';

  h += '<div class="wm-card"><div class="wm-sec">Faktor kalibrasi aktif</div>' +
    '<div class="wm-big">×' + fmtNum(c.wm_cal_factor, 4) + '</div>' +
    '<div class="wm-muted">Nilai tampilan = nilai sensor × faktor. Dipakai untuk flow, pemakaian, biaya & threshold alarm.</div>' +
    '<div class="wm-row"><input type="number" step="0.0001" min="0.1" max="10" data-input="cal-direct" value="' + c.wm_cal_factor + '">' +
    '<button class="wm-btn" data-act="cal-direct">Set manual</button>' +
    '<button class="wm-btn" data-act="cal-reset">Reset ke 1</button></div></div>';

  h += '<div class="wm-card"><div class="wm-sec">Metode 1 — Uji ember (volume diketahui)</div>' +
    '<ol class="wm-steps"><li>Tutup semua keran lain, pastikan flow 0.</li>' +
    '<li>Tekan <b>Mulai</b>, lalu alirkan air ke wadah bervolume pasti (mis. ember 20 L, makin besar makin akurat).</li>' +
    '<li>Tutup keran, tunggu pembacaan sensor ter-update, isi volume aktual lalu tekan <b>Hitung</b>.</li></ol>' +
    '<div class="wm-muted">Pembacaan sensor sekarang: <b>' + (raw === null ? '—' : fmtNum(raw, 2) + ' L') +
    '</b> (mentah, ' + (rawTs ? ago(rawTs) : '—') + ') · flow ' + fmtNum(num('flow_lpm', 0), 2) + ' L/menit</div>';
  if (!run) {
    h += '<div class="wm-row"><button class="wm-btn wm-primary" data-act="cal-start"' + (raw === null ? ' disabled' : '') + '>Mulai</button></div>';
  } else {
    const delta = raw === null ? 0 : raw - run.startRaw;
    h += '<div class="wm-run">Berjalan sejak ' + fmtTime(run.startTs) + ' · awal ' + fmtNum(run.startRaw, 2) +
      ' L · terukur sensor <b>' + fmtNum(delta, 2) + ' L</b></div>' +
      '<div class="wm-row"><label>Volume aktual <input type="number" step="0.01" min="0" data-input="cal-actual" placeholder="L"></label>' +
      '<button class="wm-btn wm-primary" data-act="cal-finish">Hitung</button>' +
      '<button class="wm-btn" data-act="cal-cancel">Batal</button></div>';
  }
  h += '<div data-cal-result></div></div>';

  h += '<div class="wm-card"><div class="wm-sec">Metode 2 — Bandingkan dengan meter PDAM</div>' +
    '<div class="wm-muted">Catat selisih meter PDAM dan selisih <code>flow_total_l</code> mentah pada periode yang sama (mis. 1–7 hari).</div>' +
    '<div class="wm-row"><label>Sensor (mentah) <input type="number" step="0.01" min="0" data-input="cal-m-sensor" placeholder="L"></label>' +
    '<label>Meter PDAM <input type="number" step="0.01" min="0" data-input="cal-m-meter" placeholder="L"></label>' +
    '<button class="wm-btn wm-primary" data-act="cal-manual">Hitung</button></div><div data-cal-result-m></div></div>';

  h += '<div class="wm-card"><div class="wm-sec">Riwayat kalibrasi</div>';
  if (!c.calLog.length) {
    h += '<div class="wm-muted">Belum ada.</div>';
  } else {
    h += '<div class="wm-scroll"><table class="wm-table"><thead><tr><th>Waktu</th><th>Metode</th><th class="r">Sensor</th><th class="r">Aktual</th><th class="r">Faktor</th></tr></thead><tbody>' +
      c.calLog.slice().reverse().map((l) => '<tr><td>' + fmtTime(l.ts) + '</td><td>' + esc(l.method) + '</td><td class="r">' +
        (l.sensor === undefined ? '—' : fmtNum(l.sensor, 2)) + '</td><td class="r">' + (l.actual === undefined ? '—' : fmtNum(l.actual, 2)) +
        '</td><td class="r">×' + fmtNum(l.factor, 4) + '</td></tr>').join('') + '</tbody></table></div>';
  }
  h += '</div></div>';
  return h;
}

// Faktor baru dihitung dari pembacaan MENTAH sensor, jadi menggantikan
// faktor lama (bukan dikalikan).
function proposeFactor(sensorRaw, actual, method, target) {
  const box = W.root.querySelector(target);
  if (!(sensorRaw > 0) || !(actual > 0)) {
    toast('Isi volume sensor dan aktual (> 0)', true);
    return;
  }
  const f = actual / sensorRaw;
  const err = (sensorRaw / actual - 1) * 100;
  const warn = [];
  if (sensorRaw < 5) warn.push('volume uji < 5 L, hasil kurang akurat');
  if (f < 0.5 || f > 2) warn.push('faktor di luar 0,5–2: cek sensor/pemasangan');
  W.proposal = { factor: f, sensor: sensorRaw, actual, method };
  box.innerHTML = '<div class="wm-proposal">Sensor ' + fmtNum(sensorRaw, 2) + ' L vs aktual ' + fmtNum(actual, 2) +
    ' L → error sensor ' + (err >= 0 ? '+' : '') + fmtNum(err, 1) + '%<br>Faktor baru <b>×' + fmtNum(f, 4) + '</b>' +
    (warn.length ? '<div class="wm-error">' + warn.join('; ') + '</div>' : '') +
    '<div class="wm-row"><button class="wm-btn wm-primary" data-act="cal-apply">Terapkan</button></div></div>';
}

function applyFactor(f, entry) {
  const c = cfg();
  c.wm_cal_factor = f;
  const log = c.calLog.concat([Object.assign({ ts: Date.now(), factor: round(f, 6) }, entry || {})]).slice(-10);
  const values = Object.assign({ wm_cal_factor: round(f, 6), wm_cal_log: JSON.stringify(log) }, derivedAttrs(c));
  saveAttrs(values, 'Faktor kalibrasi ×' + fmtNum(f, 4) + ' diterapkan', (ok) => {
    if (ok) {
      store('cal', null);
      W.proposal = null;
    }
  });
}

// ------------------------------------------------------------- events -----

function handleClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT') return;
  const act = el.getAttribute('data-act');
  const val = (sel) => {
    const x = W.root.querySelector('[data-input="' + sel + '"]');
    return x ? parseFloat(x.value) : NaN;
  };
  switch (act) {
    case 'range':
      W.range = parseInt(el.getAttribute('data-n'), 10);
      W.daily = null;
      render();
      fetchDaily();
      break;
    case 'refresh':
      fetchDaily();
      break;
    case 'csv':
      exportCsv();
      break;
    case 'save-setup':
      saveSetup();
      break;
    case 'reset-setup':
      W.setupDirty = false;
      render(true);
      break;
    case 'ack':
    case 'clear':
      api('post', '/api/alarm/' + el.getAttribute('data-id') + '/' + act, null, () => {
        toast(act === 'ack' ? 'Alarm di-acknowledge' : 'Alarm di-clear');
        fetchServerAlarms();
      });
      break;
    case 'clearlog':
      store('log', []);
      render();
      break;
    case 'cal-start':
      store('cal', { startRaw: num('flow_total_l', 0), startTs: Date.now() });
      render(true);
      break;
    case 'cal-cancel':
      store('cal', null);
      render(true);
      break;
    case 'cal-finish': {
      const run = store('cal');
      proposeFactor(num('flow_total_l', 0) - (run ? run.startRaw : 0), val('cal-actual'), 'uji ember', '[data-cal-result]');
      break;
    }
    case 'cal-manual':
      proposeFactor(val('cal-m-sensor'), val('cal-m-meter'), 'meter PDAM', '[data-cal-result-m]');
      break;
    case 'cal-apply':
      if (W.proposal) {
        applyFactor(W.proposal.factor, { method: W.proposal.method, sensor: round(W.proposal.sensor, 2), actual: round(W.proposal.actual, 2) });
      }
      break;
    case 'cal-direct': {
      const f = val('cal-direct');
      if (!(f >= 0.1 && f <= 10)) toast('Faktor harus 0,1–10', true);
      else applyFactor(f, { method: 'manual' });
      break;
    }
    case 'cal-reset':
      applyFactor(1, { method: 'reset' });
      break;
  }
}

function handleChange(e) {
  const t = e.target;
  if (t.matches('[data-act="notify"]')) {
    if (t.checked && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    store('notify', t.checked);
  } else if (t.classList.contains('wm-occ')) {
    const v = parseInt(t.value, 10);
    const c = cfg();
    if (isNaN(v) || v < 0 || (c.wm_rooms_total > 0 && v > c.wm_rooms_total)) {
      toast('Jumlah kamar tidak valid (0–' + (c.wm_rooms_total || '∞') + ')', true);
      return;
    }
    saveOccupancy(t.getAttribute('data-day'), v);
  }
}

function handleInput(e) {
  const form = e.target.closest('[data-form="setup"]');
  if (form) {
    W.setupDirty = true;
    const p = W.root.querySelector('[data-preview]');
    if (p) p.innerHTML = setupPreview(readSetupForm());
  }
}

// -------------------------------------------------------------- charts ----

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function lineChart(points, o) {
  if (!points || !points.length) return '<div class="wm-muted">Tidak ada data 24 jam terakhir.</div>';
  const w = o.width;
  const hgt = 150;
  const pad = { l: 36, r: 8, t: 8, b: 20 };
  const end = Date.now();
  const start = end - DAY_MS;
  const yMax = o.yMax !== undefined ? o.yMax : niceMax(Math.max.apply(null, points.map((p) => p[1])));
  const yMin = o.yMin || 0;
  const x = (t) => pad.l + ((t - start) / (end - start)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (hgt - pad.t - pad.b);
  let s = '<svg class="wm-svg" width="' + w + '" height="' + hgt + '" viewBox="0 0 ' + w + ' ' + hgt + '">';
  for (let i = 0; i <= 4; i++) {
    const v = yMin + ((yMax - yMin) * i) / 4;
    s += '<line class="wm-grid" x1="' + pad.l + '" x2="' + (w - pad.r) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>' +
      '<text class="wm-axis" x="' + (pad.l - 4) + '" y="' + (y(v) + 3) + '" text-anchor="end">' + fmtNum(v, v < 10 && v % 1 ? 1 : 0) + '</text>';
  }
  for (let hAgo = 24; hAgo >= 0; hAgo -= 6) {
    const t = end - hAgo * 3600000;
    const anchor = hAgo === 24 ? 'start' : hAgo === 0 ? 'end' : 'middle';
    s += '<text class="wm-axis" x="' + x(t) + '" y="' + (hgt - 4) + '" text-anchor="' + anchor + '">' + fmtHm(t) + '</text>';
  }
  (o.refs || []).forEach((r) => {
    s += '<line class="wm-ref" x1="' + pad.l + '" x2="' + (w - pad.r) + '" y1="' + y(r.v) + '" y2="' + y(r.v) + '"/>' +
      '<text class="wm-axis" x="' + (w - pad.r) + '" y="' + (y(r.v) - 4) + '" text-anchor="end">' + esc(r.label) + '</text>';
  });
  const d = points.map((p, i) => (i ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1)).join(' ');
  s += '<path d="' + d + '" fill="none" stroke="' + SERIES + '" stroke-width="2" stroke-linejoin="round"/>';
  const last = points[points.length - 1];
  s += '<circle cx="' + x(last[0]) + '" cy="' + y(last[1]) + '" r="4" fill="' + SERIES + '" stroke="#fff" stroke-width="2"/>';
  // Area hover per titik (lebih lebar dari mark).
  const colW = (w - pad.l - pad.r) / Math.max(points.length, 1);
  points.forEach((p) => {
    s += '<rect class="wm-hit" x="' + (x(p[0]) - colW / 2) + '" y="' + pad.t + '" width="' + colW + '" height="' + (hgt - pad.t - pad.b) +
      '" data-tip="' + esc(fmtHm(p[0]) + ' — ' + fmtNum(p[1], 1) + o.unit) + '" data-x="' + x(p[0]) + '"/>';
  });
  return s + '</svg>';
}

function barChart(rows, baseline, w) {
  if (!rows.length) return '<div class="wm-muted">Tidak ada data.</div>';
  const hgt = 170;
  const pad = { l: 40, r: 8, t: 10, b: 22 };
  const vals = rows.map((r) => r.lRoom || 0);
  const yMax = niceMax(Math.max(baseline * 1.15, Math.max.apply(null, vals)));
  const y = (v) => pad.t + (1 - v / yMax) * (hgt - pad.t - pad.b);
  const slot = (w - pad.l - pad.r) / rows.length;
  const bw = Math.max(3, Math.min(28, slot - 2));
  let s = '<svg class="wm-svg" width="' + w + '" height="' + hgt + '" viewBox="0 0 ' + w + ' ' + hgt + '">';
  for (let i = 0; i <= 4; i++) {
    const v = (yMax * i) / 4;
    s += '<line class="wm-grid" x1="' + pad.l + '" x2="' + (w - pad.r) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>' +
      '<text class="wm-axis" x="' + (pad.l - 4) + '" y="' + (y(v) + 3) + '" text-anchor="end">' + fmtNum(v, 0) + '</text>';
  }
  const every = Math.ceil(rows.length / 10);
  rows.forEach((r, i) => {
    const cx = pad.l + slot * i + slot / 2;
    if (r.lRoom !== null) {
      const top = y(r.lRoom);
      const bh = Math.max(1, y(0) - top);
      const color = r.status === 'critical' || r.status === 'warning' ? STATUS[r.status].color : SERIES;
      const rad = Math.min(4, bw / 2, bh);
      // Ujung data membulat 4px, menempel ke baseline (0).
      s += '<path d="M' + (cx - bw / 2) + ' ' + y(0) + 'V' + (top + rad) + 'Q' + (cx - bw / 2) + ' ' + top + ' ' + (cx - bw / 2 + rad) + ' ' + top +
        'H' + (cx + bw / 2 - rad) + 'Q' + (cx + bw / 2) + ' ' + top + ' ' + (cx + bw / 2) + ' ' + (top + rad) + 'V' + y(0) + 'Z" fill="' + color + '"/>';
    }
    s += '<rect class="wm-hit" x="' + (pad.l + slot * i) + '" y="' + pad.t + '" width="' + slot + '" height="' + (hgt - pad.t - pad.b) +
      '" data-tip="' + esc(fmtDay(r.day) + ': ' + (r.lRoom === null ? 'tidak ada data'
        : fmtL(r.lRoom) + '/kamar · ' + fmtNum(r.rooms, 0) + ' kamar · ' + fmtL(r.liters) + (r.pct === null ? '' : ' · ' + fmtNum(r.pct, 0) + '% baseline'))) + '"/>';
    if (i % every === 0 || i === rows.length - 1) {
      s += '<text class="wm-axis" x="' + cx + '" y="' + (hgt - 6) + '" text-anchor="middle">' + r.day.slice(8) + '/' + r.day.slice(5, 7) + '</text>';
    }
  });
  if (baseline > 0) {
    s += '<line class="wm-ref" x1="' + pad.l + '" x2="' + (w - pad.r) + '" y1="' + y(baseline) + '" y2="' + y(baseline) + '"/>';
  }
  return s + '</svg>';
}

function handleTip(e) {
  const tip = W.root.querySelector('.wm-tip');
  if (!tip) return;
  const hit = e.target.closest && e.target.closest('[data-tip]');
  if (!hit) {
    tip.hidden = true;
    return;
  }
  const box = W.root.getBoundingClientRect();
  tip.textContent = hit.getAttribute('data-tip');
  tip.hidden = false;
  const left = Math.min(e.clientX - box.left + 12, box.width - tip.offsetWidth - 4);
  tip.style.left = Math.max(4, left) + 'px';
  tip.style.top = e.clientY - box.top + W.root.scrollTop - tip.offsetHeight - 8 + 'px';
}

function hideTip() {
  const tip = W && W.root.querySelector('.wm-tip');
  if (tip) tip.hidden = true;
}

// ------------------------------------------------------------- format -----

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function fmtDay(key) {
  const p = key.split('-');
  const d = new Date(+p[0], +p[1] - 1, +p[2]);
  return HARI[d.getDay()] + ' ' + p[2] + '/' + p[1];
}

function fmtHm(ts) {
  const d = new Date(ts);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function fmtTime(ts) {
  const d = new Date(ts);
  return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + ' ' + fmtHm(ts);
}

function fmtNum(n, dec) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toLocaleString('id-ID', { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 });
}

function fmtL(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return fmtNum(n, Math.abs(n) < 100 ? 1 : 0) + ' L';
}

function fmtRp(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return 'Rp' + fmtNum(Math.round(n), 0);
}

function fmtDur(s) {
  s = Math.max(0, Math.round(s || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return d + 'h ' + h + 'j';
  if (h) return h + 'j ' + m + 'm';
  if (m) return m + 'm ' + (s % 60) + 'd';
  return s + 'd';
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + ' dtk lalu';
  if (s < 3600) return Math.floor(s / 60) + ' mnt lalu';
  if (s < 86400) return Math.floor(s / 3600) + ' jam lalu';
  return Math.floor(s / 86400) + ' hari lalu';
}

function round(n, dec) {
  const p = Math.pow(10, dec);
  return Math.round(n * p) / p;
}

function opt(n, dec) {
  return n === null || n === undefined ? '' : round(n, dec);
}

function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}
