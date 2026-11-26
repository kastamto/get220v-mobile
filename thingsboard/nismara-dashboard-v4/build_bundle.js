// Build ThingsBoard widgets bundle JSON dari widget.html + widget.js
//   node build_bundle.js   ->  nismara_water_bundle.json
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/widget.html', 'utf8');
const js = fs.readFileSync(__dirname + '/widget.js', 'utf8');
const ALIAS = 'nismara_water';

const num = (title, def) => ({ type: 'number', title, default: def });
const settingsSchema = JSON.stringify({
  schema: {
    type: 'object', title: 'NISMARA Water Settings',
    properties: {
      view: { type: 'string', title: 'View', default: 'full' },
      systemName: { type: 'string', title: 'Judul sistem', default: 'NISMARA Water System' },
      irrigControl: { type: 'boolean', title: 'Aktifkan kontrol irigasi (kirim shared attribute)', default: true },
      gwtT1CapacityL: num('Kapasitas GWT Tank 1 (L)', 2500),
      gwtT2CapacityL: num('Kapasitas GWT Tank 2 (L)', 2500),
      rwCapacityL: num('Kapasitas tangki hujan (L)', 1000),
      roofTankCapacityL: num('Kapasitas roof tank (L)', 9000),
      soilDryPct: num('Soil dry < (%)', 30),
      soilWetPct: num('Soil wet > (%)', 70),
      zoneFlowLpm: num('Debit solenoid utk estimasi air (L/min)', 6),
      offlineMs: num('Device dianggap offline setelah (ms)', 90000)
    }
  },
  form: [
    { key: 'view', type: 'rc-select', multiple: false, items: [
      { value: 'full', label: 'Full (semua tab)' }, { value: 'water', label: 'Water only' }, { value: 'irrigation', label: 'Irrigation only' } ] },
    'systemName', 'irrigControl', 'gwtT1CapacityL', 'gwtT2CapacityL', 'rwCapacityL', 'roofTankCapacityL',
    'soilDryPct', 'soilWetPct', 'zoneFlowLpm', 'offlineMs'
  ]
});

const defaultConfig = (title, view, sx, sy) => JSON.stringify({
  timewindow: { realtime: { timewindowMs: 86400000 } },
  showTitle: false, backgroundColor: 'transparent', color: 'rgba(0, 0, 0, 0.87)', padding: '0px',
  settings: { view }, title, dropShadow: false, enableFullscreen: true, enableDataExport: false,
  widgetStyle: {}, titleStyle: { fontSize: '16px', fontWeight: 400 }, useDashboardTimewindow: false, showLegend: false,
  datasources: [{ type: 'function', name: 'function', dataKeys: [
    { name: 'f(x)', type: 'function', label: 'placeholder', color: '#2196f3', settings: {}, _hash: 0.5, funcBody: 'return 0;' } ] }],
  actions: {}
});

const mk = (slug, name, desc, view, sx, sy) => ({
  name, fqn: `${ALIAS}.${slug}`, alias: slug, bundleAlias: ALIAS, deprecated: false, scada: false, image: null, description: desc, tags: ['nismara', 'water', 'irrigation', 'siaga'],
  descriptor: {
    type: 'timeseries', sizeX: sx, sizeY: sy, resources: [],
    templateHtml: html, templateCss: '', controllerScript: js,
    settingsSchema, dataKeySettingsSchema: '{}', settingsDirective: '', dataKeySettingsDirective: '', latestDataKeySettingsDirective: '',
    hasBasicMode: false, defaultConfig: defaultConfig(name, view)
  }
});

const widgetTypes = [
  mk('water_system_overview', 'NISMARA Water System Overview', 'Rain → GWT → Transfer → Roof + Smart Irrigation (semua tab)', 'full', 24, 26),
  mk('water_system', 'NISMARA Water System', 'GWT, Rain Water, Transfer Pump, Roof Tank (tanpa irigasi)', 'water', 24, 22),
  mk('smart_irrigation', 'NISMARA Smart Irrigation', '3 zona irigasi: gauge soil, kontrol auto/manual, threshold, tren', 'irrigation', 24, 20)
];

const bundle = {
  widgetsBundle: { alias: ALIAS, title: 'NISMARA Water & Irrigation', image: null, scada: false, description: 'SIAGA Nextgen water system + smart irrigation by get220v', order: 9000, name: 'NISMARA Water & Irrigation' },
  widgetTypeFqns: widgetTypes.map(w => w.fqn),
  widgetTypes
};
fs.writeFileSync(__dirname + '/nismara_water_bundle.json', JSON.stringify(bundle, null, 2));
console.log('OK', widgetTypes.length, 'widgets,', (fs.statSync(__dirname + '/nismara_water_bundle.json').size / 1024).toFixed(0) + ' KB');
