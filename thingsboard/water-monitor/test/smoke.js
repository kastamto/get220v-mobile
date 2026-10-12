#!/usr/bin/env node
// Smoke test: jalankan widget (src/widget.html|css|js) di Chromium dengan
// ctx ThingsBoard tiruan, dibungkus persis seperti ThingsBoard 4.2
// (widget-component.service.ts), lalu uji semua tab dan simpan screenshot
// ke test/out/.
//
//   node thingsboard/water-monitor/test/smoke.js

const path = require('path');
const fs = require('fs');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  ({ chromium } = require(path.join(process.execPath, '../../lib/node_modules/playwright')));
}

const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

// Contoh telemetry dari device (flow_today_l dinaikkan agar alert baseline terlihat).
const TELEMETRY = {
  alarm_level_high: 0, alarm_level_low: 0, evt: 0, flow_lpm: 0, flow_mode: 0,
  flow_today_l: 3100, flow_total_l: 618.12, pump_last_run_s: 76,
  pump_runtime_today_s: 0, pump_runtime_total_s: 1029, pump_session_s: 0,
  pump_starts_today: 0, pump_starts_total: 199, pump_state: 0, rssi: -73,
  secs_today: 30520, tank_capacity_l: 2000, tank_dist_cm: 28,
  tank_level_pct: 94.3, tank_volume_l: 1887, uptime_s: 244841,
};
const ATTRS = {
  wm_rooms_total: 20, wm_rooms_occupied: 18, wm_tariff_m3: 12000,
  wm_baseline_cost_room_day: 2000, wm_warn_pct: 80,
};

