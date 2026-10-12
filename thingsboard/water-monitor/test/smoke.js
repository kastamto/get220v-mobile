#!/usr/bin/env node
// Smoke test: jalankan widget di Chromium dengan ctx ThingsBoard tiruan,
// render kelima tampilan, uji alur simpan setup/okupansi/kalibrasi, dan
// simpan screenshot ke test/out/.
//
//   node thingsboard/water-monitor/build.js
//   node thingsboard/water-monitor/test/smoke.js

const path = require('path');
const fs = require('fs');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  ({ chromium } = require(path.join(process.execPath, '../../lib/node_modules/playwright')));
}

const ROOT = path.join(__dirname, '..');
const widget = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/get220v_water_monitor_widget.json'), 'utf8'));
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

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#eee;font-family:Roboto,Arial,sans-serif}
.box{background:#fff;margin:10px;box-shadow:0 1px 3px rgba(0,0,0,.2);overflow:hidden}
.box h3{margin:0;padding:8px 12px;font:600 16px Roboto,Arial}
.body{padding:8px}
${widget.descriptor.templateCss}
</style></head><body>
<script>
const SCRIPT = ${JSON.stringify(widget.descriptor.controllerScript)};
const TEMPLATE = ${JSON.stringify(widget.descriptor.templateHtml)};
const TELEMETRY = ${JSON.stringify(TELEMETRY)};
window.ATTRS = ${JSON.stringify(ATTRS)};
window.POSTS = [];
window.TOASTS = [];
const KEYS = ${JSON.stringify(widget.descriptor.defaultConfig)};
const instances = [];
const now = Date.now();
const obs = (fn) => ({ subscribe: (next, err) => setTimeout(() => { try { next(fn()); } catch (e) { err && err(e); } }, 5) });
function series(key, start, end, step, f) {
  const out = [];
  for (let t = start; t <= end; t += step) out.push({ ts: t + step / 2, value: String(f(t)) });
  return out;
}
const http = {
  get(url) {
    const u = new URL(url, 'http://x');
    if (u.pathname.startsWith('/api/alarm/')) {
      return obs(() => ({ data: [{ id: { id: 'a1' }, type: 'Pemakaian melebihi baseline', severity: 'CRITICAL', status: 'ACTIVE_UNACK', createdTime: now - 3600e3, acknowledged: false }] }));
    }
    const keys = u.searchParams.get('keys').split(',');
    const start = +u.searchParams.get('startTs'), end = +u.searchParams.get('endTs');
    const agg = u.searchParams.get('agg'), interval = +u.searchParams.get('interval');
    return obs(() => {
      const res = {};
      keys.forEach((k) => {
        if (agg === 'NONE') { res[k] = []; return; }
        if (interval === 86400000) {
          let i = 0;
          res[k] = series(k, start, end, interval, () => {
            i++;
            return { flow_today_l: 2300 + (i * 397) % 1500, flow_total_l: 100 + i * 3000, pump_runtime_today_s: 2400 + i * 13, pump_starts_today: 20 + (i % 9) }[k];
          });
        } else if (k === 'tank_level_pct') {
          res[k] = series(k, start, end, interval, (t) => 60 + 30 * Math.sin(t / 7e6));
        } else {
          res[k] = series(k, start, end, interval, (t) => Math.max(0, 40 * Math.sin(t / 3e6)));
        }
      });
      return res;
    });
  },
  post(url, body) {
    window.POSTS.push({ url, body });
    return obs(() => {
      if (url.includes('/attributes/SERVER_SCOPE')) {
        Object.assign(window.ATTRS, body);
        setTimeout(() => instances.forEach((s) => { s.ctx.data = makeData(); s.onDataUpdated(); }), 10);
      }
      return {};
    });
  },
};
function makeData() {
  const ds = { entityId: 'dev-1', entityType: 'DEVICE', entityName: 'Tandon Utama' };
  const items = [];
  Object.keys(TELEMETRY).forEach((k) => items.push({ datasource: ds, dataKey: { name: k, type: 'timeseries' }, data: [[now - 20e3, String(TELEMETRY[k])]] }));
  Object.keys(window.ATTRS).forEach((k) => {
    const v = window.ATTRS[k];
    items.push({ datasource: ds, dataKey: { name: k, type: 'attribute' }, data: [[now - 60e3, typeof v === 'string' ? v : String(v)]] });
  });
  return items;
}
// Dibungkus persis seperti ThingsBoard 4.2 (widget-component.service.ts):
// function(ctx) { var self = this; self.ctx = ctx; <controllerScript> }
const NL = String.fromCharCode(10);
const WidgetType = new Function('return function _tenant_get220v_water_water_monitor (ctx) {' + NL +
  '    var self = this;' + NL + '    self.ctx = ctx;' + NL + SCRIPT + NL + '};' + NL)();
window.TYPE_PARAMS = new WidgetType().typeParameters();
window.mount = function (view, width, height, id, empty) {
  const box = document.createElement('div');
  box.className = 'box';
  box.style.width = width + 'px';
  box.innerHTML = '<h3>' + view + '</h3><div class="body" style="height:' + height + 'px">' + TEMPLATE + '</div>';
  document.body.appendChild(box);
  const self = new WidgetType({
    $container: [box.querySelector('.body')],
    settings: { view },
    data: empty ? [] : makeData(),
    http,
    showSuccessToast: (m) => window.TOASTS.push(['ok', m]),
    showErrorToast: (m) => window.TOASTS.push(['err', m]),
  });
  self.onInit();
  if (!empty) instances.push(self);
  box.id = 'w-' + (id || view);
  return true;
};
</script></body></html>`;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'id-ID', timezoneId: 'Asia/Jakarta' });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await p.setContent(page);
  if (errors.length) {
    console.log('PAGE ERRORS:\n' + errors.join('\n'));
    process.exit(1);
  }

  const views = [['alerts', 1240, 380], ['live', 1240, 640], ['usage', 1240, 900], ['setup', 520, 820], ['calibration', 700, 760]];
  for (const [v, w, h] of views) await p.evaluate(([v, w, h]) => window.mount(v, w, h), [v, w, h]);
  await p.waitForTimeout(300);

  const check = async (label, fn) => {
    const ok = await p.evaluate(fn);
    console.log((ok ? 'PASS ' : 'FAIL ') + label);
    if (!ok) process.exitCode = 1;
  };
  await check('typeParameters: processNoDataByWidget so widget renders without a device', () => window.TYPE_PARAMS.processNoDataByWidget === true && window.TYPE_PARAMS.singleEntity === true);
  await p.evaluate(() => window.mount('live', 600, 160, 'nodevice', true));
  await check('no device: explains how to fix instead of blank panel', () => document.querySelector('#w-nodevice').textContent.includes('Device air belum ditemukan'));
  await check('alerts: baseline exceeded is critical', () => document.querySelector('#w-alerts').textContent.includes('Pemakaian melebihi baseline'));
  await check('alerts: server alarm listed', () => document.querySelector('#w-alerts .wm-table') !== null);
  await check('live: 3.100 L usage & 103% baseline', () => {
    const t = document.querySelector('#w-live').textContent;
    return t.includes('3.100 L') && t.includes('103% baseline');
  });
  await check('live: charts rendered', () => document.querySelectorAll('#w-live svg path').length >= 2);
  await check('usage: 14 day rows + bars', () => document.querySelectorAll('#w-usage tbody tr').length === 14 && document.querySelectorAll('#w-usage svg path').length > 5);

  // Setup: ubah baseline -> pratinjau berubah -> simpan menulis atribut turunan.
  await p.fill('#w-setup input[name="wm_baseline_cost_room_day"]', '2500');
  await check('setup: preview updates live', () => document.querySelector('#w-setup [data-preview]').textContent.includes('208 L/kamar/hari'));
  await p.click('#w-setup [data-act="save-setup"]');
  await p.waitForTimeout(200);
  await check('setup: saves derived baseline attrs', () => {
    const b = window.POSTS.at(-1).body;
    return b.wm_baseline_cost_room_day === 2500 && Math.abs(b.wm_baseline_day_l - 3750) < 0.01 && b.wm_baseline_day_raw_l === 3750;
  });
  await check('live: other widgets pick up new baseline (83%)', () => document.querySelector('#w-live').textContent.includes('83% baseline'));
  await check('alerts: now warning, not critical', () => {
    const t = document.querySelector('#w-alerts .wm-alerts').textContent;
    return t.includes('Pemakaian mendekati baseline') && !t.includes('Pemakaian melebihi baseline');
  });

  // Okupansi per hari dari tabel.
  await p.evaluate(() => {
    const el = document.querySelectorAll('#w-usage .wm-occ')[3];
    el.value = '12';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await p.waitForTimeout(200);
  await check('usage: per-day occupancy saved to wm_occ_log', () => Object.values(JSON.parse(window.ATTRS.wm_occ_log)).includes(12));

  // Kalibrasi metode 2: sensor 100 L vs meter 104 L -> x1.04.
  await p.fill('#w-calibration [data-input="cal-m-sensor"]', '100');
  await p.fill('#w-calibration [data-input="cal-m-meter"]', '104');
  await p.click('#w-calibration [data-act="cal-manual"]');
  await p.click('#w-calibration [data-act="cal-apply"]');
  await p.waitForTimeout(200);
  await check('calibration: factor 1.04 saved, raw threshold divided by factor', () => {
    const b = window.POSTS.at(-1).body;
    return b.wm_cal_factor === 1.04 && Math.abs(b.wm_baseline_day_raw_l - b.wm_baseline_day_l / 1.04) < 0.01;
  });
  await check('live: calibrated usage 3.224 L', () => document.querySelector('#w-live').textContent.includes('3.224 L'));

  await p.evaluate(() => window.scrollTo(0, 0));
  await p.screenshot({ path: path.join(OUT, 'dashboard.png'), fullPage: true });
  for (const [v] of views) await p.locator('#w-' + v).screenshot({ path: path.join(OUT, v + '.png') });

  // Tampilan sempit (mobile).
  const pm = await ctx.newPage();
  pm.on('pageerror', (e) => errors.push(String(e)));
  await pm.setViewportSize({ width: 390, height: 800 });
  await pm.setContent(page);
  for (const [v] of views) await pm.evaluate((v) => window.mount(v, 370, 700), v);
  await pm.waitForTimeout(300);
  await pm.locator('#w-live').screenshot({ path: path.join(OUT, 'mobile-live.png') });
  await pm.locator('#w-usage').screenshot({ path: path.join(OUT, 'mobile-usage.png') });
  const mobileOk = await pm.evaluate(() => ['live', 'alerts', 'setup', 'calibration'].every((v) => {
    const r = document.querySelector('#w-' + v + ' .wm-root');
    return r.scrollWidth <= r.clientWidth + 1;
  }));
  console.log((mobileOk ? 'PASS ' : 'FAIL ') + 'mobile: no horizontal overflow (live/alerts/setup/calibration)');
  if (!mobileOk) process.exitCode = 1;

  console.log('toasts:', JSON.stringify(await p.evaluate(() => window.TOASTS)));
  if (errors.length) {
    console.log('PAGE ERRORS:\n' + errors.join('\n'));
    process.exitCode = 1;
  }
  await browser.close();
})();
