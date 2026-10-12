#!/usr/bin/env node
// Membuat file import ThingsBoard dari src/:
//   dist/get220v_water_widgets_bundle.json  -> Widgets library > Import widgets bundle
//   dist/get220v_water_monitor_widget.json  -> (alternatif) Import widget tunggal
//   dist/get220v_water_dashboard.json       -> Dashboards > Import dashboard
//
// Jalankan: node thingsboard/water-monitor/build.js

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = (f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');

const BUNDLE_ALIAS = 'get220v_water';
const TYPE_ALIAS = 'water_monitor';
const FQN = BUNDLE_ALIAS + '.' + TYPE_ALIAS;

const TELEMETRY_KEYS = [
  'alarm_level_high', 'alarm_level_low', 'evt', 'flow_lpm', 'flow_mode',
  'flow_today_l', 'flow_total_l', 'pump_last_run_s', 'pump_runtime_today_s',
  'pump_runtime_total_s', 'pump_session_s', 'pump_starts_today',
  'pump_starts_total', 'pump_state', 'rssi', 'secs_today', 'tank_capacity_l',
  'tank_dist_cm', 'tank_level_pct', 'tank_volume_l', 'uptime_s',
];

const ATTRIBUTE_KEYS = [
  'wm_rooms_total', 'wm_rooms_occupied', 'wm_occ_log', 'wm_tariff_m3',
  'wm_baseline_cost_room_day', 'wm_warn_pct', 'wm_tank_low_pct',
  'wm_tank_high_pct', 'wm_leak_min', 'wm_pump_max_min', 'wm_pump_starts_max',
  'wm_offline_min', 'wm_rssi_min', 'wm_cal_factor', 'wm_cal_log',
];

const ALIAS_ID = '5a0c3b8e-6f1d-4c2a-9e7b-2d4f8a1c0e01';
const FILTER_ID = '5a0c3b8e-6f1d-4c2a-9e7b-2d4f8a1c0e02';

// Hanya device yang benar-benar mengirim telemetry air: kedua key harus ada.
const ACTIVE_FILTER_KEYS = [['flow_total_l', 0], ['tank_level_pct', -1]];

function dataKeys() {
  let hash = 0.11;
  const key = (name, type) => ({
    name,
    type,
    label: name,
    color: '#2a78d6',
    settings: {},
    _hash: (hash += 0.013),
    funcBody: null,
    usePostProcessing: null,
    postFuncBody: null,
    units: null,
    decimals: null,
  });
  return TELEMETRY_KEYS.map((k) => key(k, 'timeseries'))
    .concat(ATTRIBUTE_KEYS.map((k) => key(k, 'attribute')));
}

function widgetConfig(view, title, aliasId) {
  return {
    datasources: [
      {
        type: 'entity',
        name: '',
        entityAliasId: aliasId,
        filterId: aliasId ? FILTER_ID : null,
        dataKeys: dataKeys(),
      },
    ],
    timewindow: { realtime: { timewindowMs: 60000 } },
    showTitle: true,
    title,
    backgroundColor: '#ffffff',
    color: 'rgba(0, 0, 0, 0.87)',
    padding: '8px',
    settings: { view },
    dropShadow: true,
    enableFullscreen: true,
    titleStyle: { fontSize: '16px', fontWeight: 600 },
    showTitleIcon: false,
    titleTooltip: '',
    widgetStyle: {},
    showLegend: false,
    actions: {},
    decimals: 2,
    units: '',
    noDataDisplayMessage: '',
    pageSize: 1024,
  };
}

const settingsSchema = {
  schema: {
    type: 'object',
    title: 'Settings',
    properties: {
      view: {
        title: 'Tampilan (alerts | live | usage | setup | calibration)',
        type: 'string',
        enum: ['alerts', 'live', 'usage', 'setup', 'calibration'],
        default: 'live',
      },
    },
    required: ['view'],
  },
  form: ['view'],
};

const widgetType = {
  fqn: FQN,
  name: 'Get220v Water Monitor',
  deprecated: false,
  image: null,
  description:
    'Monitor air Get220v: live telemetry, alert vs baseline biaya/kamar/hari, setup okupansi, tabel pemakaian, kalibrasi flow sensor. Pilih tampilan di settings.view.',
  tags: ['get220v', 'water', 'flow', 'tank'],
  descriptor: {
    type: 'latest',
    sizeX: 24,
    sizeY: 10,
    resources: [],
    templateHtml: read('widget.html'),
    templateCss: read('widget.css'),
    controllerScript: read('widget.js'),
    settingsSchema: JSON.stringify(settingsSchema),
    dataKeySettingsSchema: '{}',
    defaultConfig: JSON.stringify(widgetConfig('live', 'Get220v Water Monitor', null)),
  },
};

const bundle = {
  widgetsBundle: {
    alias: BUNDLE_ALIAS,
    title: 'Get220v Water',
    image: null,
    description: 'Widget monitoring air Get220v',
    order: null,
    name: 'Get220v Water',
  },
  widgetTypes: [widgetType],
};

// Tata letak 24 kolom. [id, view, judul, row, col, sizeX, sizeY, mobileOrder, mobileHeight]
const LAYOUT = [
  ['b1f7a0e2-0001-4d6a-8c11-7e0a2f9d1a01', 'alerts', 'Alert', 0, 0, 24, 6, 1, 6],
  ['b1f7a0e2-0002-4d6a-8c11-7e0a2f9d1a02', 'live', 'Live telemetry', 6, 0, 24, 11, 2, 16],
  ['b1f7a0e2-0003-4d6a-8c11-7e0a2f9d1a03', 'usage', 'Pemakaian harian & biaya per kamar', 17, 0, 24, 14, 3, 18],
  ['b1f7a0e2-0004-4d6a-8c11-7e0a2f9d1a04', 'setup', 'Setup okupansi, tarif & baseline', 31, 0, 10, 13, 4, 14],
  ['b1f7a0e2-0005-4d6a-8c11-7e0a2f9d1a05', 'calibration', 'Kalibrasi flow sensor', 31, 10, 14, 13, 5, 14],
];

const widgets = {};
const layoutWidgets = {};
LAYOUT.forEach(([id, view, title, row, col, sizeX, sizeY, mobileOrder, mobileHeight]) => {
  widgets[id] = {
    typeFullFqn: 'tenant.' + FQN,
    type: 'latest',
    sizeX,
    sizeY,
    config: widgetConfig(view, title, ALIAS_ID),
    row,
    col,
    id,
  };
  layoutWidgets[id] = { sizeX, sizeY, row, col, mobileOrder, mobileHeight };
});

const dashboard = {
  title: 'Get220v Water Monitor',
  image: null,
  mobileHide: false,
  mobileOrder: null,
  configuration: {
    description: 'Monitoring air: live telemetry, alert baseline, okupansi kamar, pemakaian & kalibrasi flow.',
    widgets,
    states: {
      default: {
        name: 'Get220v Water Monitor',
        root: true,
        layouts: {
          main: {
            widgets: layoutWidgets,
            gridSettings: {
              backgroundColor: '#eeeeee',
              columns: 24,
              margin: 10,
              outerMargin: true,
              backgroundSizeMode: '100%',
              autoFillHeight: false,
              mobileAutoFillHeight: false,
              mobileRowHeight: 70,
              layoutType: 'default',
            },
          },
        },
      },
    },
    entityAliases: {
      [ALIAS_ID]: {
        id: ALIAS_ID,
        alias: 'Water device',
        // Semua device; dipersempit oleh filter "Telemetry air aktif" sehingga
        // device air terdeteksi otomatis tanpa perlu mengatur Device Profile.
        filter: {
          type: 'entityType',
          resolveMultiple: true,
          entityType: 'DEVICE',
        },
      },
    },
    filters: {
      [FILTER_ID]: {
        id: FILTER_ID,
        filter: 'Telemetry air aktif',
        editable: false,
        keyFiltersOperation: 'AND',
        keyFilters: ACTIVE_FILTER_KEYS.map(([key, min]) => ({
          key: { type: 'TIME_SERIES', key },
          valueType: 'NUMERIC',
          predicates: [
            {
              keyFilterPredicate: {
                type: 'NUMERIC',
                operation: 'GREATER_OR_EQUAL',
                value: { defaultValue: min, dynamicValue: null },
              },
              userInfo: { editable: false, label: '', autogeneratedLabel: true, order: 0 },
            },
          ],
        })),
      },
    },
    timewindow: {
      displayValue: '',
      hideInterval: false,
      hideAggregation: false,
      hideAggInterval: false,
      hideTimezone: false,
      selectedTab: 0,
      realtime: { realtimeType: 0, timewindowMs: 60000, quickInterval: 'CURRENT_DAY', interval: 1000 },
      aggregation: { type: 'NONE', limit: 1000 },
    },
    settings: {
      stateControllerId: 'entity',
      showTitle: true,
      showDashboardsSelect: true,
      showEntitiesSelect: true,
      showDashboardTimewindow: false,
      showDashboardExport: true,
      toolbarAlwaysOpen: true,
      hideToolbar: false,
      showDashboardLogo: false,
      showFilters: false,
      showUpdateDashboardImage: false,
    },
  },
  name: 'Get220v Water Monitor',
};

const out = path.join(ROOT, 'dist');
fs.mkdirSync(out, { recursive: true });
const write = (f, obj) => {
  fs.writeFileSync(path.join(out, f), JSON.stringify(obj, null, 2) + '\n');
  console.log('wrote dist/' + f);
};
write('get220v_water_widgets_bundle.json', bundle);
write('get220v_water_monitor_widget.json', widgetType);
write('get220v_water_dashboard.json', dashboard);