const page = (opts) => `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#eee;font-family:Roboto,Arial,sans-serif}
.box{background:#fff;margin:10px;box-shadow:0 1px 3px rgba(0,0,0,.2);overflow:hidden}
.body{padding:8px}
${read('widget.css')}
</style></head><body>
<script>
const SCRIPT = ${JSON.stringify(read('widget.js'))};
const TEMPLATE = ${JSON.stringify(read('widget.html'))};
const TELEMETRY = ${JSON.stringify(TELEMETRY)};
const OPTS = ${JSON.stringify(opts)};
window.ATTRS = ${JSON.stringify(ATTRS)};
window.POSTS = [];
window.TOASTS = [];
const now = Date.now();
const obs = (fn) => ({ subscribe: (next, err) => setTimeout(() => { let r; try { r = fn(); } catch (e) { err && err(e); return; } next(r); }, 5) });
function series(start, end, step, f) {
  const out = [];
  for (let t = start; t <= end; t += step) out.push({ ts: t + step / 2, value: String(f(t)) });
  return out;
}
const http = {
  get(url) {
    const u = new URL(url, 'http://x');
    if (u.pathname.startsWith('/api/alarm/')) {
      return obs(() => ({ data: [{ id: { id: 'a1' }, type: 'Baseline air', severity: 'CRITICAL', status: 'ACTIVE_UNACK', createdTime: now - 3600e3, acknowledged: false }] }));
    }
    if (u.pathname.includes('/values/attributes/SERVER_SCOPE')) {
      return obs(() => Object.keys(window.ATTRS).map((k) => ({ key: k, value: window.ATTRS[k], lastUpdateTs: now - 60e3 })));
    }
    const keys = u.searchParams.get('keys').split(',');
    if (!u.searchParams.has('startTs')) {
      return obs(() => {
        const res = {};
        keys.forEach((k) => { if (k in TELEMETRY) res[k] = [{ ts: now - 20e3, value: String(TELEMETRY[k]) }]; });
        return res;
      });
    }
    const start = +u.searchParams.get('startTs'), end = +u.searchParams.get('endTs');
    const agg = u.searchParams.get('agg'), interval = +u.searchParams.get('interval');
    return obs(() => {
      const res = {};
      keys.forEach((k) => {
        if (agg === 'NONE') { res[k] = []; return; }
        if (interval === 86400000) {
          let i = 0;
          res[k] = series(start, end, interval, () => {
            i++;
            return { flow_today_l: 2300 + (i * 397) % 1500, flow_total_l: 100 + i * 3000, pump_runtime_today_s: 2400 + i * 13, pump_starts_today: 20 + (i % 9) }[k];
          });
        } else if (k === 'tank_level_pct') {
          res[k] = series(start, end, interval, (t) => 60 + 30 * Math.sin(t / 7e6));
        } else {
          res[k] = series(start, end, interval, (t) => Math.max(0, 40 * Math.sin(t / 3e6)));
        }
      });
      return res;
    });
  },
  post(url, body) {
    window.POSTS.push({ url, body });
    if (url === '/api/entitiesQuery/find') {
      const filtered = body.keyFilters.length > 0;
      return obs(() => ({ data: (filtered && OPTS.noWaterDevice) ? [] : [
        { entityId: { id: 'dev-1', entityType: 'DEVICE' }, latest: { ENTITY_FIELD: { name: { ts: 0, value: 'Tandon Utama' }, label: { ts: 0, value: '' } }, ATTRIBUTE: { active: { ts: 0, value: 'true' } } } },
      ] }));
    }
    return obs(() => {
      if (url.includes('/attributes/SERVER_SCOPE')) Object.assign(window.ATTRS, body);
      return {};
    });
  },
};
// Dibungkus persis seperti ThingsBoard 4.2.
const NL = String.fromCharCode(10);
const WidgetType = new Function('return function _tenant_get220v_water_monitor (ctx) {' + NL +
  '    var self = this;' + NL + '    self.ctx = ctx;' + NL + SCRIPT + NL + '};' + NL)();
new WidgetType(); // ThingsBoard membuat instance tanpa ctx saat memuat tipe widget
window.mount = function (width, height) {
  const box = document.createElement('div');
  box.className = 'box';
  box.id = 'w';
  box.style.width = width + 'px';
  box.innerHTML = '<div class="body" style="height:' + height + 'px">' + TEMPLATE + '</div>';
  document.body.appendChild(box);
  const self = new WidgetType({
    $container: [box.querySelector('.body')],
    settings: {},
    data: [],
    http,
    showSuccessToast: (m) => window.TOASTS.push(['ok', m]),
    showErrorToast: (m) => window.TOASTS.push(['err', m]),
  });
  self.onInit();
  self.onDataUpdated();
  window.W_SELF = self;
};
</script></body></html>`;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'id-ID', timezoneId: 'Asia/Jakarta' });
  const errors = [];
  let failed = false;
  const open = async (opts, width, height) => {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await p.setContent(page(opts || {}));
    await p.evaluate(([w, h]) => window.mount(w, h), [width, height]);
    await p.waitForTimeout(150);
    return p;
  };
  const check = async (p, label, fn) => {
    const ok = await p.evaluate(fn);
    console.log((ok ? 'PASS ' : 'FAIL ') + label);
    if (!ok) failed = true;
  };
  const tab = async (p, name) => {
    await p.click('[data-act="tab"][data-tab="' + name + '"]');
    await p.waitForTimeout(150);
  };

  const p = await open({}, 1240, 860);
  await check(p, 'device picker lists water device', () => document.querySelector('select[data-act="device"]').textContent.includes('Tandon Utama'));
  await check(p, 'device query filters on active telemetry keys', () => window.POSTS[0].body.keyFilters.map((k) => k.key.key).join() === 'flow_total_l,tank_level_pct');
  await check(p, 'live: 3.100 L usage & 103% baseline', () => {
    const t = document.querySelector('#w .wm-body').textContent;
    return t.includes('3.100 L') && t.includes('103% baseline');
  });
  await check(p, 'live: charts rendered', () => document.querySelectorAll('#w svg path').length >= 2);
  await check(p, 'alert tab shows count badge', () => document.querySelector('[data-tab="alerts"] .wm-count').textContent === '1');
  await p.screenshot({ path: path.join(OUT, 'live.png'), fullPage: true });

  await tab(p, 'alerts');
  await check(p, 'alerts: baseline exceeded is critical', () => document.querySelector('#w .wm-alerts').textContent.includes('Pemakaian melebihi baseline'));
  await p.waitForTimeout(100);
  await check(p, 'alerts: server alarm listed', () => document.querySelector('#w .wm-table') !== null);
  await p.screenshot({ path: path.join(OUT, 'alerts.png'), fullPage: true });

  await tab(p, 'usage');
  await check(p, 'usage: 14 day rows + bars', () => document.querySelectorAll('#w tbody tr').length === 14 && document.querySelectorAll('#w svg path').length > 5);
  await p.screenshot({ path: path.join(OUT, 'usage.png'), fullPage: true });
  await p.evaluate(() => {
    const el = document.querySelectorAll('#w .wm-occ')[3];
    el.value = '12';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await p.waitForTimeout(200);
  await check(p, 'usage: per-day occupancy saved to wm_occ_log', () => Object.values(JSON.parse(window.ATTRS.wm_occ_log)).includes(12));

  await tab(p, 'setup');
  await p.fill('#w input[name="wm_baseline_cost_room_day"]', '2500');
  await check(p, 'setup: preview updates live', () => document.querySelector('#w [data-preview]').textContent.includes('208 L/kamar/hari'));
  await p.screenshot({ path: path.join(OUT, 'setup.png'), fullPage: true });
  await p.click('#w [data-act="save-setup"]');
  await p.waitForTimeout(250);
  await check(p, 'setup: saves derived baseline attrs', () => {
    const b = window.POSTS.at(-1).body;
    return b.wm_baseline_cost_room_day === 2500 && Math.abs(b.wm_baseline_day_l - 3750) < 0.01 && b.wm_baseline_day_raw_l === 3750;
  });
  await tab(p, 'live');
  await check(p, 'live: refreshed after save (83% baseline)', () => document.querySelector('#w .wm-body').textContent.includes('83% baseline'));
  await tab(p, 'alerts');
  await check(p, 'alerts: now warning, not critical', () => {
    const t = document.querySelector('#w .wm-alerts').textContent;
    return t.includes('Pemakaian mendekati baseline') && !t.includes('Pemakaian melebihi baseline');
  });

  await tab(p, 'calibration');
  await p.fill('#w [data-input="cal-m-sensor"]', '100');
  await p.fill('#w [data-input="cal-m-meter"]', '104');
  await p.click('#w [data-act="cal-manual"]');
  await p.click('#w [data-act="cal-apply"]');
  await p.waitForTimeout(250);
  await check(p, 'calibration: factor 1.04 saved, raw threshold divided by factor', () => {
    const b = window.POSTS.at(-1).body;
    return b.wm_cal_factor === 1.04 && Math.abs(b.wm_baseline_day_raw_l - b.wm_baseline_day_l / 1.04) < 0.01;
  });
  await p.screenshot({ path: path.join(OUT, 'calibration.png'), fullPage: true });
  await tab(p, 'live');
  await check(p, 'live: calibrated usage 3.224 L', () => document.querySelector('#w .wm-body').textContent.includes('3.224 L'));

  // Tidak ada device dengan telemetry air -> semua device ditampilkan + penjelasan.
  const p2 = await open({ noWaterDevice: true }, 900, 400);
  await check(p2, 'no water device: falls back to all devices with notice', () =>
    document.querySelector('#w .wm-warnbox') !== null && document.querySelector('select[data-act="device"]') !== null);

  // Tampilan sempit (mobile).
  const pm = await open({}, 370, 760);
  await pm.setViewportSize({ width: 390, height: 800 });
  await pm.screenshot({ path: path.join(OUT, 'mobile-live.png'), fullPage: true });
  let mobileOk = true;
  for (const t of ['alerts', 'live', 'setup', 'calibration']) {
    await tab(pm, t);
    mobileOk = mobileOk && await pm.evaluate(() => {
      const r = document.querySelector('#w .wm-root');
      return r.scrollWidth <= r.clientWidth + 1;
    });
  }
  console.log((mobileOk ? 'PASS ' : 'FAIL ') + 'mobile: no horizontal overflow (alerts/live/setup/calibration)');
  if (!mobileOk) failed = true;

  if (errors.length) {
    console.log('PAGE ERRORS:\n' + errors.join('\n'));
    failed = true;
  }
  await browser.close();
  process.exitCode = failed ? 1 : 0;
})();
