// node build_dashboard.js  ->  nismara_dashboard.json  &  nismara_irrigation_dashboard.json
// Dashboard memakai widget dari bundle (nismara_water). Import bundle DULU, lalu dashboard.
const fs = require('fs'), crypto = require('crypto');
const uuid = () => crypto.randomUUID();
const ALIAS_NAME = 'NISMARA Devices';
const NAME_PREFIX = process.env.NAME_PREFIX || 'nismara';     // semua device yang namanya diawali ini

const KEYS = [
  // GWT + rain
  't1_level','t1_vol_l','t1_dist_cm','t2_level','t2_vol_l','t2_dist_cm','balance_diff','balance_ok',
  'rw_level','rw_vol_l','rw_dist_cm','rw_flow_lpm','rw_total_liters','rw_pulses_win',
  // transfer pump
  'flow_lpm','total_liters','pulses_win','pump_running',
  // roof
  'level_pct','level_cm','distance_cm','volume_l','pressure_bar','pressure_v','pump1_status','pump2_status',
  'pump1_runtime_s','pump2_runtime_s','pump1_cycles','pump2_cycles','tank_count',
  'alarm_level_low','alarm_level_high','alarm_press_low','alarm_press_high',
  // irrigation (Garden Lt.1 = z1,z2 | Garden Roof = z1)
  ...[1, 2].flatMap(n => ['soil1','soil2','valve','auto','start_pct','stop_pct','remain_s','cycles','runtime_s','fault'].map(k => `z${n}_${k}`)),
  'in_window','time_ok','win',
  // umum
  'rssi','uptime_s','heap','fw_version'
];
const dataKey = (name) => ({ name, type: 'timeseries', label: name, color: '#2196f3', settings: {}, _hash: Math.random(),
  aggregationType: null, units: null, decimals: null, funcBody: null, usePostProcessing: null, postFuncBody: null });

function build(opts) {
  const aliasId = uuid(), wid = uuid();
  const widget = {
    typeFullFqn: `nismara_water.${opts.widget}`, bundleAlias: 'nismara_water', typeAlias: opts.widget,
    type: 'timeseries', title: opts.widgetTitle, image: null, description: null,
    sizeX: 24, sizeY: 24, row: 0, col: 0, id: wid,
    config: {
      datasources: [{ type: 'entity', name: null, entityAliasId: aliasId, filterId: null, dataKeys: KEYS.map(dataKey) }],
      timewindow: { realtime: { timewindowMs: 86400000 }, aggregation: { type: 'NONE', limit: 25000 } },
      showTitle: false, backgroundColor: 'transparent', color: 'rgba(0, 0, 0, 0.87)', padding: '0px', margin: '0px',
      settings: { view: opts.view, theme: opts.theme || 'dark' }, title: opts.widgetTitle, dropShadow: false, enableFullscreen: true,
      enableDataExport: false, widgetStyle: {}, titleStyle: { fontSize: '16px', fontWeight: 400 }, useDashboardTimewindow: false,
      showLegend: false, actions: {}, displayTimewindow: false
    }
  };
  return {
    title: opts.title, name: opts.title, image: null, mobileHide: false, mobileOrder: null,
    configuration: {
      description: opts.description,
      widgets: { [wid]: widget },
      states: { default: { name: opts.title, root: true, layouts: { main: {
        widgets: { [wid]: { sizeX: 24, sizeY: 24, row: 0, col: 0 } },
        gridSettings: { backgroundColor: '#060b1a', columns: 24, margin: 0, outerMargin: false, backgroundSizeMode: '100%',
          autoFillHeight: true, mobileAutoFillHeight: true, mobileRowHeight: 70 } } } } },
      entityAliases: { [aliasId]: { id: aliasId, alias: ALIAS_NAME, filter: { type: 'entityName', resolveMultiple: true, entityType: 'DEVICE', entityNameFilter: NAME_PREFIX } } },
      filters: {},
      timewindow: { displayValue: '', selectedTab: 0, realtime: { realtimeType: 1, interval: 1000, timewindowMs: 86400000, quickInterval: 'CURRENT_DAY' },
        aggregation: { type: 'NONE', limit: 25000 } },
      settings: { stateControllerId: 'entity_state', showTitle: false, showDashboardsSelect: false, showEntitiesSelect: false,
        showDashboardTimewindow: false, showDashboardExport: true, toolbarAlwaysOpen: false, hideToolbar: true }
    }
  };
}

const out = [
  ['nismara_dashboard.json', build({ title: 'NISMARA Water System', widget: 'water_system_overview', widgetTitle: 'NISMARA Water System Overview', view: 'full',
    description: 'SIAGA Nextgen: Rain → GWT → Transfer → Roof + Smart Irrigation (v5)' })],
  ['nismara_irrigation_dashboard.json', build({ title: 'NISMARA Smart Irrigation', widget: 'smart_irrigation', widgetTitle: 'NISMARA Smart Irrigation', view: 'irrigation',
    description: 'Kontrol & monitoring 3 zona irigasi (Garden Lt.1 + Garden Roof)' })]
];
out.forEach(([f, d]) => { fs.writeFileSync(__dirname + '/' + f, JSON.stringify(d, null, 2)); console.log(f, (fs.statSync(__dirname + '/' + f).size / 1024).toFixed(0) + ' KB, keys/datasource:', KEYS.length); });
