/* ====================================================================
   SIAGA-RM / NISMARA  WATER SYSTEM OVERVIEW  v4   (multi-datasource)
   --------------------------------------------------------------------
   + Rain Water Collection (rw_* keys, ikut device GWT)
   + Smart Irrigation 3 zone (Garden Lt.1 = 2 zone, Garden Roof = 1 zone)
   + Sensor-fault aware (ultrasonik dist < 0 => ERR, bukan "0%")
   Routing device = schema-aware (berdasarkan key), bukan nama device,
   kecuali utk membedakan 2 device irigasi (nama "roof"/"atap" => Garden Roof).
   ==================================================================== */

/* ==============  USER DEFAULTS  EDIT BLOCK INI  ============= */
var USER_DEFAULTS = {
  systemName:  'NISMARA Water System',
  systemSub:   'Rain → GWT → Transfer → Roof · Smart Irrigation',

  /* ---- GWT (2 tank) ---- */
  gwtT1Label:  'GWT Tank 1',
  gwtT2Label:  'GWT Tank 2',
  gwtBalanceWarnPct: 10,
  gwtT1CapacityL: 2500,
  gwtT2CapacityL: 2500,

  /* ---- RAIN WATER (device GWT: rw_level rw_vol_l rw_dist_cm rw_flow_lpm rw_total_liters rw_pulses_win) ---- */
  rwLabel:         'Rain Water Tank',
  rwCapacityL:     1000,   // <<< SESUAIKAN kapasitas asli tangki hujan (liter)
  rwFlowMaxLpm:    30,     // skala gauge flow 1 inch
  rwFlowActiveLpm: 0.5,    // flow >= ini => "COLLECTING / mengalir"
  rwLowPct:        15,     // level di bawah ini => tangki hujan dianggap rendah
  rwOverflowPct:   95,     // level di atas ini => FULL

  /* ---- TRANSFER ---- */
  transferLabel:   'Transfer Pump',
  flowMaxLpm:      40,
  flowDryRunLpm:   2.0,

  /* ---- ROOF ---- */
  roofTankCapacityL: 9000,
  roofTankShape:     'Roof tank · 9 kL',
  roofTankCount:     4,
  pressureMaxBar:    5.0,
  pressureLowBar:    1.0,
  pressureHighBar:   4.0,
  pump1Label:        'Booster 1',
  pump2Label:        'Booster 2',
  alarmLevelLow:     20,
  alarmLevelHigh:    95,

  /* ---- SMART IRRIGATION ---- */
  irrigSource:     'rain',  // 'rain' = prioritas air hujan, fallback GWT bila tangki hujan rendah
  soilDryPct:      30,      // rata-rata < ini => DRY (perlu siram)
  soilWetPct:      70,      // rata-rata > ini => WET (skip siram)
  soilTargetPct:   50,      // target firmware utk stop siram (info)
  soilMismatchPct: 25,      // selisih 2 sensor dlm 1 zona > ini => warning
  valveMaxMin:     30,      // valve ON lebih lama dari ini => warning
  zoneFlowLpm:     6,       // debit default solenoid (L/min) utk estimasi pemakaian air
  /* role: 'irrG' = Garden Lt.1, 'irrR' = Garden Roof. soil/valve = telemetry key.
     Override per zona: dry, wet, target, flowLpm */
  irrigZones: [
    { id:'g1', role:'irrG', label:'Garden Lt.1 · Zone 1', soil:['z1_soil1'], valve:'z1_valve', color:'#34d399' },       // Lt.1: 1 sensor tanah per zona
    { id:'g2', role:'irrG', label:'Garden Lt.1 · Zone 2', soil:['z2_soil1'], valve:'z2_valve', color:'#fbbf24' },
    { id:'r1', role:'irrR', label:'Garden Roof · Zone 1', soil:['z1_soil1','z1_soil2'], valve:'z1_valve', color:'#60a5fa' }
  ],

  /* ---- WIDGET VIEW / KONTROL ---- */
  view:          'full',   // 'full' (tab lengkap) | 'water' | 'irrigation'
  irrigControl:  true,     // tampilkan tombol kontrol irigasi (kirim shared attribute ke device)
  manualMinutes: [5, 10, 15],

  /* 'level' = volume dihitung dari level% x kapasitas; 'firmware' = pakai *_vol_l mentah */
  volumeSource: 'level',
  offlineMs: 90000
};
/* ================================================================ */

var ROLES = ['gwt','flow','roof','irrG','irrR'];

self.onInit = function() {
  var ctx = self.ctx;
  var $root = (ctx.$container && ctx.$container[0]) ? ctx.$container[0] : document;
  var rootEl = $root.querySelector('[data-wtr-root]');
  if (!rootEl) return;

  var s = ctx.settings || {};
  ctx.cfg = {};
  Object.keys(USER_DEFAULTS).forEach(function(k){
    var v = s[k];
    ctx.cfg[k] = (v !== undefined && v !== null && v !== '') ? v : USER_DEFAULTS[k];
  });

  ctx.state = {
    rootEl: rootEl,
    dev: newDevs(),
    range: { preset:'24h', from:new Date(Date.now()-24*3600*1000), to:new Date() },
    events: []
  };
  ctx.$ = function(sel){ return rootEl.querySelector(sel); };

  setText(rootEl, 'systemName', ctx.cfg.systemName);
  setText(rootEl, 'systemSub',  ctx.cfg.systemSub);
  setText(rootEl, 'gwtT1Name',  ctx.cfg.gwtT1Label);
  setText(rootEl, 'gwtT2Name',  ctx.cfg.gwtT2Label);
  setText(rootEl, 'rwName',     ctx.cfg.rwLabel);
  setText(rootEl, 'transferName', ctx.cfg.transferLabel);
  setText(rootEl, 'p1Name',     ctx.cfg.pump1Label);
  setText(rootEl, 'p2Name',     ctx.cfg.pump2Label);
  setText(rootEl, 'flowScaleMax', String(Math.round(ctx.cfg.flowMaxLpm)));
  setText(rootEl, 'rwFlowScaleMax', String(Math.round(ctx.cfg.rwFlowMaxLpm)));
  setText(rootEl, 'pressScaleMax', String(Math.round(ctx.cfg.pressureMaxBar)));

  var fromEl = rootEl.querySelector('[data-from]');
  var toEl   = rootEl.querySelector('[data-to]');
  if (fromEl && toEl) {
    fromEl.value = isoDt(ctx.state.range.from);
    toEl.value   = isoDt(ctx.state.range.to);
    fromEl.addEventListener('change', function(){ var d=new Date(fromEl.value); if(!isNaN(d)){ctx.state.range.from=d; markCustom(rootEl); render();} });
    toEl.addEventListener('change',   function(){ var d=new Date(toEl.value);   if(!isNaN(d)){ctx.state.range.to=d;   markCustom(rootEl); render();} });
  }
  rootEl.querySelectorAll('[data-preset]').forEach(function(btn){
    btn.addEventListener('click', function(){
      rootEl.querySelectorAll('[data-preset]').forEach(function(b){ b.classList.remove('active'); });
      btn.classList.add('active');
      applyPreset(ctx, btn.getAttribute('data-preset'));
      var fEl=rootEl.querySelector('[data-from]'), tEl=rootEl.querySelector('[data-to]');
      if(fEl) fEl.value=isoDt(ctx.state.range.from);
      if(tEl) tEl.value=isoDt(ctx.state.range.to);
      render();
    });
  });

  // view / tabs
  ctx.state.ui = { open:{}, edit:{}, pending:{}, alertsAll:false };
  var view = ctx.cfg.view;
  if (view==='water' || view==='irrigation'){ rootEl.setAttribute('data-tab', view); rootEl.setAttribute('data-nonav','1'); }
  rootEl.querySelectorAll('[data-tab-btn]').forEach(function(b){
    b.setAttribute('role','tab');
    b.addEventListener('click', function(){
      rootEl.querySelectorAll('[data-tab-btn]').forEach(function(x){ x.classList.remove('active'); x.setAttribute('aria-selected','false'); });
      b.classList.add('active'); b.setAttribute('aria-selected','true'); setText(rootEl,'pageTitle', b.getAttribute('data-title')||''); rootEl.setAttribute('data-tab', b.getAttribute('data-tab-btn'));
      setTimeout(function(){ renderChart(ctx); renderIrrigChart(ctx); }, 0);
    });
  });
  var zwrap = rootEl.querySelector('[data-irrig-zones]');
  if (zwrap){
    zwrap.addEventListener('click', function(ev){ onZoneClick(ctx, ev); });
    zwrap.addEventListener('input', function(ev){
      var t=ev.target, zEl=t.closest&&t.closest('[data-zone]'); if(!zEl||!t.getAttribute('data-in')) return;
      var id=zEl.getAttribute('data-zone'); var e=ctx.state.ui.edit[id]||(ctx.state.ui.edit[id]={});
      e[t.getAttribute('data-in')]=t.value;
    });
  }

  // theme (terang/gelap) - disimpan per browser bila diizinkan
  var theme = (s.theme==='light'||s.theme==='dark') ? s.theme : 'dark';
  try { var sv = window.localStorage.getItem('nismara_theme'); if (sv==='light'||sv==='dark') theme = sv; } catch(e){}
  function applyTheme(t){ rootEl.setAttribute('data-theme', t); var tb=rootEl.querySelector('[data-theme-toggle]'); if(tb) tb.textContent = t==='dark' ? '☀️ Tema terang' : '🌙 Tema gelap'; }
  applyTheme(theme);
  var tgl = rootEl.querySelector('[data-theme-toggle]');
  if (tgl) tgl.addEventListener('click', function(){
    theme = rootEl.getAttribute('data-theme')==='dark' ? 'light' : 'dark'; applyTheme(theme);
    try { window.localStorage.setItem('nismara_theme', theme); } catch(e){}
    if (ctx._render) ctx._render();
  });
  var gardens = rootEl.querySelectorAll('[data-garden]');
  gardens.forEach(function(g){ g.addEventListener('click', function(ev){ var z=ev.target.closest('[data-goto]'); if(z) gotoTab(ctx, z.getAttribute('data-goto')); }); });
  // attention center, schematic click-through, chart hover, freshness timer
  var alertsEl = rootEl.querySelector('[data-alerts]');
  if (alertsEl) alertsEl.addEventListener('click', function(ev){
    var more=ev.target.closest('[data-alerts-more]'); if(more){ ctx.state.ui.alertsAll=!ctx.state.ui.alertsAll; renderAlerts(ctx); return; }
    var g=ev.target.closest('[data-goto]'); if(g) gotoTab(ctx, g.getAttribute('data-goto'));
  });
  var schem = rootEl.querySelector('[data-schematic]');
  if (schem) schem.addEventListener('click', function(ev){ var g=ev.target.closest('[data-goto]'); if(g) gotoTab(ctx, g.getAttribute('data-goto')); });
  ctx.state.models = {};
  attachHover(ctx, 'main', rootEl.querySelector('[data-chart]'));
  attachHover(ctx, 'irr', rootEl.querySelector('[data-chart-irr]'));
  ctx.state.timer = setInterval(function(){ updateAge(ctx); }, 1000);

  bindBtn(rootEl, 'csv',   function(){ exportCSV(ctx); });
  bindBtn(rootEl, 'print', function(){ window.print(); });

  function render() {
    rebuildDevices(ctx);
    rebuildEvents(ctx);
    renderHeader(ctx);
    renderSummary(ctx);
    renderSchematic(ctx);
    renderGWT(ctx);
    renderRain(ctx);
    renderTransfer(ctx);
    renderRoof(ctx);
    renderIrrigation(ctx);
    renderTrends(ctx);
    renderHero(ctx);
    renderGardenMap(ctx);
    renderArcs(ctx);
    renderSparks(ctx);
    renderAlerts(ctx);
    renderLive(ctx);
    renderRangeStats(ctx);
    renderChart(ctx);
    renderIrrigChart(ctx);
    renderEvents(ctx);
  }
  ctx._render = render;
  render();
};

self.onDataUpdated = function(){ if (self.ctx._render) self.ctx._render(); };
self.onResize = function(){ if (self.ctx && self.ctx.state) { renderChart(self.ctx); renderIrrigChart(self.ctx); } };
self.onDestroy = function(){ if (self.ctx && self.ctx.state && self.ctx.state.timer) clearInterval(self.ctx.state.timer); };

/* ============================ DATA LAYER ============================ */
function emptyDev(){ return { latest:{}, series:{}, name:null, lastTs:0, present:false }; }
function newDevs(){ return { gwt:emptyDev(), flow:emptyDev(), roof:emptyDev(), irrG:emptyDev(), irrR:emptyDev(), unknown:emptyDev() }; }

function rebuildDevices(ctx) {
  var data = ctx.data || [];
  var dev = newDevs();

  var buckets = {};
  data.forEach(function(d){
    if (!d || !d.dataKey) return;
    var ds = d.datasource || {};
    var id = String(ds.entityId || ds.entityName || ds.name || ('idx_'+(d.datasourceIndex!=null?d.datasourceIndex:0)));
    if (!buckets[id]) buckets[id] = { keys:{}, name: ds.entityLabel || ds.entityName || ds.name || id, entityId: ds.entityId, entityType: ds.entityType };
    buckets[id].keys[d.dataKey.name] = d.data || [];
  });

  Object.keys(buckets).forEach(function(id){
    var b = buckets[id];
    // klasifikasi hanya dari key yang BENAR-BENAR punya data (aman bila satu alias membawa semua key ke semua device)
    var live = {}; Object.keys(b.keys).forEach(function(k){ if (b.keys[k] && b.keys[k].length) live[k]=1; });
    var role = classifyRole(live, b.name);
    var t = dev[role] || dev.unknown;
    t.present = true; t.name = b.name; t.dsId = id; t.entityId = b.entityId; t.entityType = b.entityType || 'DEVICE';
    Object.keys(b.keys).forEach(function(key){
      var series = b.keys[key];
      t.series[key] = series;
      if (series && series.length) {
        var last = series[series.length-1];
        t.latest[key] = { value: parseFloat(last[1]), raw: last[1], ts: last[0] };
        if (last[0] > t.lastTs) t.lastTs = last[0];
      }
    });
  });
  ctx.state.dev = dev;
}

function classifyRole(keys, name) {
  var n = (name||'').toLowerCase();
  var kk = Object.keys(keys);
  if ('t1_level' in keys || 't2_level' in keys || 'balance_diff' in keys || 'balance_ok' in keys ||
      'rw_level' in keys || 'rw_flow_lpm' in keys || 'rw_total_liters' in keys) return 'gwt';
  if ('flow_lpm' in keys || 'total_liters' in keys || 'pump_running' in keys || 'pulses_win' in keys) return 'flow';
  if ('level_pct' in keys || 'pressure_bar' in keys || 'pump1_status' in keys || 'volume_l' in keys) return 'roof';
  // irrigation by keys (z1_soil1, z2_valve, ...)
  var hasZ = kk.some(function(k){ return /^z[1-9]_(soil|valve)/.test(k); });
  var isRoofName = n.indexOf('roof')>=0 || n.indexOf('atap')>=0 || n.indexOf('rooftop')>=0;
  if (hasZ) {
    if (isRoofName) return 'irrR';
    if ('z2_soil1' in keys || 'z2_soil2' in keys || 'z2_valve' in keys) return 'irrG';
    if (/lt\.?\s?1|garden|taman|ground|bawah/.test(n)) return 'irrG';
    return 'irrR';
  }
  if (n.indexOf('gwt')>=0 || n.indexOf('ground')>=0) return 'gwt';
  if (n.indexOf('flow')>=0 || n.indexOf('transfer')>=0) return 'flow';
  if (/irrig|garden|taman|soil/.test(n)) return isRoofName ? 'irrR' : 'irrG';
  if (isRoofName || n.indexOf('booster')>=0) return 'roof';
  return 'unknown';
}

/* accessors */
function L(ctx, role, key){ var d=ctx.state.dev[role]; return (d && d.latest[key]) ? d.latest[key] : null; }
function Lv(ctx, role, key){ var x=L(ctx,role,key); return (x && !isNaN(x.value)) ? x.value : null; }
function Lr(ctx, role, key){ var x=L(ctx,role,key); return x ? x.raw : null; }
function S(ctx, role, key){ var d=ctx.state.dev[role]; return (d && d.series[key]) ? d.series[key] : []; }
function devOnline(ctx, role){
  var d=ctx.state.dev[role];
  return !!(d && d.present && d.lastTs && (Date.now()-d.lastTs) < ctx.cfg.offlineMs);
}
function truthy(raw){
  if (raw===true) return true; if (raw===false || raw==null) return false;
  var s=String(raw).trim().toLowerCase();
  return s==='1'||s==='true'||s==='on'||s==='yes'||s==='open'||parseFloat(s)>=1;
}

/* ---- sensor-fault aware level helpers ----
   Ultrasonik HC-SR04 gagal baca => firmware kirim dist_cm = -1 dan level = 0.
   Itu BUKAN tangki kosong; kita tandai ERR dan keluarkan dari total/statistik. */
function tankErr(ctx, role, key, distKey){
  var v=Lv(ctx,role,key), d=distKey?Lv(ctx,role,distKey):null;
  return v!=null && d!=null && d<0;
}
function lvlOf(ctx, role, key, distKey){
  var v=Lv(ctx,role,key);
  if (v==null || tankErr(ctx,role,key,distKey)) return null;
  return v;
}
function volOf(ctx, role, levelKey, distKey, capCfgKey, fwVolKey){
  if (tankErr(ctx,role,levelKey,distKey)) return null;
  if (ctx.cfg.volumeSource === 'level'){
    var lvl=Lv(ctx,role,levelKey), cap=ctx.cfg[capCfgKey];
    if (lvl!=null && cap!=null && !isNaN(cap)) return (lvl/100)*cap;
  }
  return Lv(ctx,role,fwVolKey);
}
function vSeries(ctx, role, key, distKey){
  var ser=S(ctx,role,key), ds=distKey?S(ctx,role,distKey):[];
  if (!ds.length) return ser;
  var bad={}; ds.forEach(function(p){ if (parseFloat(p[1])<0) bad[p[0]]=1; });
  return ser.filter(function(p){ return !bad[p[0]]; });
}
function pctTxt(ctx, role, key, distKey, dp){
  if (tankErr(ctx,role,key,distKey)) return 'ERR';
  var v=Lv(ctx,role,key); return v==null?'--':v.toFixed(dp);
}
function distTxt(d){ return d==null?'--':(d<0?'ERR':d.toFixed(1)); }

/* ============================ IRRIGATION MODEL ============================ */
function zoneInfo(ctx, z){
  var cfg=ctx.cfg, dev=ctx.state.dev[z.role];
  var hasKeys = !!(dev && dev.present && (z.valve in dev.series || z.soil.some(function(k){ return k in dev.series; })));
  var raw = z.soil.map(function(k){ return Lv(ctx,z.role,k); });
  var soils = raw.map(function(v){ return (v!=null && v>=0 && v<=100) ? v : null; });
  var valid = soils.filter(function(v){ return v!=null; });
  var avg = valid.length ? valid.reduce(function(a,b){return a+b;},0)/valid.length : null;
  var pre = zPrefix(z);
  var tStart=Lv(ctx,z.role,pre+'_start_pct'), tStop=Lv(ctx,z.role,pre+'_stop_pct');
  var dry = tStart!=null ? tStart : (z.dry!=null?z.dry:cfg.soilDryPct), wet = z.wet!=null?z.wet:cfg.soilWetPct, target = tStop!=null ? tStop : (z.target!=null?z.target:cfg.soilTargetPct);
  var autoRaw=Lr(ctx,z.role,pre+'_auto'); var autoMode = autoRaw==null ? null : truthy(autoRaw);
  var inWin=Lv(ctx,z.role,'in_window'), winTxt=Lr(ctx,z.role,'win');
  var remainS=Lv(ctx,z.role,pre+'_remain_s')||0, cycles=Lv(ctx,z.role,pre+'_cycles'), fault=Lv(ctx,z.role,pre+'_fault')||0;
  var valveHas = L(ctx,z.role,z.valve)!=null;
  var on = valveHas && truthy(Lr(ctx,z.role,z.valve));
  var online = devOnline(ctx,z.role);
  var status = !hasKeys ? 'na' : (avg==null ? 'err' : avg<dry ? 'dry' : avg>wet ? 'wet' : 'ok');
  var mismatch = valid.length===2 && Math.abs(valid[0]-valid[1])>cfg.soilMismatchPct;

  var onMs=0;
  if (on){
    var ser=S(ctx,z.role,z.valve), since=null;
    for (var i=ser.length-1;i>=0;i--){ if (truthy(ser[i][1])) since=ser[i][0]; else break; }
    if (since!=null) onMs=Math.max(0, Date.now()-since);
  }
  var rainLvl = lvlOf(ctx,'gwt','rw_level','rw_dist_cm');
  var rainOk = rainLvl!=null && rainLvl>=cfg.rwLowPct;

  var msg;
  if (!hasKeys) msg='Belum ada data zona ini.';
  else if (fault===2 && online) msg='⚠ Valve dipaksa tutup (batas waktu siram tercapai) — cek debit/sensor.';
  else if (!online) msg='Device offline — data tidak terbaru.';
  else if (status==='err') msg='Sensor tanah error / di luar 0–100% — cek probe & kabel.';
  else if (on && remainS>0) msg='Siram manual · sisa '+formatRuntime(remainS)+'.';
  else if (on){
    if (avg>=wet) msg='Valve ON padahal tanah sudah basah — cek auto-stop / valve macet.';
    else if (onMs>cfg.valveMaxMin*60000) msg='Valve ON > '+cfg.valveMaxMin+' menit — periksa kebocoran / relay.';
    else msg='Sedang menyiram · target '+target+'%.';
  } else if (status==='dry' && autoMode===false){
    msg='Mode MANUAL — tanah kering ('+avg.toFixed(0)+'%), auto-siram nonaktif.';
  } else if (status==='dry' && autoMode!==false && inWin===0){
    msg='Kering ('+avg.toFixed(0)+'%) — menunggu jendela siram '+(winTxt||'')+'.';
  } else if (status==='dry'){
    msg='Perlu siram — '+(cfg.irrigSource==='rain' ? (rainOk?'air hujan tersedia.':'tangki hujan rendah, gunakan GWT.') : 'sumber GWT.');
  } else if (status==='wet') msg='Tanah basah — tidak perlu siram.';
  else msg='Kelembaban optimal.';
  if (hasKeys && mismatch) msg+=' ⚠ Selisih 2 sensor '+Math.abs(valid[0]-valid[1]).toFixed(0)+'%.';

  return { z:z, present:hasKeys, soils:soils, raw:raw, avg:avg, dry:dry, wet:wet, target:target,
           autoMode:autoMode, inWin:inWin, remainS:remainS, cycles:cycles, fault:fault, pre:pre, on:on, valveHas:valveHas, online:online, status:status, mismatch:mismatch, onMs:onMs, msg:msg };
}

/* avg soil per zona sbg time series (forward-fill kedua sensor) */
function zoneAvgSeries(ctx, z){
  var sers=z.soil.map(function(k){ return S(ctx,z.role,k); });
  var tsSet={};
  sers.forEach(function(se){ se.forEach(function(p){ tsSet[p[0]]=1; }); });
  var all=Object.keys(tsSet).map(Number).sort(function(a,b){return a-b;});
  var idx=sers.map(function(){return 0;}), last=sers.map(function(){return null;});
  var out=[];
  all.forEach(function(ts){
    sers.forEach(function(se,i){
      while (idx[i]<se.length && se[idx[i]][0]<=ts){ var v=parseFloat(se[idx[i]][1]); last[i]=(!isNaN(v)&&v>=0&&v<=100)?v:null; idx[i]++; }
    });
    var vals=last.filter(function(v){return v!=null;});
    if (vals.length) out.push([ts, vals.reduce(function(a,b){return a+b;},0)/vals.length]);
  });
  return out;
}
function onDurationMs(series, fromTs, toTs){
  var tot=0, on=false, since=0;
  series.forEach(function(p){
    var cur=truthy(p[1]);
    if (cur && !on){ on=true; since=p[0]; }
    else if (!cur && on){ on=false; tot+=clip(since,p[0]); }
  });
  if (on) tot+=clip(since, Math.min(toTs, Date.now()));
  return tot;
  function clip(a,b){ a=Math.max(a,fromTs); b=Math.min(b,toTs); return b>a?b-a:0; }
}
function zPrefix(z){ return String(z.valve).split('_')[0]; }
function zoneFlow(ctx,z){ return z.flowLpm!=null ? z.flowLpm : ctx.cfg.zoneFlowLpm; }

/* ============================ EVENTS ============================ */
function rebuildEvents(ctx) {
  var fromTs=ctx.state.range.from.getTime(), toTs=ctx.state.range.to.getTime();
  var ev=[];

  var balSeries=S(ctx,'gwt','balance_ok');
  if (balSeries.length){
    var prev=null;
    balSeries.forEach(function(p){
      var cur=truthy(p[1]);
      if (prev!==null && cur!==prev && p[0]>=fromTs && p[0]<=toTs){
        ev.push({ ts:p[0], type: cur?'GWT Balance RECOVERED':'GWT Balance LOST', cls: cur?'on':'bad', badge: cur?'OK':'IMBALANCE' });
      }
      prev=cur;
    });
  }

  // rain collecting start/stop
  var rf=S(ctx,'gwt','rw_flow_lpm'), rprev=null;
  rf.forEach(function(p){
    var v=parseFloat(p[1]); if (isNaN(v)) return;
    var cur=v>=ctx.cfg.rwFlowActiveLpm;
    if (rprev!==null && cur!==rprev && p[0]>=fromTs && p[0]<=toTs)
      ev.push({ ts:p[0], type: cur?'Rain collection START':'Rain collection STOP', cls:'rain', badge: cur?'RAIN':'END' });
    rprev=cur;
  });

  transitionEvents(S(ctx,'flow','pump_running'), fromTs, toTs, ctx.cfg.transferLabel, ev);
  transitionEvents(S(ctx,'roof','pump1_status'), fromTs, toTs, ctx.cfg.pump1Label, ev);
  transitionEvents(S(ctx,'roof','pump2_status'), fromTs, toTs, ctx.cfg.pump2Label, ev);

  [['alarm_level_low','Roof LEVEL LOW'],['alarm_level_high','Roof LEVEL HIGH'],
   ['alarm_press_low','Roof PRESS LOW'],['alarm_press_high','Roof PRESS HIGH']].forEach(function(a){
    var ser=S(ctx,'roof',a[0]); var prev=0;
    ser.forEach(function(p){
      var v=parseFloat(p[1]); if(isNaN(v)) return;
      if (v>=1 && prev<1 && p[0]>=fromTs && p[0]<=toTs) ev.push({ ts:p[0], type:a[1], cls:'warn', badge:'ALARM' });
      prev=v;
    });
  });

  // irrigation: valve + dry detect
  ctx.cfg.irrigZones.forEach(function(z){
    transitionEvents(S(ctx,z.role,z.valve), fromTs, toTs, z.label+' valve', ev, 'OPEN', 'CLOSE');
    var dry = z.dry!=null?z.dry:ctx.cfg.soilDryPct, pd=null;
    zoneAvgSeries(ctx,z).forEach(function(p){
      var cur=p[1]<dry;
      if (pd!==null && cur && !pd && p[0]>=fromTs && p[0]<=toTs)
        ev.push({ ts:p[0], type:z.label+' kering ('+p[1].toFixed(0)+'%)', cls:'warn', badge:'DRY' });
      pd=cur;
    });
  });

  ev.sort(function(a,b){ return b.ts-a.ts; });
  ctx.state.events=ev;
}
function transitionEvents(series, fromTs, toTs, label, out, onB, offB){
  var prev=null;
  series.forEach(function(p){
    var cur=truthy(p[1]);
    if (prev!==null && cur!==prev && p[0]>=fromTs && p[0]<=toTs){
      out.push({ ts:p[0], type: label+(cur?' ON':' OFF'), cls: cur?'on':'off', badge: cur?(onB||'START'):(offB||'STOP') });
    }
    prev=cur;
  });
}

/* ============================ RENDER: HEADER ============================ */
function renderHeader(ctx){
  var rootEl=ctx.state.rootEl;
  var anyOnline=false, anyPresent=false, allOnline=true, lastTs=0;
  ROLES.forEach(function(r){
    var d=ctx.state.dev[r];
    if (d.present){ anyPresent=true; if(d.lastTs>lastTs) lastTs=d.lastTs; }
    var on=devOnline(ctx,r);
    if (d.present){ if(on) anyOnline=true; else allOnline=false; }
  });

  var statusEl=ctx.$('[data-bind="status"]');
  if (statusEl){
    var cls, txt;
    if (!anyPresent){ cls='offline'; txt='NO DATA'; }
    else if (anyOnline && allOnline){ cls=''; txt='LIVE'; }
    else if (anyOnline){ cls='degraded'; txt='PARTIAL'; }
    else { cls='offline'; txt='OFFLINE'; }
    statusEl.className='wtr-status '+cls;
    statusEl.innerHTML=' '+txt;
  }
  ctx.state.lastDataTs=lastTs;
  var d=new Date(lastTs||Date.now());
  setText(rootEl,'updated', pad2(d.getHours())+':'+pad2(d.getMinutes())+':'+pad2(d.getSeconds()));

  [['gwt','chipGwt'],['flow','chipFlow'],['roof','chipRoof'],['irrG','chipIrrG'],['irrR','chipIrrR']].forEach(function(x){
    setDevChip(ctx,x[0],x[1], devOnline(ctx,x[0]), ctx.state.dev[x[0]].present);
  });

  toggle(ctx,'[data-gwt-section]', ctx.state.dev.gwt.present);
  toggle(ctx,'[data-rain-section]', hasRain(ctx));
  toggle(ctx,'[data-transfer-section]', ctx.state.dev.flow.present);
  toggle(ctx,'[data-roof-section]', ctx.state.dev.roof.present);
  var irr = ctx.state.dev.irrG.present || ctx.state.dev.irrR.present;
  toggle(ctx,'[data-irrig-section]', irr);
  toggle(ctx,'[data-garden-section]', irr);
  toggle(ctx,'[data-irrig-chart-section]', irr);
}
function hasRain(ctx){ return !!(L(ctx,'gwt','rw_level') || L(ctx,'gwt','rw_flow_lpm') || L(ctx,'gwt','rw_total_liters')); }
function setDevChip(ctx, role, bindKey, online, present){
  var chip=ctx.$('[data-dev-chip="'+role+'"]');
  if (chip){ chip.classList.toggle('online', online); chip.classList.toggle('offline', present && !online); chip.style.display = present?'':'none'; }
  setText(ctx.state.rootEl, bindKey, !present ? 'n/a' : (online?'online':'offline'));
}
function toggle(ctx, sel, show){ var el=ctx.$(sel); if(el) el.style.display = show?'':'none'; }

/* ============================ RENDER: SUMMARY ============================ */
function renderSummary(ctx){
  var rootEl=ctx.state.rootEl;
  var gwtTot = sumVol(volOf(ctx,'gwt','t1_level','t1_dist_cm','gwtT1CapacityL','t1_vol_l'),
                      volOf(ctx,'gwt','t2_level','t2_dist_cm','gwtT2CapacityL','t2_vol_l'));
  var roofVol = volOf(ctx,'roof','level_pct','distance_cm','roofTankCapacityL','volume_l');
  var rwVol = hasRain(ctx) ? volOf(ctx,'gwt','rw_level','rw_dist_cm','rwCapacityL','rw_vol_l') : null;
  var parts=[gwtTot,roofVol,rwVol].filter(function(x){return x!=null;});
  var total = parts.length ? parts.reduce(function(a,b){return a+b;},0) : null;
  setText(rootEl,'sysStored', total==null?'--':formatVol(total));
  setText(rootEl,'sysStoredFoot', 'GWT '+(gwtTot==null?'--':formatVol(gwtTot))+' · Roof '+(roofVol==null?'--':formatVol(roofVol))+' · Rain '+(rwVol==null?'--':formatVol(rwVol)));

  var flow=Lv(ctx,'flow','flow_lpm');
  var running=ctx.state.dev.flow.present ? truthy(Lr(ctx,'flow','pump_running')) : false;
  setText(rootEl,'sysFlow', flow==null?'--':flow.toFixed(1));
  var foot='pump idle';
  if (running && flow!=null && flow<ctx.cfg.flowDryRunLpm) foot='⚠ running, no flow';
  else if (running) foot='transferring ➜ roof';
  setText(rootEl,'sysFlowFoot', foot);

  var bdiff=Lv(ctx,'gwt','balance_diff');
  var bok = ctx.state.dev.gwt.present ? truthy(Lr(ctx,'gwt','balance_ok')) : null;
  var t1e=tankErr(ctx,'gwt','t1_level','t1_dist_cm'), t2e=tankErr(ctx,'gwt','t2_level','t2_dist_cm');
  var sb=ctx.$('[data-bind="sysBalance"]');
  if (t1e || t2e){
    setText(rootEl,'sysBalance','SENSOR ERR'); if(sb) sb.style.color='var(--danger)';
    setText(rootEl,'sysBalanceFoot', (t1e&&t2e)?'T1 & T2 tidak terbaca':(t1e?'T1 tidak terbaca':'T2 tidak terbaca'));
  } else if (bdiff==null && bok==null){ setText(rootEl,'sysBalance','--'); setText(rootEl,'sysBalanceFoot','T1 vs T2'); }
  else {
    setText(rootEl,'sysBalance', (bok? 'BALANCED':'IMBALANCE'));
    if(sb) sb.style.color = bok?'var(--success)':'var(--danger)';
    setText(rootEl,'sysBalanceFoot', bdiff==null?'T1 vs T2':('Δ '+bdiff.toFixed(1)+'%'));
  }

  var tot=Lv(ctx,'flow','total_liters');
  setText(rootEl,'sysTotalizer', tot==null?'--':formatVol(tot));

  // rain
  var rt=Lv(ctx,'gwt','rw_total_liters'), rflow=Lv(ctx,'gwt','rw_flow_lpm');
  setText(rootEl,'sysRain', rt==null?'--':formatVol(rt));
  setText(rootEl,'sysRainFoot', rflow==null?'rain flow totalizer':(rflow>=ctx.cfg.rwFlowActiveLpm?('🌧 collecting '+rflow.toFixed(1)+' L/min'):'tidak ada aliran'));

  // irrigation
  var infos=ctx.cfg.irrigZones.map(function(z){return zoneInfo(ctx,z);}).filter(function(i){return i.present;});
  var act=infos.filter(function(i){return i.on;}).length;
  var avgs=infos.filter(function(i){return i.avg!=null;}).map(function(i){return i.avg;});
  setText(rootEl,'sysIrrig', infos.length? (act+'/'+infos.length) : '--');
  setText(rootEl,'sysIrrigFoot', avgs.length ? ('avg soil '+(avgs.reduce(function(a,b){return a+b;},0)/avgs.length).toFixed(0)+'%') : 'avg soil --');
}
function sumVol(a,b){ if(a==null&&b==null) return null; return (a||0)+(b||0); }

/* ============================ RENDER: SCHEMATIC ============================ */
function renderSchematic(ctx){
  var svg=ctx.$('[data-schematic]'); if(!svg) return;
  var gwtPresent=ctx.state.dev.gwt.present, flowPresent=ctx.state.dev.flow.present, roofPresent=ctx.state.dev.roof.present;
  var t1=lvlOf(ctx,'gwt','t1_level','t1_dist_cm'), t2=lvlOf(ctx,'gwt','t2_level','t2_dist_cm');
  var t1e=tankErr(ctx,'gwt','t1_level','t1_dist_cm'), t2e=tankErr(ctx,'gwt','t2_level','t2_dist_cm');
  var flow=Lv(ctx,'flow','flow_lpm');
  var running=flowPresent && truthy(Lr(ctx,'flow','pump_running'));
  var roofLvl=lvlOf(ctx,'roof','level_pct','distance_cm');
  var boosterOn = roofPresent && (truthy(Lr(ctx,'roof','pump1_status'))||truthy(Lr(ctx,'roof','pump2_status')));
  var press=Lv(ctx,'roof','pressure_bar');

  var gx=130, px=460, rx=760, bx=940, midY=120;

  var glyphN=0;
  function tankGlyph(cx, topY, w, h, pct, color, err){
    // silinder 3D (sama dengan kartu tangki): h = tinggi total termasuk elips atas & bawah
    var ry=Math.max(4,Math.min(10,w*0.12)), body=h-2*ry;
    var s=cyl(cx-w/2, topY+ry, w, body, err?0:pct, color, 'sc'+(glyphN++), false);
    if (err) s+='<path d="M'+(cx-w/2)+','+(topY+ry)+' L'+(cx-w/2)+','+(topY+ry+body)+' A'+(w/2)+','+ry+' 0 0 0 '+(cx+w/2)+','+(topY+ry+body)+' L'+(cx+w/2)+','+(topY+ry)+'" fill="none" stroke="#ef4444" stroke-width="2"/>'+
      '<ellipse cx="'+cx+'" cy="'+(topY+ry)+'" rx="'+(w/2)+'" ry="'+ry+'" fill="none" stroke="#ef4444" stroke-width="2"/>'+
      '<text x="'+cx+'" y="'+(topY+h/2+4)+'" text-anchor="middle" fill="#ef4444" font-size="11" font-weight="800">ERR</text>';
    return s;
  }

  var c='';
  c += pipe(gx+46, midY, px-34, midY, running, '');
  c += pipe(px+34, midY, rx-90, midY, running, '');
  c += pipe(rx+70, midY, bx-26, midY, boosterOn, '');

  // GWT
  if (gwtPresent){
    c += tankGlyph(gx-26, 60, 38, 110, t1, '#38bdf8', t1e);
    c += tankGlyph(gx+26, 60, 38, 110, t2, '#0ea5e9', t2e);
    c += label(gx, 50, 'GWT', '#38bdf8', 11, 700);
    c += label(gx, 188, (t1e?'ERR':(t1==null?'--':t1.toFixed(0)+'%'))+' / '+(t2e?'ERR':(t2==null?'--':t2.toFixed(0)+'%')), '#cbd5e1', 11, 700);
    if (!t1e && !t2e && L(ctx,'gwt','balance_ok')!=null){
      var bok=truthy(Lr(ctx,'gwt','balance_ok'));
      c += badge(gx, 206, bok?'⚖ balanced':'⚠ imbalance', bok?'#10b981':'#ef4444');
    } else if (t1e||t2e) c += badge(gx, 206, '⚠ sensor error', '#ef4444');
  } else c += ghost(gx, midY, 'GWT');

  // PUMP
  if (flowPresent){
    var pr=34;
    c += '<circle cx="'+px+'" cy="'+midY+'" r="'+pr+'" fill="'+(running?'rgba(167,139,250,0.18)':'rgba(148,163,184,0.06)')+'" stroke="'+(running?'#a78bfa':'rgba(148,163,184,.4)')+'" stroke-width="2"/>';
    var imp='<g'+(running?' class="wtr-spin"':'')+'>';
    for (var k=0;k<4;k++){ imp+='<rect x="'+(px-2.2)+'" y="'+(midY-pr+8)+'" width="4.4" height="'+(pr-8)+'" rx="2" fill="'+(running?'#a78bfa':'#64748b')+'" transform="rotate('+(k*45)+' '+px+' '+midY+')"/>'; }
    imp+='<circle cx="'+px+'" cy="'+midY+'" r="5" fill="'+(running?'#c4b5fd':'#94a3b8')+'"/></g>';
    c += imp;
    c += label(px, 50, ctx.cfg.transferLabel.toUpperCase(), '#a78bfa', 10, 700);
    c += label(px, 188, (flow==null?'--':flow.toFixed(1))+' L/min', '#cbd5e1', 11, 700);
    var dry = running && flow!=null && flow<ctx.cfg.flowDryRunLpm;
    c += badge(px, 206, running?(dry?'⚠ no flow':'● running'):'○ idle', running?(dry?'#ef4444':'#10b981'):'#64748b');
  } else c += ghost(px, midY, 'PUMP');

  // ROOF
  if (roofPresent){
    var re=tankErr(ctx,'roof','level_pct','distance_cm');
    c += tankGlyph(rx, 56, 70, 116, roofLvl, '#06b6d4', re);
    c += label(rx, 46, 'ROOF', '#06b6d4', 11, 700);
    c += label(rx, 188, (re?'ERR':(roofLvl==null?'--':roofLvl.toFixed(0))+'%')+(press==null?'':('  ·  '+press.toFixed(1)+' bar')), '#cbd5e1', 11, 700);
    c += badge(rx, 206, boosterOn?'● booster on':'○ booster off', boosterOn?'#10b981':'#64748b');
  } else c += ghost(rx, midY, 'ROOF');

  // BUILDING
  c += '<rect x="'+(bx-22)+'" y="78" width="44" height="84" rx="3" fill="rgba(255,255,255,.04)" stroke="rgba(148,163,184,.4)" stroke-width="1.5"/>';
  for (var wy=0; wy<3; wy++) for (var wx=0; wx<2; wx++)
    c += '<rect x="'+(bx-14+wx*16)+'" y="'+(88+wy*22)+'" width="9" height="9" rx="1" fill="rgba(34,211,238,.35)"/>';
  c += label(bx, 70, 'GEDUNG', '#94a3b8', 9, 700);

  /* ---------- ROW 2 : RAIN -> flow meter -> GARDEN LT.1 -> GARDEN ROOF ---------- */
  var y2=290;
  if (hasRain(ctx)){
    var rwP=lvlOf(ctx,'gwt','rw_level','rw_dist_cm'), rwE=tankErr(ctx,'gwt','rw_level','rw_dist_cm');
    var rwF=Lv(ctx,'gwt','rw_flow_lpm'), rwOn = rwF!=null && rwF>=ctx.cfg.rwFlowActiveLpm;
    var anyIrrOn = ctx.cfg.irrigZones.some(function(z){ var i=zoneInfo(ctx,z); return i.present && i.on; });
    var roofIrrOn = ctx.cfg.irrigZones.some(function(z){ var i=zoneInfo(ctx,z); return i.present && i.on && z.role==='irrR'; });

    c += '<text x="'+gx+'" y="240" text-anchor="middle" font-size="16">'+(rwOn?'🌧️':'☁️')+'</text>';
    c += tankGlyph(gx, 250, 56, 72, rwP, '#2dd4bf', rwE);
    c += label(gx, 344, 'RAIN '+(rwE?'ERR':(rwP==null?'--':rwP.toFixed(0)+'%')), '#2dd4bf', 11, 700);

    // flow meter
    var fx=290;
    c += pipe(gx+30, y2, fx-20, y2, rwOn, 'rain');
    c += '<circle cx="'+fx+'" cy="'+y2+'" r="18" fill="'+(rwOn?'rgba(45,212,191,.18)':'rgba(148,163,184,.06)')+'" stroke="'+(rwOn?'#2dd4bf':'rgba(148,163,184,.4)')+'" stroke-width="2"/>';
    c += label(fx, y2+4, (rwF==null?'--':rwF.toFixed(1)), rwOn?'#2dd4bf':'#94a3b8', 10, 800);
    c += label(fx, y2+34, 'L/min', '#64748b', 9, 600);
    c += pipe(fx+18, y2, px-84, y2, anyIrrOn, 'irr');
  }

  var irrCfg=[['irrG','GARDEN LT.1',px],['irrR','GARDEN ROOF',rx]];
  irrCfg.forEach(function(g){
    var role=g[0], cx=g[2], zs=ctx.cfg.irrigZones.filter(function(z){return z.role===role;});
    if (!ctx.state.dev[role].present){ c += ghost(cx, y2, g[1]); return; }
    c += '<rect x="'+(cx-80)+'" y="252" width="160" height="76" rx="8" fill="rgba(52,211,153,.05)" stroke="rgba(52,211,153,.35)" stroke-width="1.5"/>';
    c += label(cx, 268, g[1], '#34d399', 10, 700);
    var n=zs.length;
    zs.forEach(function(z,i){
      var inf=zoneInfo(ctx,z), zx = n===1 ? cx : cx-35+i*70;
      var ring = inf.status==='dry'?'#f59e0b':inf.status==='wet'?'#60a5fa':inf.status==='err'?'#ef4444':'#10b981';
      c += '<circle cx="'+zx+'" cy="292" r="11" fill="'+(inf.on?'rgba(16,185,129,.35)':'rgba(148,163,184,.08)')+'" stroke="'+ring+'" stroke-width="2"/>';
      c += '<text x="'+zx+'" y="296" text-anchor="middle" font-size="11">'+(inf.on?'💦':'🌱')+'</text>';
      c += label(zx, 314, 'Z'+(i+1)+' '+(inf.avg==null?'--':inf.avg.toFixed(0)+'%'), '#cbd5e1', 9.5, 700);
    });
  });
  if (ctx.state.dev.irrG.present && ctx.state.dev.irrR.present){
    var rOn = ctx.cfg.irrigZones.some(function(z){ var i=zoneInfo(ctx,z); return i.present && i.on && z.role==='irrR'; });
    c = pipe(px+80, y2, rx-80, y2, rOn, 'irr') + c;
  }

  function hit(x,y,w,h,tab,title){ return '<rect data-goto="'+tab+'" x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" fill="transparent"><title>'+title+'</title></rect>'; }
  c += hit(60,40,150,185,'water','Buka tab Water') + hit(405,40,110,185,'water','Buka tab Water') + hit(690,35,140,190,'water','Buka tab Water');
  if (hasRain(ctx)) c += hit(90,225,100,125,'water','Buka tab Water');
  c += hit(375,246,170,86,'irrigation','Buka tab Irrigation') + hit(675,246,170,86,'irrigation','Buka tab Irrigation');
  svg.innerHTML=c;

  function pipe(x1,y1,x2,y2_,active,kind){
    return '<line class="wtr-flow-pipe'+(kind?' '+kind:'')+(active?' active':'')+'" x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2_+'"/>'+
           '<path d="M'+(x2)+','+y2_+' l-9,-5 l0,10 z" fill="'+(active?(kind==='rain'?'#2dd4bf':kind==='irr'?'#34d399':'#22d3ee'):'rgba(148,163,184,.35)')+'"/>';
  }
  function label(cx,y,txt,color,size,weight){ return '<text x="'+cx+'" y="'+y+'" text-anchor="middle" fill="'+color+'" font-size="'+size+'" font-weight="'+(weight||600)+'">'+esc(txt)+'</text>'; }
  function badge(cx,y,txt,color){ return '<text x="'+cx+'" y="'+y+'" text-anchor="middle" fill="'+color+'" font-size="9.5" font-weight="700">'+esc(txt)+'</text>'; }
  function ghost(cx,cy,txt){ return '<rect x="'+(cx-40)+'" y="'+(cy-40)+'" width="80" height="80" rx="8" fill="none" stroke="rgba(148,163,184,.18)" stroke-width="1.5" stroke-dasharray="5,5"/>'+label(cx,cy+4,txt+' n/a','#475569',10,600); }
}

/* ============================ RENDER: GWT ============================ */
function renderGWT(ctx){
  if (!ctx.state.dev.gwt.present) return;
  var rootEl=ctx.state.rootEl;
  var t1=lvlOf(ctx,'gwt','t1_level','t1_dist_cm'), t2=lvlOf(ctx,'gwt','t2_level','t2_dist_cm');
  var t1e=tankErr(ctx,'gwt','t1_level','t1_dist_cm'), t2e=tankErr(ctx,'gwt','t2_level','t2_dist_cm');
  var v1=volOf(ctx,'gwt','t1_level','t1_dist_cm','gwtT1CapacityL','t1_vol_l'),
      v2=volOf(ctx,'gwt','t2_level','t2_dist_cm','gwtT2CapacityL','t2_vol_l');
  var d1=Lv(ctx,'gwt','t1_dist_cm'), d2=Lv(ctx,'gwt','t2_dist_cm');

  setText(rootEl,'gwtT1Pct', pctTxt(ctx,'gwt','t1_level','t1_dist_cm',1));
  setText(rootEl,'gwtT2Pct', pctTxt(ctx,'gwt','t2_level','t2_dist_cm',1));
  setText(rootEl,'gwtT1Vol', v1==null?'--':formatVol(v1));
  setText(rootEl,'gwtT2Vol', v2==null?'--':formatVol(v2));
  setText(rootEl,'gwtT1Dist', distTxt(d1));
  setText(rootEl,'gwtT2Dist', distTxt(d2));

  drawTank(ctx, ctx.$('[data-gwt-svg="1"]'), t1, 120, 200, '#38bdf8');
  drawTank(ctx, ctx.$('[data-gwt-svg="2"]'), t2, 120, 200, '#0ea5e9');
  tankCardClass(ctx.$('[data-gwt-tank="1"]'), t1, t1e);
  tankCardClass(ctx.$('[data-gwt-tank="2"]'), t2, t2e);

  var tot=sumVol(v1,v2);
  setText(rootEl,'gwtTotal', tot==null?'--':formatVol(tot));

  var bdiff=Lv(ctx,'gwt','balance_diff');
  var bok = truthy(Lr(ctx,'gwt','balance_ok'));
  var hasBok = L(ctx,'gwt','balance_ok')!=null;
  if (t1!=null && t2!=null) bdiff = bdiff!=null ? bdiff : Math.abs(t1-t2);

  var stateEl=ctx.$('[data-bind-class="balanceState"]');
  var iconEl=ctx.$('[data-bind="balanceIcon"]');
  var textEl=ctx.$('[data-bind="balanceText"]');
  var sensorFault = t1e || t2e;
  var ok = sensorFault ? false : (hasBok ? bok : (bdiff!=null ? bdiff<=ctx.cfg.gwtBalanceWarnPct : true));
  if (stateEl){
    stateEl.className='wtr-balance-state '+(ok?'ok':'bad');
    if(iconEl) iconEl.textContent= sensorFault?'🔌':(ok?'⚖️':'⚠️');
    if(textEl) textEl.textContent= sensorFault?'SENSOR ERROR':(ok?'BALANCED':'IMBALANCE');
  }
  var fill=ctx.$('[data-bind-style="balanceFill"]');
  if (fill){
    var pct = (sensorFault||bdiff==null)?0:Math.min(100,(bdiff/(ctx.cfg.gwtBalanceWarnPct*2))*100);
    fill.style.width=pct.toFixed(0)+'%';
  }
  setText(rootEl,'balanceNote', sensorFault
    ? 'Sensor ultrasonik '+(t1e&&t2e?'T1 & T2':(t1e?'T1':'T2'))+' tidak terbaca (dist = -1). Cek wiring TRIG/ECHO, supply 5V, dan jarak minimum sensor. Balance tidak valid.'
    : ((bdiff==null?'Selisih level T1 vs T2.':('Selisih T1−T2 = '+bdiff.toFixed(1)+'% (threshold '+ctx.cfg.gwtBalanceWarnPct+'%). ')) +
       (ok?'Kedua tank seimbang.':'Cek valve balancing / suplai tidak merata.')));
}
function tankCardClass(card, pct, err){
  if(!card) return;
  card.classList.remove('lvl-ok','lvl-warn','lvl-low','lvl-err');
  if (err){ card.classList.add('lvl-err'); return; }
  if (pct==null) return;
  if (pct<20) card.classList.add('lvl-low');
  else if (pct<35) card.classList.add('lvl-warn');
  else card.classList.add('lvl-ok');
}

/* ============================ RENDER: RAIN ============================ */
function renderRain(ctx){
  if (!hasRain(ctx)) return;
  var rootEl=ctx.state.rootEl, cfg=ctx.cfg;
  var pct=lvlOf(ctx,'gwt','rw_level','rw_dist_cm'), err=tankErr(ctx,'gwt','rw_level','rw_dist_cm'), flowNow=Lv(ctx,'gwt','rw_flow_lpm');
  var vol=volOf(ctx,'gwt','rw_level','rw_dist_cm','rwCapacityL','rw_vol_l');
  var dist=Lv(ctx,'gwt','rw_dist_cm');
  setText(rootEl,'rwPct', pctTxt(ctx,'gwt','rw_level','rw_dist_cm',1));
  setText(rootEl,'rwVol', vol==null?'--':formatVol(vol));
  setText(rootEl,'rwDist', distTxt(dist));
  setText(rootEl,'rwCap', formatVol(cfg.rwCapacityL));
  drawTank(ctx, ctx.$('[data-rw-svg]'), pct, 120, 200, '#2dd4bf');
  tankCardClass(ctx.$('[data-rw-tank]'), pct, err);
  var rcard=ctx.$('[data-rw-tank]'); if(rcard) rcard.classList.toggle('collecting', flowNow!=null && flowNow>=cfg.rwFlowActiveLpm);
  setText(rootEl,'rwTankTag', err?'SENSOR ERR': pct==null?'--': pct>=cfg.rwOverflowPct?'FULL': pct<cfg.rwLowPct?'LOW':'OK');

  var flow=Lv(ctx,'gwt','rw_flow_lpm'), tot=Lv(ctx,'gwt','rw_total_liters');
  setText(rootEl,'rwFlow', flow==null?'--':flow.toFixed(2));
  var fill=ctx.$('[data-bind-style="rwFlowFill"]');
  if (fill) fill.style.width = (flow==null?0:Math.min(100,flow/cfg.rwFlowMaxLpm*100)).toFixed(1)+'%';
  var tag=ctx.$('[data-bind="rwFlowTag"]');
  if (tag){
    if (flow==null){ tag.className='wtr-tag neutral'; tag.textContent='--'; }
    else if (flow>=cfg.rwFlowActiveLpm){ tag.className='wtr-tag success'; tag.textContent='COLLECTING'; }
    else { tag.className='wtr-tag neutral'; tag.textContent='IDLE'; }
  }
  if (tot==null){ setText(rootEl,'rwTotMain','--'); setText(rootEl,'rwTotUnit',''); setText(rootEl,'rwTotLiters','-- L'); }
  else if (tot>=1000){ setText(rootEl,'rwTotMain',(tot/1000).toFixed(2)); setText(rootEl,'rwTotUnit','m³'); setText(rootEl,'rwTotLiters',Math.round(tot).toLocaleString()+' L'); }
  else { setText(rootEl,'rwTotMain',tot.toFixed(0)); setText(rootEl,'rwTotUnit','L'); setText(rootEl,'rwTotLiters',tot.toFixed(0)+' L'); }
}

/* ============================ RENDER: TRANSFER ============================ */
function renderTransfer(ctx){
  if (!ctx.state.dev.flow.present) return;
  var rootEl=ctx.state.rootEl;
  var flow=Lv(ctx,'flow','flow_lpm');
  var running=truthy(Lr(ctx,'flow','pump_running'));
  var tot=Lv(ctx,'flow','total_liters');
  var pulses=Lv(ctx,'flow','pulses_win');
  var up=Lv(ctx,'flow','uptime_s');

  setText(rootEl,'flowLpm', flow==null?'--':flow.toFixed(2));
  setText(rootEl,'pulsesWin', pulses==null?'--':Math.round(pulses));
  setText(rootEl,'transferUptime', up==null?'--':formatUptime(up));

  var fill=ctx.$('[data-bind-style="flowFill"]');
  if (fill) fill.style.width=(flow==null?0:Math.min(100,(flow/ctx.cfg.flowMaxLpm)*100)).toFixed(1)+'%';
  var tag=ctx.$('[data-bind="flowTag"]');
  if (tag){
    if (flow==null){ tag.className='wtr-tag neutral'; tag.textContent='--'; }
    else if (running && flow<ctx.cfg.flowDryRunLpm){ tag.className='wtr-tag danger'; tag.textContent='DRY-RUN'; }
    else if (running){ tag.className='wtr-tag success'; tag.textContent='FLOWING'; }
    else if (flow>=ctx.cfg.flowDryRunLpm){ tag.className='wtr-tag warning'; tag.textContent='FLOW, PUMP OFF?'; }
    else { tag.className='wtr-tag neutral'; tag.textContent='IDLE'; }
  }
  setText(rootEl,'pumpState', running?'RUNNING':'STOPPED');
  var pstEl=ctx.$('[data-bind="pumpState"]'); if(pstEl) pstEl.style.color = running?'var(--success)':'var(--text-3)';
  var card=ctx.$('[data-transfer-pump]'); if(card) card.classList.toggle('on', running);

  if (tot==null){ setText(rootEl,'totalizerMain','--'); setText(rootEl,'totalizerUnit',''); setText(rootEl,'totalizerLiters','-- L'); }
  else if (tot>=1000){ setText(rootEl,'totalizerMain',(tot/1000).toFixed(2)); setText(rootEl,'totalizerUnit','m³'); setText(rootEl,'totalizerLiters',Math.round(tot).toLocaleString()+' L'); }
  else { setText(rootEl,'totalizerMain',tot.toFixed(0)); setText(rootEl,'totalizerUnit','L'); setText(rootEl,'totalizerLiters',tot.toFixed(0)+' L'); }
}

/* ============================ RENDER: ROOF ============================ */
function renderRoof(ctx){
  if (!ctx.state.dev.roof.present) return;
  var rootEl=ctx.state.rootEl;
  var pct=lvlOf(ctx,'roof','level_pct','distance_cm'), err=tankErr(ctx,'roof','level_pct','distance_cm');
  var vol=volOf(ctx,'roof','level_pct','distance_cm','roofTankCapacityL','volume_l');
  var dist=Lv(ctx,'roof','distance_cm');
  setText(rootEl,'roofPct', pctTxt(ctx,'roof','level_pct','distance_cm',1));
  setText(rootEl,'roofVol', vol==null?'--':formatVol(vol));
  setText(rootEl,'roofDist', distTxt(dist));
  setText(rootEl,'roofCap', formatVol(ctx.cfg.roofTankCapacityL));
  tankCardClass(ctx.$('[data-roof-tank]'), pct, err);

  var tc=Lv(ctx,'roof','tank_count'); tc = tc!=null?Math.round(tc):ctx.cfg.roofTankCount;
  drawRoofTank(ctx, ctx.$('[data-roof-svg]'), pct, tc);

  var press=Lv(ctx,'roof','pressure_bar');
  var hasPress = L(ctx,'roof','pressure_bar')!=null;
  toggle(ctx,'[data-roof-pressure-card]', hasPress);
  setText(rootEl,'pressMain', press==null?'--':press.toFixed(2));
  var pfill=ctx.$('[data-bind-style="pressFill"]');
  if (pfill){
    pfill.className='wtr-kpi-bar-fill';
    pfill.style.width=(press==null?0:Math.min(100,(press/ctx.cfg.pressureMaxBar*100))).toFixed(1)+'%';
    if (press!=null && press<ctx.cfg.pressureLowBar) pfill.classList.add('warn');
    else if (press!=null && press>ctx.cfg.pressureHighBar) pfill.classList.add('danger');
  }
  var ptag=ctx.$('[data-bind="pressTag"]');
  if (ptag){
    if (press==null){ ptag.className='wtr-tag neutral'; ptag.textContent='--'; }
    else if (press<ctx.cfg.pressureLowBar){ ptag.className='wtr-tag warning'; ptag.textContent='LOW'; }
    else if (press>ctx.cfg.pressureHighBar){ ptag.className='wtr-tag danger'; ptag.textContent='HIGH'; }
    else { ptag.className='wtr-tag success'; ptag.textContent='NORMAL'; }
  }
  roofPump(ctx,1,'pump1_status','pump1_runtime_s','pump1_cycles','p1State','p1Runtime','p1Cycles');
  roofPump(ctx,2,'pump2_status','pump2_runtime_s','pump2_cycles','p2State','p2Runtime','p2Cycles');
}
function roofPump(ctx, idx, kStat, kRt, kCyc, bState, bRt, bCyc){
  var on=truthy(Lr(ctx,'roof',kStat));
  var card=ctx.$('[data-roof-pump="'+idx+'"]'); if(card) card.classList.toggle('on', on);
  setText(ctx.state.rootEl, bState, on?'ON':'OFF');
  var rt=Lv(ctx,'roof',kRt); setText(ctx.state.rootEl, bRt, rt==null?'--':formatRuntime(rt));
  var cy=Lv(ctx,'roof',kCyc); setText(ctx.state.rootEl, bCyc, cy==null?'0':Math.round(cy).toLocaleString());
}

/* ============================ RENDER: IRRIGATION ============================ */
function renderIrrigation(ctx){
  var wrap=ctx.$('[data-irrig-zones]'); if(!wrap) return;
  var rootEl=ctx.state.rootEl, cfg=ctx.cfg, ui=ctx.state.ui;
  var fromTs=ctx.state.range.from.getTime(), toTs=ctx.state.range.to.getTime();
  var infos=cfg.irrigZones.map(function(z){ return zoneInfo(ctx,z); });
  var html='', totalWaterL=0, anyWater=false;
  // resolve pending commands (konfirmasi dari telemetry device / timeout)
  infos.forEach(function(i){
    var p=ui.pending[i.z.id]; if(!p) return;
    var ex=p.expect, t=L(ctx,i.z.role,i.z.valve), fresh=t && t.ts>=p.ts-1000, okc=true;
    if (ex.valve!=null) okc = okc && i.on===ex.valve;
    if (ex.auto!=null)  okc = okc && i.autoMode===ex.auto;
    if (ex.start!=null) okc = okc && Math.abs(i.dry-ex.start)<0.5 && Math.abs(i.target-ex.stop)<0.5;
    if (okc && fresh){ delete ui.pending[i.z.id]; toast(ctx,'✅ '+p.label+' — terkonfirmasi device','success'); }
    else if (Date.now()-p.ts>25000){ delete ui.pending[i.z.id]; toast(ctx,'⚠ '+p.label+': device belum merespons (offline / belum subscribe attribute)','error'); }
  });

  infos.forEach(function(i){
    var z=i.z;
    if (!i.present){
      html+='<div class="wtr-zone off-line"><div class="zn-name">'+esc(z.label)+'</div><div class="zn-decision">Belum ada data. Pastikan key <b>'+esc(z.soil.join(', '))+', '+esc(z.valve)+'</b> di-assign ke device '+(z.role==='irrR'?'Garden Roof':'Garden Lt.1')+'.</div></div>';
      return;
    }
    var runMs=onDurationMs(S(ctx,z.role,z.valve), fromTs, toTs);
    var waterL=(runMs/60000)*zoneFlow(ctx,z);
    totalWaterL+=waterL; anyWater=true;
    var tagCls = i.status==='ok'?'success': i.status==='dry'?'warning': i.status==='wet'?'warning': i.status==='err'?'danger':'neutral';
    var tagTxt = i.status==='ok'?'OPTIMAL': i.status==='dry'?'DRY': i.status==='wet'?'WET': i.status==='err'?'SENSOR ERR':'--';
    var devName = ctx.state.dev[z.role].name || (z.role==='irrR'?'Garden Roof':'Garden Lt.1');
    var canCtl = cfg.irrigControl && i.online && ctx.state.dev[z.role].entityId;
    var ed = ui.edit[z.id] || {};
    var startV = ed.start!=null?ed.start:i.dry, stopV = ed.stop!=null?ed.stop:i.target;

    var pend = !!ui.pending[z.id];
    var sl = slopePerHour(zoneAvgSeries(ctx,z), 3*3600000), trendTxt='';
    if (sl!=null && !i.on){
      if (sl<-0.3 && i.avg!=null && i.avg>i.dry) trendTxt='📉 '+sl.toFixed(1)+'%/jam · ±'+fmtHours((i.avg-i.dry)/(-sl))+' lagi mencapai batas dry';
      else if (sl>0.3) trendTxt='📈 +'+sl.toFixed(1)+'%/jam';
      else if (i.avg!=null) trendTxt='➡ stabil';
    }
    html+='<div class="wtr-zone'+(i.on?' on':'')+(i.online?'':' off-line')+(pend?' pending':'')+'" data-zone="'+z.id+'">'+
      '<div class="zn-head"><div><div class="zn-name">'+esc(z.label)+'</div><div class="zn-dev">'+esc(devName)+' · '+(i.online?'online':'offline')+(i.cycles!=null?' · '+Math.round(i.cycles)+' siklus':'')+'</div></div>'+
        (pend?'<span class="zn-pending">⏳ menunggu device…</span>':'')+'<div class="zn-valve"><span class="led"></span>VALVE '+(i.valveHas?(i.on?'OPEN':'CLOSED'):'--')+'</div></div>'+
      '<div class="zn-body">'+
        '<div class="zn-gauge">'+gaugeSvg(i, z)+'<div class="ring-pulse"></div><div class="ctr"><div class="p">'+(i.avg==null?'--':i.avg.toFixed(0))+'<small>%</small></div><div class="t">SOIL</div></div></div>'+
        '<div class="zn-side">'+
          '<div style="display:flex;align-items:center;gap:8px"><span class="wtr-tag '+tagCls+'" style="margin-top:0">'+tagTxt+'</span><span class="zn-drops"><span>💧</span><span>💧</span><span>💧</span></span></div>'+
          '<div class="zn-sensors" style="grid-template-columns:repeat('+z.soil.length+',1fr)">'+z.soil.map(function(_,k){ return sensorBox(z.soil.length>1?'Soil '+(k+1):'Soil sensor', i.raw[k], i.soils[k]); }).join('')+'</div>'+
          sparkSvg(zoneAvgSeries(ctx,z), z.color, i.dry, i.wet)+
        '</div>'+
      '</div>'+
      '<div class="zn-decision">'+esc(i.msg)+'</div>'+
      (trendTxt?'<div class="zn-trend">'+esc(trendTxt)+'</div>':'')+
      (cfg.irrigControl ?
      '<div class="zn-ctl'+(canCtl?'':' disabled')+'">'+
        '<div class="zn-row"><div class="zn-seg"><button data-act="auto" class="'+(i.autoMode===true?'act':'')+'">AUTO</button><button data-act="manual" class="'+(i.autoMode===false?'act':'')+'">MANUAL</button></div>'+
          (i.on && i.remainS>0 ? '<span class="zn-timer">⏱ '+formatRuntime(i.remainS)+'</span>':'')+
          '<button class="zn-btn ghost" data-act="settings" style="margin-left:auto">⚙ Set</button></div>'+
        '<div class="zn-row">'+cfg.manualMinutes.map(function(m){ return '<button class="zn-btn" data-act="open" data-min="'+m+'">▶ '+m+'m</button>'; }).join('')+
          '<button class="zn-btn stop" data-act="close">■ Stop</button></div>'+
        '<div class="zn-set'+(ui.open[z.id]?' open':'')+'">'+
          '<div><label>Mulai &lt; %</label><input type="number" min="0" max="100" data-in="start" value="'+startV+'"></div>'+
          '<div><label>Stop ≥ %</label><input type="number" min="0" max="100" data-in="stop" value="'+stopV+'"></div>'+
          '<button class="zn-btn" data-act="save">Simpan</button></div>'+
      '</div>' : '')+
      '<div class="zn-foot"><div>Siram (range): <b>'+formatRuntime(runMs/1000)+'</b></div><div>≈ <b>'+formatVol(waterL)+'</b></div></div>'+
    '</div>';
  });
  // jangan rebuild saat user sedang mengetik di input
  var ae=document.activeElement;
  if (!(ae && ae.tagName==='INPUT' && wrap.contains(ae))) wrap.innerHTML=html;

  var act=infos.filter(function(i){return i.present&&i.on;});
  var pres=infos.filter(function(i){return i.present;});
  setText(rootEl,'irrNow', pres.length?(act.length+'/'+pres.length):'--');
  setText(rootEl,'irrNowFoot', act.length? act.map(function(i){return i.z.label.replace('Garden ','');}).join(', ') : 'semua valve tertutup');
  var avgs=pres.filter(function(i){return i.avg!=null;}).map(function(i){return i.avg;});
  setText(rootEl,'irrAvg', avgs.length?(avgs.reduce(function(a,b){return a+b;},0)/avgs.length).toFixed(0):'--');
  var dryN=pres.filter(function(i){return i.status==='dry';}).length, wetN=pres.filter(function(i){return i.status==='wet';}).length;
  setText(rootEl,'irrAvgFoot', dryN+' dry · '+wetN+' wet · '+(pres.length-dryN-wetN)+' ok/other');
  setText(rootEl,'irrWater', anyWater?formatVol(totalWaterL):'--');
  setText(rootEl,'irrWaterFoot', 'estimasi (runtime × '+ctx.cfg.zoneFlowLpm+' L/min)');

  var rainLvl=lvlOf(ctx,'gwt','rw_level','rw_dist_cm'), rainErr=tankErr(ctx,'gwt','rw_level','rw_dist_cm');
  var srcEl=ctx.$('[data-bind="irrSource"]');
  var src, note, color='var(--text-1)';
  if (ctx.cfg.irrigSource!=='rain'){ src='GWT'; note='sumber dikonfigurasi GWT'; }
  else if (!hasRain(ctx)){ src='GWT'; note='data tangki hujan tidak ada'; }
  else if (rainErr){ src='GWT'; note='sensor tangki hujan error'; color='var(--warning)'; }
  else if (rainLvl!=null && rainLvl>=ctx.cfg.rwLowPct){ src='🌧 RAIN'; note='tangki hujan '+rainLvl.toFixed(0)+'%'; color='var(--rain)'; }
  else { src='GWT (fallback)'; note='tangki hujan rendah'+(rainLvl!=null?' ('+rainLvl.toFixed(0)+'%)':''); color='var(--warning)'; }
  setText(rootEl,'irrSource', src); setText(rootEl,'irrSourceFoot', note);
  if (srcEl) srcEl.style.color=color;

  function sensorBox(lbl, raw, val){
    var bad = raw!=null && val==null;
    return '<div class="zn-s"><div class="l">'+lbl+'</div><div class="v'+(bad||raw==null?' bad':'')+'">'+(raw==null?'--':(bad?'ERR':val.toFixed(0)+'%'))+'</div></div>';
  }
}

/* gauge radial 270deg: track + progress + tanda dry/wet */
function gaugeSvg(i, z){
  var R=48, C=2*Math.PI*R, arc=C*0.75;            // 270 derajat
  var pct = i.avg==null?0:Math.max(0,Math.min(100,i.avg));
  var col = i.status==='dry'?'#f59e0b': i.status==='wet'?'#60a5fa': i.status==='err'?'#ef4444':'#10b981';
  function tick(p,c){
    var a=(135+p/100*270)*Math.PI/180, x1=60+Math.cos(a)*40, y1=60+Math.sin(a)*40, x2=60+Math.cos(a)*56, y2=60+Math.sin(a)*56;
    return '<line x1="'+x1.toFixed(1)+'" y1="'+y1.toFixed(1)+'" x2="'+x2.toFixed(1)+'" y2="'+y2.toFixed(1)+'" stroke="'+c+'" stroke-width="2.5" stroke-linecap="round"/>';
  }
  return '<svg viewBox="0 0 120 120"><defs><linearGradient id="gg_'+z.id+'" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="'+col+'" stop-opacity=".6"/><stop offset="1" stop-color="'+col+'"/></linearGradient></defs>'+
    '<circle cx="60" cy="60" r="'+R+'" fill="none" stroke="rgba(148,163,184,.14)" stroke-width="9" stroke-linecap="round" stroke-dasharray="'+arc+' '+C+'" transform="rotate(135 60 60)"/>'+
    '<circle cx="60" cy="60" r="'+R+'" fill="none" stroke="url(#gg_'+z.id+')" stroke-width="9" stroke-linecap="round" stroke-dasharray="'+(arc*pct/100)+' '+C+'" transform="rotate(135 60 60)" style="transition:stroke-dasharray .6s"/>'+
    tick(i.dry,'rgba(245,158,11,.9)')+tick(i.wet,'rgba(96,165,250,.9)')+'</svg>';
}
function sparkSvg(series, color, dry, wet){
  if (!series || series.length<2) return '<svg class="zn-spark" viewBox="0 0 100 34" preserveAspectRatio="none"><text x="50" y="20" text-anchor="middle" fill="#475569" font-size="8">no history</text></svg>';
  var t0=series[0][0], t1=series[series.length-1][0], span=Math.max(1,t1-t0);
  var pts=series.map(function(p){ return ((p[0]-t0)/span*100).toFixed(1)+','+(32-Math.max(0,Math.min(100,p[1]))/100*30).toFixed(1); });
  function ly(v){ return (32-v/100*30).toFixed(1); }
  return '<svg class="zn-spark" viewBox="0 0 100 34" preserveAspectRatio="none">'+
    '<line x1="0" x2="100" y1="'+ly(dry)+'" y2="'+ly(dry)+'" stroke="rgba(245,158,11,.35)" stroke-dasharray="2,2" stroke-width=".6" vector-effect="non-scaling-stroke"/>'+
    '<polygon points="0,32 '+pts.join(' ')+' 100,32" fill="'+color+'" opacity=".15"/>'+
    '<polyline points="'+pts.join(' ')+'" fill="none" stroke="'+color+'" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>';
}

/* ---- kontrol irigasi: kirim SHARED attribute ke device (firmware nismara_irrigation) ---- */
function onZoneClick(ctx, ev){
  var btn=ev.target.closest ? ev.target.closest('[data-act]') : null; if(!btn) return;
  var zEl=btn.closest('[data-zone]'); if(!zEl) return;
  var zid=zEl.getAttribute('data-zone');
  var z=ctx.cfg.irrigZones.filter(function(x){return x.id===zid;})[0]; if(!z) return;
  var pre=zPrefix(z), act=btn.getAttribute('data-act'), stamp=Date.now();
  if (act==='settings'){ ctx.state.ui.open[zid]=!ctx.state.ui.open[zid]; var p=zEl.querySelector('.zn-set'); if(p) p.classList.toggle('open', !!ctx.state.ui.open[zid]); return; }
  if (act==='auto' || act==='manual'){ var a={}; a[pre+'_auto']=(act==='auto'); sendAttrs(ctx, z, a, act==='auto'?'Mode AUTO':'Mode MANUAL', {auto:(act==='auto')}); return; }
  if (act==='open'){ var m=parseInt(btn.getAttribute('data-min'),10)||5, c={}; c[pre+'_cmd']='open|'+m+'|'+stamp; sendAttrs(ctx, z, c, 'Buka '+z.label+' '+m+' menit', {valve:true}); return; }
  if (act==='close'){ var d={}; d[pre+'_cmd']='close|0|'+stamp; sendAttrs(ctx, z, d, 'Tutup '+z.label, {valve:false}); return; }
  if (act==='save'){
    var s=parseFloat(zEl.querySelector('[data-in="start"]').value), e=parseFloat(zEl.querySelector('[data-in="stop"]').value);
    if (isNaN(s)||isNaN(e)||s<0||e>100||e<=s){ toast(ctx,'Nilai tidak valid: stop harus > mulai (0–100)','error'); return; }
    var t={}; t[pre+'_start_pct']=s; t[pre+'_stop_pct']=e; delete ctx.state.ui.edit[zid];
    sendAttrs(ctx, z, t, 'Threshold '+z.label+' disimpan', {start:s, stop:e}); return;
  }
}
function sendAttrs(ctx, z, obj, okMsg, expect){
  var dev=ctx.state.dev[z.role];
  var svc=ctx.attributeService;
  if (!svc || !dev || !dev.entityId){ toast(ctx,'Tidak bisa kirim: attributeService / entity tidak tersedia','error'); return; }
  var list=Object.keys(obj).map(function(k){ return { key:k, value:obj[k] }; });
  var ent={ entityType: dev.entityType||'DEVICE', id: dev.entityId };
  try {
    svc.saveEntityAttributes(ent, 'SHARED_SCOPE', list).subscribe(
      function(){ toast(ctx,'📨 '+okMsg+' — menunggu konfirmasi device…','success'); if(expect){ ctx.state.ui.pending[z.id]={ ts:Date.now(), expect:expect, label:okMsg }; if(ctx._render) ctx._render(); } },
      function(){ toast(ctx,'❌ Gagal kirim (cek hak akses tulis atribut)','error'); });
  } catch(e){ toast(ctx,'❌ '+e.message,'error'); }
}

/* ============================ TANK SVG ============================ */
/* silinder 3D: badan kaca + air bergradasi + permukaan elips + riak + gelembung */
function cyl(x, yTop, w, h, pct, color, id, ticks){
  pct=Math.max(0,Math.min(100,pct||0));
  var rx=w/2, cx=x+rx, ry=Math.max(4,Math.min(10,w*0.12)), yBot=yTop+h;
  var lvlY=yBot-(pct/100)*(h-ry);
  var body='M'+x+','+yTop+' L'+x+','+yBot+' A'+rx+','+ry+' 0 0 0 '+(x+w)+','+yBot+' L'+(x+w)+','+yTop+' Z';
  var s='<defs><linearGradient id="wg_'+id+'" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="'+color+'" stop-opacity=".92"/><stop offset="1" stop-color="'+color+'" stop-opacity=".5"/></linearGradient>'+
    '<linearGradient id="sh_'+id+'" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity=".20"/><stop offset=".3" stop-color="#fff" stop-opacity=".03"/><stop offset=".72" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".26"/></linearGradient>'+
    '<clipPath id="cp_'+id+'"><path d="'+body+'"/></clipPath></defs>';
  if (ticks){ for (var k=0;k<=4;k++){ var yy=yBot-(k/4)*(h-ry); s+='<line x1="'+(x-5)+'" y1="'+yy.toFixed(1)+'" x2="'+(x-1)+'" y2="'+yy.toFixed(1)+'" stroke="rgba(148,163,184,.55)"/><text x="'+(x-7)+'" y="'+(yy+3).toFixed(1)+'" text-anchor="end" fill="#64748b" font-size="8">'+(k*25)+'</text>'; } }
  s+='<path d="'+body+'" fill="rgba(148,163,184,.07)"/>';
  if (pct>0.4){
    s+='<g clip-path="url(#cp_'+id+')">'+
      '<rect x="'+x+'" y="'+lvlY.toFixed(1)+'" width="'+w+'" height="'+(yBot+ry-lvlY+1).toFixed(1)+'" fill="url(#wg_'+id+')"/>'+
      '<ellipse cx="'+cx+'" cy="'+lvlY.toFixed(1)+'" rx="'+rx+'" ry="'+ry+'" fill="'+color+'"/>'+
      '<ellipse cx="'+cx+'" cy="'+lvlY.toFixed(1)+'" rx="'+rx+'" ry="'+ry+'" fill="#fff" opacity=".22"/>'+
      '<ellipse class="wtr-rip" cx="'+cx+'" cy="'+lvlY.toFixed(1)+'" rx="'+(rx*0.9)+'" ry="'+(ry*0.85)+'" fill="none" stroke="#fff" stroke-width="1.2"/>'+
      '<ellipse class="wtr-rip" style="animation-delay:1.6s" cx="'+cx+'" cy="'+lvlY.toFixed(1)+'" rx="'+(rx*0.9)+'" ry="'+(ry*0.85)+'" fill="none" stroke="#fff" stroke-width="1"/>';
    if (w>36 && pct>6){ [0.3,0.55,0.74].forEach(function(f,i){ s+='<circle class="wtr-bub" style="animation-delay:'+(i*1.4)+'s" cx="'+(x+w*f).toFixed(1)+'" cy="'+(yBot-4).toFixed(1)+'" r="'+(1.6+i*0.5)+'" fill="#fff"/>'; }); }
    s+='</g>';
  }
  s+='<g clip-path="url(#cp_'+id+')"><rect x="'+x+'" y="'+yTop+'" width="'+w+'" height="'+(h+ry)+'" fill="url(#sh_'+id+')"/></g>';
  s+='<path d="'+body.replace(' Z','')+'" fill="none" stroke="rgba(148,163,184,.55)" stroke-width="1.4"/>';
  s+='<ellipse cx="'+cx+'" cy="'+yTop+'" rx="'+rx+'" ry="'+ry+'" fill="rgba(255,255,255,.06)" stroke="rgba(148,163,184,.6)" stroke-width="1.4"/>';
  return s;
}
function drawTank(ctx, svg, pct, W, H, color){
  if(!svg) return;
  svg.innerHTML = cyl(26, 24, 70, 158, pct, color, uid(svg), true);
}
function drawRoofTank(ctx, svg, pct, N){
  if(!svg) return;
  N=Math.max(1,Math.min(N||1,8));
  var W=280, mX=26, topM=22, h=134, availW=W-mX-12, gap=N>1?10:0;
  var tankW = Math.min(N===1?150:90, (availW-gap*(N-1))/N);
  var total=tankW*N+gap*(N-1), x0=mX+(availW-total)/2, id=uid(svg), s='';
  for (var i=0;i<N;i++) s+=cyl(x0+i*(tankW+gap), topM, tankW, h, pct, '#22d3ee', id+i, i===0);
  if (N>1){
    var py=topM+h+24; s+='<line x1="'+(x0+tankW/2)+'" y1="'+py+'" x2="'+(x0+total-tankW/2)+'" y2="'+py+'" stroke="rgba(34,211,238,.6)" stroke-width="3" stroke-linecap="round"/>';
    for (var k=0;k<N;k++){ var jx=x0+k*(tankW+gap)+tankW/2; s+='<line x1="'+jx+'" y1="'+(topM+h+10)+'" x2="'+jx+'" y2="'+py+'" stroke="rgba(34,211,238,.6)" stroke-width="3"/><text x="'+jx+'" y="'+(py+13)+'" text-anchor="middle" fill="#94a3b8" font-size="8" font-weight="700">T'+(k+1)+'</text>'; }
  }
  svg.innerHTML=s;
}
function uid(el){ if(!el.__uid) el.__uid=Math.random().toString(36).slice(2,7); return el.__uid; }

/* ============================ RENDER: LIVE ============================ */
function renderLive(ctx){
  var rootEl=ctx.state.rootEl;
  setText(rootEl,'liveGwt', pctTxt(ctx,'gwt','t1_level','t1_dist_cm',0).replace('%','')+' / '+pctTxt(ctx,'gwt','t2_level','t2_dist_cm',0)+(tankErr(ctx,'gwt','t2_level','t2_dist_cm')?'':'%'));
  var flow=Lv(ctx,'flow','flow_lpm'); setText(rootEl,'liveFlow', flow==null?'--':flow.toFixed(1));
  setText(rootEl,'liveRoof', pctTxt(ctx,'roof','level_pct','distance_cm',1));
  var pr=Lv(ctx,'roof','pressure_bar'); setText(rootEl,'livePress', pr==null?'--':pr.toFixed(2));

  var rl=pctTxt(ctx,'gwt','rw_level','rw_dist_cm',0), rf=Lv(ctx,'gwt','rw_flow_lpm');
  setText(rootEl,'liveRain', hasRain(ctx) ? (rl+(rl==='ERR'||rl==='--'?'':'%')+' / '+(rf==null?'--':rf.toFixed(1)+' L/m')) : '--');

  var soil=ctx.cfg.irrigZones.map(function(z){ var i=zoneInfo(ctx,z); return i.avg==null?'--':i.avg.toFixed(0); });
  setText(rootEl,'liveSoil', soil.join(' / ')+'%');

  function r(role){ var v=Lv(ctx,role,'rssi'); return v==null?'-':Math.round(v); }
  setText(rootEl,'liveRssi', r('gwt')+'/'+r('flow')+'/'+r('roof')+'/'+r('irrG')+'/'+r('irrR'));
  var ups=ROLES.map(function(x){return Lv(ctx,x,'uptime_s');}).filter(function(x){return x!=null;});
  setText(rootEl,'liveUptime', ups.length?formatUptime(Math.min.apply(null,ups)):'--');
  function h(role){ var v=Lv(ctx,role,'heap'); return v==null?'-':Math.round(v/1024)+'k'; }
  setText(rootEl,'liveHeap', h('gwt')+'/'+h('irrG')+'/'+h('irrR'));
}

/* ============================ RANGE STATS ============================ */
function renderRangeStats(ctx){
  var rootEl=ctx.state.rootEl;
  var g1=vSeries(ctx,'gwt','t1_level','t1_dist_cm'), g2=vSeries(ctx,'gwt','t2_level','t2_dist_cm');
  var rr=vSeries(ctx,'roof','level_pct','distance_cm'), rw=vSeries(ctx,'gwt','rw_level','rw_dist_cm');
  var n=Math.max(S(ctx,'gwt','t1_level').length, S(ctx,'roof','level_pct').length, S(ctx,'flow','flow_lpm').length, S(ctx,'gwt','rw_level').length);
  setText(rootEl,'rangeSamples', n||'--');
  setText(rootEl,'rangeGwt', stat3([].concat(numVals(g1),numVals(g2)),'%',1));
  setText(rootEl,'rangeRoof', stat3(numVals(rr),'%',1));
  setText(rootEl,'rangeRain', stat3(numVals(rw),'%',1));
  setText(rootEl,'rangeFlow', stat3(numVals(S(ctx,'flow','flow_lpm')),'L/min',1));

  var fromTs=ctx.state.range.from.getTime(), toTs=ctx.state.range.to.getTime();
  setText(rootEl,'rangeTransferred', deltaOf(S(ctx,'flow','total_liters'),fromTs,toTs));
  setText(rootEl,'rangeRainCollected', deltaOf(S(ctx,'gwt','rw_total_liters'),fromTs,toTs));
}
function deltaOf(series, fromTs, toTs){
  var ser=series.filter(function(p){return p[0]>=fromTs&&p[0]<=toTs;});
  if (ser.length<2) return '--';
  var vals=numVals(ser); if (vals.length<2) return '--';
  return formatVol(Math.max.apply(null,vals)-Math.min.apply(null,vals));
}
function numVals(series){ return series.map(function(p){return parseFloat(p[1]);}).filter(function(x){return !isNaN(x);}); }
function stat3(vals, unit, dp){
  if(!vals.length) return '--';
  var mn=Math.min.apply(null,vals), mx=Math.max.apply(null,vals);
  var av=vals.reduce(function(a,b){return a+b;},0)/vals.length;
  return mn.toFixed(dp)+' / '+av.toFixed(dp)+' / '+mx.toFixed(dp)+' '+unit;
}

/* ============================ CHART: LEVELS & FLOW ============================ */
function renderChart(ctx){
  var svg=ctx.$('[data-chart]'); var emptyEl=ctx.$('[data-chart-empty]'); if(!svg) return;

  var sT1=vSeries(ctx,'gwt','t1_level','t1_dist_cm'), sT2=vSeries(ctx,'gwt','t2_level','t2_dist_cm');
  var sRoof=vSeries(ctx,'roof','level_pct','distance_cm'), sRain=vSeries(ctx,'gwt','rw_level','rw_dist_cm');
  var sFlow=S(ctx,'flow','flow_lpm'), sRF=S(ctx,'gwt','rw_flow_lpm');
  var sPump=S(ctx,'flow','pump_running');

  var allTs=[];
  [sT1,sT2,sRoof,sRain,sFlow,sRF].forEach(function(ser){ ser.forEach(function(p){allTs.push(p[0]);}); });
  if (allTs.length<2){ svg.style.display='none'; ctx.state.models.main=null; if(emptyEl){emptyEl.style.display='flex';} return; }
  svg.style.display=''; if(emptyEl) emptyEl.style.display='none';

  var fromTs=Math.min.apply(null,allTs), toTs=Math.max.apply(null,allTs), spanMs=Math.max(1,toTs-fromTs);
  var W=1000,H=280,padL=52,padR=58,padT=22,padB=30, cW=W-padL-padR, cH=H-padT-padB;
  function xOf(ts){ return padL+((ts-fromTs)/spanMs)*cW; }
  function yLvl(v){ return padT+cH-(v/100)*cH; }
  var flowMax=Math.max(ctx.cfg.flowMaxLpm, 1);
  var fv=numVals(sFlow).concat(numVals(sRF));
  if (fv.length){ var fm=Math.max.apply(null,fv); if(fm>flowMax) flowMax=Math.ceil(fm/5)*5; }
  function yFlow(v){ return padT+cH-(v/flowMax)*cH; }

  var c='';
  c+=drawBands(sPump, xOf, padT, cH, toTs, '#a78bfa', '0.10');
  for (var g=0;g<=4;g++){ var yy=padT+(g/4)*cH; var lv=100-(g/4)*100; var fvv=flowMax-(g/4)*flowMax;
    c+='<line x1="'+padL+'" y1="'+yy+'" x2="'+(W-padR)+'" y2="'+yy+'" stroke="rgba(148,163,184,.08)" stroke-width="1"/>';
    c+='<text x="'+(padL-9)+'" y="'+(yy+3)+'" text-anchor="end" fill="#06b6d4" font-size="10" font-weight="600">'+lv.toFixed(0)+'</text>';
    c+='<text x="'+(W-padR+9)+'" y="'+(yy+3)+'" text-anchor="start" fill="#a78bfa" font-size="10" font-weight="600">'+fvv.toFixed(0)+'</text>'; }
  [['alarmLevelLow','LOW'],['alarmLevelHigh','HIGH']].forEach(function(a){
    var v=ctx.cfg[a[0]]; if(v>=0&&v<=100){ c+='<line x1="'+padL+'" y1="'+yLvl(v)+'" x2="'+(W-padR)+'" y2="'+yLvl(v)+'" stroke="rgba(239,68,68,.25)" stroke-width="1" stroke-dasharray="4,3"/>'+
      '<text x="'+(W-padR-4)+'" y="'+(yLvl(v)-3)+'" text-anchor="end" fill="#ef4444" font-size="8.5" font-weight="600">'+a[1]+' '+v+'%</text>'; }
  });

  c+=line(sT1, xOf, yLvl, '#38bdf8', 1.8);
  c+=line(sT2, xOf, yLvl, '#0ea5e9', 1.8);
  c+=line(sRoof, xOf, yLvl, '#06b6d4', 2.2);
  c+=line(sRain, xOf, yLvl, '#2dd4bf', 2);
  c+=line(sFlow, xOf, yFlow, '#a78bfa', 2);
  c+=line(sRF, xOf, yFlow, '#f472b6', 1.8, '5,3');

  c+=lastMarker(sRoof, xOf, yLvl, '#06b6d4', function(v){return v.toFixed(0)+'%';}, -1);
  c+=lastMarker(sRain, xOf, yLvl, '#2dd4bf', function(v){return v.toFixed(0)+'%';}, 1);
  c+=lastMarker(sFlow, xOf, yFlow, '#a78bfa', function(v){return v.toFixed(1);}, 1);

  c+=xLabels(fromTs, spanMs, padL, cW, H);
  c+='<text x="'+(padL-9)+'" y="'+(padT-8)+'" text-anchor="end" fill="#06b6d4" font-size="10" font-weight="700">LEVEL %</text>';
  c+='<text x="'+(W-padR+9)+'" y="'+(padT-8)+'" text-anchor="start" fill="#a78bfa" font-size="10" font-weight="700">FLOW L/min</text>';
  c+='<text x="'+(W/2)+'" y="'+(padT-8)+'" text-anchor="middle" fill="#94a3b8" font-size="10">Span: <tspan fill="#22d3ee" font-weight="700">'+spanLabel(spanMs)+'</tspan></text>';
  svg.innerHTML=c;
  ctx.state.models.main = { W:W, padL:padL, cW:cW, fromTs:fromTs, spanMs:spanMs, series:[
    {label:'GWT T1',color:'#38bdf8',data:sT1,fmt:function(v){return v.toFixed(1)+'%';}},
    {label:'GWT T2',color:'#0ea5e9',data:sT2,fmt:function(v){return v.toFixed(1)+'%';}},
    {label:'Roof',color:'#06b6d4',data:sRoof,fmt:function(v){return v.toFixed(1)+'%';}},
    {label:'Rain tank',color:'#2dd4bf',data:sRain,fmt:function(v){return v.toFixed(1)+'%';}},
    {label:'Transfer',color:'#a78bfa',data:sFlow,fmt:function(v){return v.toFixed(1)+' L/min';}},
    {label:'Rain flow',color:'#f472b6',data:sRF,fmt:function(v){return v.toFixed(1)+' L/min';}} ] };

  function lastMarker(series, fx, fy, color, fmt, side){
    if (!series.length) return '';
    var last=series[series.length-1], v=parseFloat(last[1]); if(isNaN(v)) return '';
    var x=fx(last[0]).toFixed(1), y=fy(v).toFixed(1), oy = side<0 ? -22 : 8;
    return '<circle cx="'+x+'" cy="'+y+'" r="4.5" fill="'+color+'" stroke="#0a1a2e" stroke-width="2"/>'+
      '<rect x="'+(parseFloat(x)-20)+'" y="'+(parseFloat(y)+oy)+'" width="40" height="15" rx="3" fill="'+color+'"/>'+
      '<text x="'+x+'" y="'+(parseFloat(y)+oy+11)+'" text-anchor="middle" fill="#06121a" font-size="9.5" font-weight="700">'+fmt(v)+'</text>';
  }
}
function line(series, fx, fy, color, w, dash){
  if (series.length<2) return '';
  var path='', started=false;
  series.forEach(function(p){
    var v=parseFloat(p[1]); if(isNaN(v)) return;
    path+=(started?'L':'M')+fx(p[0]).toFixed(1)+','+fy(v).toFixed(1)+' '; started=true;
  });
  return '<path d="'+path+'" fill="none" stroke="'+color+'" stroke-width="'+w+'"'+(dash?' stroke-dasharray="'+dash+'"':'')+' stroke-linejoin="round" stroke-linecap="round"/>';
}
function xLabels(fromTs, spanMs, padL, cW, H){
  var c='';
  for (var t=0;t<=6;t++){ var tx=padL+(t/6)*cW, ts=fromTs+(t/6)*spanMs, d=new Date(ts), dayMs=86400000, lab;
    if (spanMs>7*dayMs) lab=pad2(d.getDate())+'/'+pad2(d.getMonth()+1);
    else if (spanMs>2*dayMs) lab=pad2(d.getDate())+'/'+pad2(d.getMonth()+1)+' '+pad2(d.getHours())+'h';
    else lab=pad2(d.getHours())+':'+pad2(d.getMinutes());
    c+='<text x="'+tx.toFixed(1)+'" y="'+(H-10)+'" text-anchor="middle" fill="#64748b" font-size="9.5">'+lab+'</text>'; }
  return c;
}
function spanLabel(spanMs){ var h=spanMs/3600000; return h<1 ? Math.round(spanMs/60000)+' menit' : h<24 ? h.toFixed(1)+' jam' : (h/24).toFixed(1)+' hari'; }
function drawBands(series, xOf, y, h, toTs, color, opacity){
  var bands='', inB=false, start=0;
  series.forEach(function(p){
    var on=truthy(p[1]);
    if (on && !inB){ inB=true; start=p[0]; }
    if (!on && inB){ inB=false; var x1=xOf(start), x2=xOf(p[0]); if(x2>x1) bands+='<rect x="'+x1.toFixed(1)+'" y="'+y+'" width="'+(x2-x1).toFixed(1)+'" height="'+h+'" fill="'+color+'" opacity="'+opacity+'"/>'; }
  });
  if (inB){ var a=xOf(start), b=xOf(toTs); if(b>a) bands+='<rect x="'+a.toFixed(1)+'" y="'+y+'" width="'+(b-a).toFixed(1)+'" height="'+h+'" fill="'+color+'" opacity="'+opacity+'"/>'; }
  return bands;
}

/* ============================ CHART: IRRIGATION ============================ */
function renderIrrigChart(ctx){
  var svg=ctx.$('[data-chart-irr]'), emptyEl=ctx.$('[data-chart-irr-empty]'), legend=ctx.$('[data-irrig-legend]');
  if(!svg) return;
  var zs=ctx.cfg.irrigZones.filter(function(z){ return ctx.state.dev[z.role].present; });
  var avgSer=zs.map(function(z){ return zoneAvgSeries(ctx,z); });
  var allTs=[]; avgSer.forEach(function(se){ se.forEach(function(p){allTs.push(p[0]);}); });
  if (allTs.length<2){ svg.style.display='none'; ctx.state.models.irr=null; if(emptyEl) emptyEl.style.display='flex'; if(legend) legend.innerHTML=''; return; }
  svg.style.display=''; if(emptyEl) emptyEl.style.display='none';

  var fromTs=Math.min.apply(null,allTs), toTs=Math.max.apply(null,allTs), spanMs=Math.max(1,toTs-fromTs);
  var W=1000,H=300,padL=52,padR=20,padT=22,laneH=6,laneGap=4,lanes=zs.length;
  var padB=30+lanes*(laneH+laneGap)+4, cW=W-padL-padR, cH=H-padT-padB;
  function xOf(ts){ return padL+((ts-fromTs)/spanMs)*cW; }
  function yOf(v){ return padT+cH-(v/100)*cH; }

  var c='';
  // dry/wet band
  var dry=ctx.cfg.soilDryPct, wet=ctx.cfg.soilWetPct;
  c+='<rect x="'+padL+'" y="'+yOf(wet)+'" width="'+cW+'" height="'+(yOf(dry)-yOf(wet))+'" fill="rgba(16,185,129,.06)"/>';
  for (var g=0;g<=4;g++){ var yy=padT+(g/4)*cH;
    c+='<line x1="'+padL+'" y1="'+yy+'" x2="'+(W-padR)+'" y2="'+yy+'" stroke="rgba(148,163,184,.08)"/>';
    c+='<text x="'+(padL-9)+'" y="'+(yy+3)+'" text-anchor="end" fill="#34d399" font-size="10" font-weight="600">'+(100-g*25)+'</text>'; }
  [[dry,'DRY'],[wet,'WET']].forEach(function(a){
    c+='<line x1="'+padL+'" y1="'+yOf(a[0])+'" x2="'+(W-padR)+'" y2="'+yOf(a[0])+'" stroke="rgba(245,158,11,.35)" stroke-dasharray="4,3"/>'+
       '<text x="'+(W-padR-4)+'" y="'+(yOf(a[0])-3)+'" text-anchor="end" fill="#f59e0b" font-size="8.5" font-weight="600">'+a[1]+' '+a[0]+'%</text>'; });

  var leg='';
  zs.forEach(function(z,i){
    c+=line(avgSer[i], xOf, yOf, z.color, 2.2);
    // valve lane
    var ly=padT+cH+8+i*(laneH+laneGap);
    c+='<rect x="'+padL+'" y="'+ly+'" width="'+cW+'" height="'+laneH+'" fill="rgba(255,255,255,.04)" rx="2"/>';
    c+=drawBands(S(ctx,z.role,z.valve), xOf, ly, laneH, toTs, z.color, '0.85');
    c+='<text x="'+(padL-9)+'" y="'+(ly+laneH)+'" text-anchor="end" fill="'+z.color+'" font-size="8" font-weight="700">V'+(i+1)+'</text>';
    var se=avgSer[i];
    if (se.length){ var last=se[se.length-1];
      c+='<circle cx="'+xOf(last[0]).toFixed(1)+'" cy="'+yOf(last[1]).toFixed(1)+'" r="4" fill="'+z.color+'" stroke="#0a1a2e" stroke-width="2"/>'; }
    leg+='<div class="item"><span class="dot" style="background:'+z.color+'"></span>'+esc(z.label)+'</div>';
  });
  leg+='<div class="item"><span class="dot" style="background:rgba(148,163,184,.5)"></span>Bar bawah = valve OPEN</div>';
  if (legend) legend.innerHTML=leg;

  c+=xLabels(fromTs, spanMs, padL, cW, H);
  c+='<text x="'+(padL-9)+'" y="'+(padT-8)+'" text-anchor="end" fill="#34d399" font-size="10" font-weight="700">SOIL %</text>';
  c+='<text x="'+(W/2)+'" y="'+(padT-8)+'" text-anchor="middle" fill="#94a3b8" font-size="10">Span: <tspan fill="#22d3ee" font-weight="700">'+spanLabel(spanMs)+'</tspan></text>';
  svg.innerHTML=c;
  ctx.state.models.irr = { W:W, padL:padL, cW:cW, fromTs:fromTs, spanMs:spanMs, series: zs.map(function(z,i){
    return {label:z.label.replace('Garden ',''),color:z.color,data:avgSer[i],fmt:function(v){return v.toFixed(0)+'%';},valve:S(ctx,z.role,z.valve)}; }) };
}

/* ============================ EVENTS RENDER ============================ */
function renderEvents(ctx){
  var listEl=ctx.$('[data-event-list]'), countEl=ctx.$('[data-bind="eventCount"]');
  var ev=ctx.state.events||[];
  if (countEl){ countEl.textContent='['+ev.length+']'; }
  if (!listEl) return;
  if (!ev.length){ listEl.innerHTML='<div class="wtr-event-empty">Tidak ada event pada rentang waktu ini.</div>'; return; }
  var html='', lastDay='', today=new Date(); today.setHours(0,0,0,0);
  ev.slice(0,80).forEach(function(e){
    var d=new Date(e.ts), dd=new Date(e.ts); dd.setHours(0,0,0,0);
    var diff=Math.round((today-dd)/86400000);
    var day = diff===0?'Hari ini':diff===1?'Kemarin':pad2(d.getDate())+'/'+pad2(d.getMonth()+1)+'/'+d.getFullYear();
    if (day!==lastDay){ html+='<div class="tl-day">'+day+'</div>'; lastDay=day; }
    html+='<div class="tl-item"><span class="tl-dot '+e.cls+'"></span><div class="tl-tx">'+esc(e.type)+'</div>'+
      '<div class="tl-tm">'+pad2(d.getHours())+':'+pad2(d.getMinutes())+'</div>'+
      '<div class="tl-bd" style="color:'+badgeColor(e.cls)+'">'+esc(e.badge)+'</div></div>';
  });
  listEl.innerHTML=html;
}
function badgeColor(cls){ return cls==='bad'?'#ef4444':cls==='warn'?'#f59e0b':cls==='on'?'#10b981':cls==='rain'?'#2dd4bf':'#94a3b8'; }

/* ============================ EXPORT CSV ============================ */
function exportCSV(ctx){
  var fromTs=ctx.state.range.from.getTime(), toTs=ctx.state.range.to.getTime();
  var cols=[
    ['gwt','t1_level','GWT_T1_%'],['gwt','t1_vol_l','GWT_T1_L'],['gwt','t1_dist_cm','GWT_T1_dist_cm'],
    ['gwt','t2_level','GWT_T2_%'],['gwt','t2_vol_l','GWT_T2_L'],['gwt','t2_dist_cm','GWT_T2_dist_cm'],
    ['gwt','balance_diff','Balance_diff'],['gwt','balance_ok','Balance_ok'],
    ['gwt','rw_level','Rain_%'],['gwt','rw_vol_l','Rain_L'],['gwt','rw_dist_cm','Rain_dist_cm'],['gwt','rw_flow_lpm','Rain_flow_Lmin'],['gwt','rw_total_liters','Rain_total_L'],
    ['flow','flow_lpm','Flow_Lmin'],['flow','total_liters','Total_L'],['flow','pump_running','Pump_running'],
    ['roof','level_pct','Roof_%'],['roof','volume_l','Roof_L'],['roof','pressure_bar','Pressure_bar']
  ];
  ctx.cfg.irrigZones.forEach(function(z){
    z.soil.forEach(function(k,i){ cols.push([z.role,k,z.id.toUpperCase()+'_soil'+(i+1)+'_%']); });
    cols.push([z.role,z.valve,z.id.toUpperCase()+'_valve']);
  });
  var merged={};
  cols.forEach(function(c){
    S(ctx,c[0],c[1]).forEach(function(p){
      if (p[0]<fromTs||p[0]>toTs) return;
      if (!merged[p[0]]) merged[p[0]]={};
      merged[p[0]][c[0]+'.'+c[1]]=p[1];
    });
  });
  var rows=[['Timestamp'].concat(cols.map(function(c){return c[2];}))];
  Object.keys(merged).sort(function(a,b){return parseInt(a)-parseInt(b);}).forEach(function(ts){
    var r=merged[ts], d=new Date(parseInt(ts));
    rows.push([ d.toISOString() ].concat(cols.map(function(c){ var v=r[c[0]+'.'+c[1]]; return v==null?'':v; })));
  });
  var csv=rows.map(function(r){ return r.map(function(c){ c=(''+c).replace(/"/g,'""'); return /[,\n"]/.test(c)?'"'+c+'"':c; }).join(','); }).join('\n');
  var blob=new Blob([csv],{type:'text/csv;charset=utf-8;'}), url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download=(ctx.cfg.systemName||'water_system').replace(/[^a-zA-Z0-9]+/g,'_')+'_'+isoDt(ctx.state.range.from).substring(0,10)+'.csv';
  document.body.appendChild(a); a.click();
  setTimeout(function(){ document.body.removeChild(a); URL.revokeObjectURL(url); },200);
  toast(ctx,'✅ CSV downloaded','success');
}

/* ============================ UX: TRENDS / ALERTS / HOVER ============================ */
function slopePerHour(series, windowMs){
  if (!series || series.length<3) return null;
  var tEnd=series[series.length-1][0], pts=series.filter(function(p){ return p[0]>=tEnd-windowMs && !isNaN(parseFloat(p[1])); });
  if (pts.length<3) return null;
  var n=pts.length, sx=0, sy=0, sxx=0, sxy=0;
  pts.forEach(function(p){ var x=(p[0]-pts[0][0])/3600000, y=parseFloat(p[1]); sx+=x; sy+=y; sxx+=x*x; sxy+=x*y; });
  var den=n*sxx-sx*sx; if (Math.abs(den)<1e-9) return null;
  return (n*sxy-sx*sy)/den;
}
function fmtHours(h){ if(h<1) return Math.max(1,Math.round(h*60))+' menit'; if(h<48) return h.toFixed(h<10?1:0)+' jam'; return Math.round(h/24)+' hari'; }
function trendText(series, lvl){
  var sl=slopePerHour(series, 90*60000);
  if (sl==null || lvl==null) return { txt:'', cls:'' };
  if (Math.abs(sl)<0.3) return { txt:'→ stabil', cls:'' };
  var up=sl>0, eta='';
  if (up && lvl<100) eta=' · penuh ±'+fmtHours((100-lvl)/sl);
  if (!up && lvl>0)  eta=' · kosong ±'+fmtHours(lvl/(-sl));
  if (eta && ((up?(100-lvl)/sl:lvl/(-sl))>72)) eta='';
  return { txt:(up?'▲ +':'▼ ')+sl.toFixed(1)+'%/jam'+eta, cls:up?'up':'down' };
}
function setTrend(ctx, key, series, lvl){
  var el=ctx.$('[data-trend="'+key+'"]'); if(!el) return;
  var t=trendText(series,lvl); el.textContent=t.txt; el.className='wtr-trend '+t.cls;
}
function renderTrends(ctx){
  setTrend(ctx,'gwt1', vSeries(ctx,'gwt','t1_level','t1_dist_cm'), lvlOf(ctx,'gwt','t1_level','t1_dist_cm'));
  setTrend(ctx,'gwt2', vSeries(ctx,'gwt','t2_level','t2_dist_cm'), lvlOf(ctx,'gwt','t2_level','t2_dist_cm'));
  setTrend(ctx,'rw',   vSeries(ctx,'gwt','rw_level','rw_dist_cm'), lvlOf(ctx,'gwt','rw_level','rw_dist_cm'));
  setTrend(ctx,'roof', vSeries(ctx,'roof','level_pct','distance_cm'), lvlOf(ctx,'roof','level_pct','distance_cm'));
}
function ago(ts){ if(!ts) return 'belum pernah'; var s=Math.round((Date.now()-ts)/1000); if(s<90) return s+' dtk lalu'; var m=Math.round(s/60); if(m<90) return m+' mnt lalu'; return Math.round(m/60)+' jam lalu'; }
function updateAge(ctx){
  var chip=ctx.$('[data-age-chip]'), ts=ctx.state.lastDataTs; if(!chip) return;
  setText(ctx.state.rootEl,'age', ts?('· '+ago(ts)):'');
  var age=ts?Date.now()-ts:1e12;
  chip.style.borderColor = age>ctx.cfg.offlineMs?'rgba(239,68,68,.5)':age>30000?'rgba(245,158,11,.5)':'';
}
function gotoTab(ctx, tab){
  var rootEl=ctx.state.rootEl;
  if (rootEl.getAttribute('data-nonav')==='1') return;
  var b=rootEl.querySelector('[data-tab-btn="'+tab+'"]'); if(b) b.click();
  var mn=rootEl.querySelector('[data-main]'); if(mn) mn.scrollTop=0;
}
function buildAlerts(ctx){
  var A=[], cfg=ctx.cfg, D=ctx.state.dev;
  function add(sev,icon,text,tab){ A.push({sev:sev,icon:icon,text:text,tab:tab}); }
  var names={gwt:'GWT',flow:'Transfer pump',roof:'Roof tank',irrG:'Garden Lt.1',irrR:'Garden Roof'};
  var tabOf={gwt:'water',flow:'water',roof:'water',irrG:'irrigation',irrR:'irrigation'};
  var anyPresent=false;
  ROLES.forEach(function(r){
    var d=D[r]; if(!d.present) return; anyPresent=true;
    if (!devOnline(ctx,r)) add('danger','📴',names[r]+' offline — data terakhir '+ago(d.lastTs),tabOf[r]);
    else { var rs=Lv(ctx,r,'rssi'); if (rs!=null && rs<=-85) add('warn','📶','Sinyal '+names[r]+' lemah ('+Math.round(rs)+' dBm) — risiko putus-putus',tabOf[r]); }
  });
  if (!anyPresent) add('info','⏳','Menunggu data — assign datasource (device) ke widget ini.','overview');

  if (D.gwt.present){
    if (tankErr(ctx,'gwt','t1_level','t1_dist_cm')) add('danger','🔌','GWT Tank 1: sensor ultrasonik tidak terbaca (dist = -1)','water');
    if (tankErr(ctx,'gwt','t2_level','t2_dist_cm')) add('danger','🔌','GWT Tank 2: sensor ultrasonik tidak terbaca (dist = -1)','water');
    if (!tankErr(ctx,'gwt','t1_level','t1_dist_cm') && !tankErr(ctx,'gwt','t2_level','t2_dist_cm') && L(ctx,'gwt','balance_ok') && !truthy(Lr(ctx,'gwt','balance_ok')))
      add('warn','⚖️','GWT tidak seimbang (selisih '+(Lv(ctx,'gwt','balance_diff')||0).toFixed(1)+'%) — cek valve balancing','water');
    if (hasRain(ctx)){
      var rl=lvlOf(ctx,'gwt','rw_level','rw_dist_cm');
      if (tankErr(ctx,'gwt','rw_level','rw_dist_cm')) add('danger','🔌','Tangki hujan: sensor ultrasonik tidak terbaca','water');
      else if (rl!=null && rl<cfg.rwLowPct) add('warn','🌧️','Tangki hujan rendah ('+rl.toFixed(0)+'%) — irigasi dialihkan ke GWT','water');
      else if (rl!=null && rl>=cfg.rwOverflowPct) add('info','🌧️','Tangki hujan penuh ('+rl.toFixed(0)+'%) — air bisa meluap','water');
    }
  }
  if (D.flow.present){
    var fl=Lv(ctx,'flow','flow_lpm');
    if (truthy(Lr(ctx,'flow','pump_running')) && fl!=null && fl<cfg.flowDryRunLpm) add('danger','⚠️','Transfer pump berjalan tapi tidak ada aliran (dry-run?)','water');
  }
  if (D.roof.present){
    var lv=lvlOf(ctx,'roof','level_pct','distance_cm'), pr=Lv(ctx,'roof','pressure_bar');
    if (tankErr(ctx,'roof','level_pct','distance_cm')) add('danger','🔌','Roof tank: sensor level tidak terbaca','water');
    else if (lv!=null && lv<cfg.alarmLevelLow) add('warn','🏠','Roof tank rendah ('+lv.toFixed(0)+'%)','water');
    else if (lv!=null && lv>=cfg.alarmLevelHigh) add('info','🏠','Roof tank hampir penuh ('+lv.toFixed(0)+'%)','water');
    if (pr!=null && pr>cfg.pressureHighBar) add('danger','💨','Tekanan roof tinggi ('+pr.toFixed(2)+' bar)','water');
    else if (pr!=null && pr<cfg.pressureLowBar && (truthy(Lr(ctx,'roof','pump1_status'))||truthy(Lr(ctx,'roof','pump2_status')))) add('warn','💨','Tekanan roof rendah saat booster ON ('+pr.toFixed(2)+' bar)','water');
  }
  cfg.irrigZones.forEach(function(z){
    var i=zoneInfo(ctx,z); if(!i.present || !i.online) return;
    if (i.fault===2) add('danger','🚰',z.label+': valve dipaksa tutup (batas waktu siram) — cek debit / sensor','irrigation');
    if (i.status==='err') add('danger','🌱',z.label+': semua sensor tanah error','irrigation');
    else {
      var bad=i.raw.filter(function(v,k){ return v!=null && i.soils[k]==null; }).length;
      if (bad) add('warn','🌱',z.label+': '+bad+' sensor tanah error — memakai sensor yang tersisa','irrigation');
      if (i.mismatch) add('warn','🌱',z.label+': dua sensor tidak sinkron (kalibrasi / posisi probe)','irrigation');
    }
    if (i.on && i.avg!=null && i.avg>=i.wet) add('danger','💦',z.label+': valve OPEN padahal tanah sudah basah','irrigation');
    if (i.on && i.onMs>cfg.valveMaxMin*60000) add('warn','💦',z.label+': valve ON > '+cfg.valveMaxMin+' menit','irrigation');
    if (i.status==='dry' && i.autoMode===false && !i.on) add('warn','🌵',z.label+': kering ('+i.avg.toFixed(0)+'%) & mode MANUAL','irrigation');
  });
  var order={danger:0,warn:1,info:2};
  A.sort(function(a,b){ return order[a.sev]-order[b.sev]; });
  return A;
}
function renderAlerts(ctx){
  var el=ctx.$('[data-alerts]'); if(!el) return;
  var A=buildAlerts(ctx), ui=ctx.state.ui;
  ['water','irrigation'].forEach(function(t){
    var b=ctx.$('[data-badge="'+t+'"]'); if(!b) return;
    var n=A.filter(function(a){return a.tab===t && a.sev!=='info';}), d=n.some(function(a){return a.sev==='danger';});
    b.textContent=n.length||''; b.className='bdg'+(n.length?' on':'')+(d?' danger':'');
  });
  if (!A.length){ el.innerHTML='<div class="wtr-alerts-ok">✅ Semua sistem normal — tidak ada peringatan</div>'; return; }
  var c={danger:0,warn:0,info:0}; A.forEach(function(a){ c[a.sev]++; });
  var show = ui.alertsAll ? A : A.slice(0,3);
  var html='<div class="wtr-alerts-hd">PERHATIAN '+
    (c.danger?'<span class="wtr-pill danger">'+c.danger+' kritis</span>':'')+(c.warn?'<span class="wtr-pill warn">'+c.warn+' peringatan</span>':'')+(c.info?'<span class="wtr-pill info">'+c.info+' info</span>':'')+'</div>';
  show.forEach(function(a){ html+='<button class="wtr-alert '+a.sev+'" data-goto="'+a.tab+'"><span>'+a.icon+'</span><span class="tx">'+esc(a.text)+'</span><span class="go">buka ›</span></button>'; });
  if (A.length>3) html+='<button class="wtr-more" data-alerts-more>'+(ui.alertsAll?'▴ Sembunyikan':'▾ Lihat semua ('+A.length+')')+'</button>';
  el.innerHTML=html;
}
function attachHover(ctx, name, svg){
  if(!svg) return;
  var box=svg.parentNode, line=box.querySelector('[data-xline="'+name+'"]'), tip=box.querySelector('[data-tip="'+name+'"]');
  function hide(){ if(line) line.style.display='none'; if(tip) tip.style.display='none'; }
  svg.addEventListener('mouseleave', hide);
  svg.addEventListener('mousemove', function(ev){
    var m=ctx.state.models[name]; if(!m){ hide(); return; }
    var r=svg.getBoundingClientRect(), vx=(ev.clientX-r.left)/r.width*m.W;
    if (vx<m.padL || vx>m.padL+m.cW){ hide(); return; }
    var ts=m.fromTs+(vx-m.padL)/m.cW*m.spanMs, tol=Math.max(20*60000, m.spanMs/60), rows='';
    m.series.forEach(function(s){
      var p=nearestPt(s.data, ts, tol); if(!p) return;
      var v=parseFloat(p[1]); if(isNaN(v)) return;
      var extra=''; if (s.valve){ var st=lastBefore(s.valve, ts); if(st!=null) extra=' <span style="color:'+(truthy(st)?'#10b981':'#64748b')+'">'+(truthy(st)?'● OPEN':'○ closed')+'</span>'; }
      rows+='<div class="r"><span><i style="background:'+s.color+'"></i>'+esc(s.label)+'</span><b>'+s.fmt(v)+extra+'</b></div>';
    });
    if(!rows){ hide(); return; }
    var d=new Date(ts), left=(ev.clientX-r.left);
    line.style.display='block'; line.style.left=left+'px';
    tip.innerHTML='<div class="t">'+pad2(d.getDate())+'/'+pad2(d.getMonth()+1)+' '+pad2(d.getHours())+':'+pad2(d.getMinutes())+'</div>'+rows;
    tip.style.display='block';
    var tw=tip.offsetWidth; tip.style.left=Math.max(4, Math.min(r.width-tw-4, left+14 > r.width-tw-4 ? left-tw-14 : left+14))+'px';
  });
}
function nearestPt(series, ts, tol){
  if(!series||!series.length) return null;
  var lo=0, hi=series.length-1;
  while(lo<hi){ var mid=(lo+hi)>>1; if(series[mid][0]<ts) lo=mid+1; else hi=mid; }
  var best=series[lo]; if(lo>0 && Math.abs(series[lo-1][0]-ts)<Math.abs(best[0]-ts)) best=series[lo-1];
  return Math.abs(best[0]-ts)<=tol ? best : null;
}
function lastBefore(series, ts){ var v=null; for(var i=0;i<series.length;i++){ if(series[i][0]<=ts) v=series[i][1]; else break; } return v; }

/* ============================ v5: HERO / GARDEN MAP / ARCS / SPARKS ============================ */
function renderHero(ctx){
  var ring=ctx.$('[data-hero-ring]'), leg=ctx.$('[data-hero-leg]'); if(!ring||!leg) return;
  var cfg=ctx.cfg, items=[];
  if (ctx.state.dev.gwt.present){
    var v1=volOf(ctx,'gwt','t1_level','t1_dist_cm','gwtT1CapacityL','t1_vol_l'), v2=volOf(ctx,'gwt','t2_level','t2_dist_cm','gwtT2CapacityL','t2_vol_l');
    var cap=(v1!=null?cfg.gwtT1CapacityL:0)+(v2!=null?cfg.gwtT2CapacityL:0), vol=sumVol(v1,v2);
    var e1=tankErr(ctx,'gwt','t1_level','t1_dist_cm'), e2=tankErr(ctx,'gwt','t2_level','t2_dist_cm');
    items.push({name:'GWT',sub:(e1||e2)?'sensor error':'2 tank',color:'#38bdf8',vol:vol,pct:cap?vol/cap*100:null,err:(e1&&e2),
      trend:trendText(vSeries(ctx,'gwt','t1_level','t1_dist_cm'),lvlOf(ctx,'gwt','t1_level','t1_dist_cm'))});
  }
  if (ctx.state.dev.roof.present){
    var rv=volOf(ctx,'roof','level_pct','distance_cm','roofTankCapacityL','volume_l'), rp=lvlOf(ctx,'roof','level_pct','distance_cm');
    items.push({name:'Roof',sub:'booster',color:'#22d3ee',vol:rv,pct:rp,err:tankErr(ctx,'roof','level_pct','distance_cm'),trend:trendText(vSeries(ctx,'roof','level_pct','distance_cm'),rp)});
  }
  if (hasRain(ctx)){
    var wv=volOf(ctx,'gwt','rw_level','rw_dist_cm','rwCapacityL','rw_vol_l'), wp=lvlOf(ctx,'gwt','rw_level','rw_dist_cm');
    items.push({name:'Rain',sub:'tadah hujan',color:'#2dd4bf',vol:wv,pct:wp,err:tankErr(ctx,'gwt','rw_level','rw_dist_cm'),trend:trendText(vSeries(ctx,'gwt','rw_level','rw_dist_cm'),wp)});
  }
  var radii=[86,70,54], s='<svg viewBox="0 0 200 200">';
  items.forEach(function(it,i){
    var R=radii[i], C=2*Math.PI*R, p=it.pct==null?0:Math.max(0,Math.min(100,it.pct));
    s+='<circle cx="100" cy="100" r="'+R+'" fill="none" style="stroke:'+(it.err?'rgba(239,68,68,.55)':'var(--ring)')+'" stroke-width="11"'+(it.err?' stroke-dasharray="3 5"':'')+'/>';
    if (!it.err) s+='<circle cx="100" cy="100" r="'+R+'" fill="none" stroke="'+it.color+'" stroke-width="11" stroke-linecap="round" stroke-dasharray="'+(C*p/100)+' '+C+'" transform="rotate(-90 100 100)" style="transition:stroke-dasharray .8s ease"/>';
  });
  ring.innerHTML=s+'</svg>';
  leg.innerHTML=items.map(function(it){
    return '<div class="lg"><i style="background:'+it.color+'"></i><div class="n">'+it.name+'<small>'+it.sub+'</small></div><div class="p'+(it.err?' err':'')+'">'+(it.err?'ERR':(it.pct==null?'--':it.pct.toFixed(0)+'%'))+'</div>'+
           '<div class="meta"><span class="v">'+(it.vol==null?'--':formatVol(it.vol))+'</span><span class="t '+it.trend.cls+'">'+esc(it.trend.txt)+'</span></div></div>';
  }).join('') || '<div class="wtr-event-empty">Menunggu data tangki…</div>';
}

function soilColor(avg, status){
  if (avg==null) return '#334155';
  var hue=28+(Math.max(0,Math.min(100,avg))/100)*172;                 // cokelat -> hijau -> biru
  return 'hsl('+hue.toFixed(0)+',52%,'+(26+avg*0.1).toFixed(0)+'%)';
}
function renderGardenMap(ctx){
  var els=ctx.state.rootEl.querySelectorAll('[data-garden]'); if(!els.length) return;
  var infos={}; ctx.cfg.irrigZones.forEach(function(z){ infos[z.id]=zoneInfo(ctx,z); });
  var anyOn=ctx.cfg.irrigZones.some(function(z){ return infos[z.id].present && infos[z.id].on; });
  var beds=[{role:'irrG',label:'GARDEN LT.1',x:14,w:580,ids:['g1','g2']},{role:'irrR',label:'GARDEN ROOF',x:614,w:272,ids:['r1']}];
  var s='<svg class="garden-svg" viewBox="0 0 900 300"><defs>'+
    '<pattern id="soilp" width="14" height="14" patternUnits="userSpaceOnUse"><circle cx="3" cy="4" r="1.1" fill="#000" opacity=".35"/><circle cx="10" cy="10" r="1.3" fill="#fff" opacity=".12"/></pattern></defs>';
  s+='<line class="wtr-flow-pipe irr'+(anyOn?' active':'')+'" x1="0" y1="50" x2="900" y2="50"/>';
  beds.forEach(function(b){
    var dev=ctx.state.dev[b.role];
    if (!dev.present){ s+='<rect x="'+b.x+'" y="66" width="'+b.w+'" height="216" rx="16" fill="none" stroke="rgba(148,163,184,.25)" stroke-dasharray="6 6"/><text x="'+(b.x+b.w/2)+'" y="178" text-anchor="middle" fill="#64748b" font-size="13" font-weight="700">'+b.label+' n/a</text>'; return; }
    var online=devOnline(ctx,b.role);
    s+='<text x="'+(b.x+6)+'" y="24" fill="#94a3b8" font-size="12" font-weight="800" letter-spacing="1.5">'+b.label+'</text>'+
       '<text x="'+(b.x+b.w-6)+'" y="24" text-anchor="end" fill="'+(online?'#10b981':'#64748b')+'" font-size="10" font-weight="700">'+(online?'● online':'○ offline')+'</text>';
    s+='<rect x="'+b.x+'" y="66" width="'+b.w+'" height="216" rx="16" fill="rgba(120,80,40,.16)" stroke="rgba(180,120,70,.55)" stroke-width="3"/>';
    var n=b.ids.length, pad=12, zw=(b.w-pad*(n+1))/n;
    b.ids.forEach(function(id,k){
      var i=infos[id]; if(!i||!i.present) return;
      var zx=b.x+pad+k*(zw+pad), zy=78, zh=192, cx=zx+zw/2, col=soilColor(i.avg,i.status);
      var pill=i.status==='ok'?['OPTIMAL','#10b981']:i.status==='dry'?['DRY','#f59e0b']:i.status==='wet'?['WET','#60a5fa']:['SENSOR ERR','#ef4444'];
      s+='<g data-goto="irrigation" style="cursor:pointer"><title>'+esc(i.z.label)+' — klik untuk kontrol</title>';
      // valve + feeder
      s+='<line class="wtr-flow-pipe irr'+(i.on?' active':'')+'" x1="'+cx+'" y1="50" x2="'+cx+'" y2="'+zy+'" style="stroke-width:4"/>'+
         '<circle cx="'+cx+'" cy="50" r="11" fill="'+(i.on?'#10b981':'#475569')+'" stroke="rgba(255,255,255,.6)" stroke-width="1.5"'+(i.on?' class="wtr-pulse"':'')+'/><text x="'+cx+'" y="54" text-anchor="middle" fill="#fff" font-size="11" font-weight="800">V</text>';
      s+='<rect x="'+zx+'" y="'+zy+'" width="'+zw+'" height="'+zh+'" rx="12" fill="'+col+'" style="transition:fill .8s"/>'+
         '<rect x="'+zx+'" y="'+zy+'" width="'+zw+'" height="'+zh+'" rx="12" fill="url(#soilp)"/>'+
         '<rect x="'+zx+'" y="'+zy+'" width="'+zw+'" height="'+zh+'" rx="12" fill="none" stroke="rgba(255,255,255,.18)"/>';
      // tanaman
      var plant=i.status==='dry'?'🥀':i.status==='wet'?'🌱':'🌿', cols=Math.max(3,Math.floor((zw*0.58)/40)), rows=2;
      for (var r=0;r<rows;r++) for (var c=0;c<cols;c++){
        var px=zx+zw*(0.4+0.58*(c+0.5)/cols), py=zy+92+r*30+((c%2)?8:0);
        s+='<text x="'+px.toFixed(1)+'" y="'+py+'" text-anchor="middle" font-size="19" opacity=".9">'+plant+'</text>';
      }
      // sprinkler
      var sy=zy+zh*0.5;
      if (i.on){ for (var q=0;q<3;q++) s+='<circle class="wtr-spray" style="animation-delay:'+(q*0.5)+'s" cx="'+cx+'" cy="'+sy+'" r="'+(zw*0.26)+'" fill="none" stroke="#7dd3fc" stroke-width="2.5"/>'; s+='<text x="'+cx+'" y="'+(sy+6)+'" text-anchor="middle" font-size="20">💦</text>'; }
      else s+='<circle cx="'+cx+'" cy="'+sy+'" r="5" fill="#94a3b8" opacity=".7"/>';
      // probe sensor
      (i.raw.length===1?[0.5]:[0.2,0.8]).forEach(function(f,idx){
        var px=zx+zw*f, py=zy+zh-38, raw=i.raw[idx], val=i.soils[idx], bad=(raw==null||val==null);
        s+='<rect x="'+(px-1.5)+'" y="'+py+'" width="3" height="26" rx="1.5" fill="#e2e8f0" opacity=".85"/>'+
           '<circle cx="'+px+'" cy="'+py+'" r="4" fill="'+(bad?'#ef4444':'#22d3ee')+'" stroke="#fff" stroke-width="1.2"/>'+
           '<rect x="'+(px-20)+'" y="'+(py-24)+'" width="40" height="16" rx="8" fill="rgba(2,6,23,.72)"/>'+
           '<text x="'+px+'" y="'+(py-12.5)+'" text-anchor="middle" fill="'+(bad?'#fca5a5':'#e2e8f0')+'" font-size="10" font-weight="800">'+(bad?'ERR':val.toFixed(0)+'%')+'</text>';
      });
      // label & nilai besar
      var pw=pill[0].length*6.4+16;
      s+='<text x="'+(zx+12)+'" y="'+(zy+22)+'" fill="#fff" font-size="12" font-weight="800" opacity=".9" style="paint-order:stroke" stroke="rgba(0,0,0,.35)" stroke-width="2">ZONE '+(infos[id].z.label.slice(-1))+'</text>'+
         '<text x="'+(zx+12)+'" y="'+(zy+62)+'" fill="#fff" font-size="36" font-weight="800" style="paint-order:stroke" stroke="rgba(0,0,0,.35)" stroke-width="3">'+(i.avg==null?'--':i.avg.toFixed(0)+'%')+'</text>'+
         '<rect x="'+(zx+zw-12-pw)+'" y="'+(zy+10)+'" width="'+pw+'" height="17" rx="8.5" fill="'+pill[1]+'"/>'+
         '<text x="'+(zx+zw-12-pw/2)+'" y="'+(zy+22)+'" text-anchor="middle" fill="#fff" font-size="9.5" font-weight="800">'+pill[0]+'</text>';
      if (i.on && i.remainS>0) s+='<text x="'+(zx+12)+'" y="'+(zy+80)+'" fill="#d1fae5" font-size="11" font-weight="800">⏱ '+formatRuntime(i.remainS)+'</text>';
      s+='</g>';
    });
  });
  s+='</svg>';
  els.forEach(function(el){ el.innerHTML=s; });
}

function arcGauge(pct, color, vTxt, unit, maxTxt){
  var L=Math.PI*46, p=Math.max(0,Math.min(100,pct||0));
  return '<svg viewBox="0 0 120 78"><path d="M14,64 A46,46 0 0 1 106,64" fill="none" style="stroke:var(--ring)" stroke-width="10" stroke-linecap="round"/>'+
    '<path d="M14,64 A46,46 0 0 1 106,64" fill="none" stroke="'+color+'" stroke-width="10" stroke-linecap="round" stroke-dasharray="'+(L*p/100).toFixed(1)+' '+L.toFixed(1)+'" style="transition:stroke-dasharray .7s ease"/>'+
    '<text class="arc-v" x="60" y="56" text-anchor="middle">'+vTxt+'</text><text class="arc-u" x="60" y="68" text-anchor="middle">'+unit+'</text>'+
    '<text class="arc-m" x="14" y="76" text-anchor="middle">0</text><text class="arc-m" x="106" y="76" text-anchor="middle">'+maxTxt+'</text></svg>';
}
function renderArcs(ctx){
  var cfg=ctx.cfg, el;
  if ((el=ctx.$('[data-arc="flow"]'))){ var f=Lv(ctx,'flow','flow_lpm'); el.innerHTML=arcGauge(f==null?0:f/cfg.flowMaxLpm*100,'#a78bfa',f==null?'--':f.toFixed(1),'L/min',Math.round(cfg.flowMaxLpm)); }
  if ((el=ctx.$('[data-arc="rw"]'))){ var r=Lv(ctx,'gwt','rw_flow_lpm'); el.innerHTML=arcGauge(r==null?0:r/cfg.rwFlowMaxLpm*100,'#2dd4bf',r==null?'--':r.toFixed(1),'L/min',Math.round(cfg.rwFlowMaxLpm)); }
  if ((el=ctx.$('[data-arc="press"]'))){ var p=Lv(ctx,'roof','pressure_bar'), col=(p!=null&&p<cfg.pressureLowBar)?'#f59e0b':(p!=null&&p>cfg.pressureHighBar)?'#ef4444':'#22d3ee';
    el.innerHTML=arcGauge(p==null?0:p/cfg.pressureMaxBar*100,col,p==null?'--':p.toFixed(2),'bar',Math.round(cfg.pressureMaxBar)); }
}
function miniSpark(el, series, color, ymax, multi){
  if(!el) return;
  var sets = multi ? series : [{data:series,color:color}], out='', t0=Infinity, t1=-Infinity;
  sets.forEach(function(s){ if(s.data.length){ t0=Math.min(t0,s.data[0][0]); t1=Math.max(t1,s.data[s.data.length-1][0]); } });
  if (!isFinite(t0) || t1<=t0){ el.innerHTML='<text x="50" y="20" text-anchor="middle" fill="#64748b" font-size="7">no history</text>'; return; }
  var span=t1-t0, gid='sg'+Math.random().toString(36).slice(2,6);
  sets.forEach(function(s,k){
    var d=s.data; if (d.length>140){ var st=Math.ceil(d.length/140); d=d.filter(function(_,i){return i%st===0;}); }
    var vals=d.map(function(p){return parseFloat(p[1]);}).filter(function(v){return !isNaN(v);}); if(vals.length<2) return;
    var mx=ymax||Math.max(1,Math.max.apply(null,vals)*1.15);
    var pts=d.map(function(p){ var v=parseFloat(p[1]); return ((p[0]-t0)/span*100).toFixed(1)+','+(31-Math.max(0,Math.min(1,v/mx))*28).toFixed(1); });
    if (!multi) out+='<defs><linearGradient id="'+gid+'" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="'+s.color+'" stop-opacity=".35"/><stop offset="1" stop-color="'+s.color+'" stop-opacity="0"/></linearGradient></defs><polygon points="0,32 '+pts.join(' ')+' 100,32" fill="url(#'+gid+')"/>';
    out+='<polyline points="'+pts.join(' ')+'" fill="none" stroke="'+s.color+'" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>';
  });
  el.innerHTML=out;
}
function renderSparks(ctx){
  miniSpark(ctx.$('[data-spark="flow"]'), S(ctx,'flow','flow_lpm'), '#a78bfa', null);
  miniSpark(ctx.$('[data-spark="rain"]'), S(ctx,'gwt','rw_flow_lpm'), '#2dd4bf', null);
  miniSpark(ctx.$('[data-spark="bal"]'), S(ctx,'gwt','balance_diff'), '#f59e0b', null);
  var multi=ctx.cfg.irrigZones.filter(function(z){return ctx.state.dev[z.role].present;}).map(function(z){ return {data:zoneAvgSeries(ctx,z),color:z.color}; });
  miniSpark(ctx.$('[data-spark="irr"]'), multi, null, 100, true);
}

/* ============================ HELPERS ============================ */
function bindBtn(rootEl, action, handler){ var b=rootEl.querySelector('[data-action="'+action+'"]'); if(b) b.addEventListener('click',handler); }
function applyPreset(ctx,p){ var now=new Date();
  switch(p){
    case '6h':  ctx.state.range.from=new Date(now.getTime()-6*3600000); break;
    case '24h': ctx.state.range.from=new Date(now.getTime()-24*3600000); break;
    case '7d':  ctx.state.range.from=new Date(now.getTime()-7*86400000); break;
    case '30d': ctx.state.range.from=new Date(now.getTime()-30*86400000); break;
    case 'custom': return;
  }
  ctx.state.range.to=now; ctx.state.range.preset=p;
}
function markCustom(rootEl){ rootEl.querySelectorAll('[data-preset]').forEach(function(b){b.classList.remove('active');}); var c=rootEl.querySelector('[data-preset="custom"]'); if(c) c.classList.add('active'); }
function setText(rootEl,key,val){ var el=rootEl.querySelector('[data-bind="'+key+'"]'); if(el) el.textContent=val; }
function pad2(n){ return (n<10?'0':'')+n; }
function isoDt(d){ return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate())+'T'+pad2(d.getHours())+':'+pad2(d.getMinutes()); }
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function formatVol(LL){ if(LL==null||isNaN(LL)) return '-- L'; if(LL>=1000) return (LL/1000).toFixed(2)+' kL'; return LL.toFixed(0)+' L'; }
function formatRuntime(sec){ if(sec==null||isNaN(sec)) return '--'; var s=Math.floor(sec),h=Math.floor(s/3600),m=Math.floor((s%3600)/60); if(h>=1) return h+'h '+(m<10?'0':'')+m+'m'; return m+'m '+(s%60)+'s'; }
function formatUptime(sec){ sec=Math.round(sec); var d=Math.floor(sec/86400),h=Math.floor((sec%86400)/3600),m=Math.floor((sec%3600)/60); if(d>0) return d+'d '+h+'h'; if(h>0) return h+'h '+m+'m'; return m+'m '+(sec%60)+'s'; }
function toast(ctx,msg,type){ var wrap=ctx.$('[data-toast-wrap]'); if(!wrap) return; var t=document.createElement('div'); t.className='wtr-toast '+(type||''); t.textContent=msg; wrap.appendChild(t);
  setTimeout(function(){ t.style.transition='opacity .3s, transform .3s'; t.style.opacity='0'; t.style.transform='translateX(10px)'; setTimeout(function(){ if(t.parentNode) t.parentNode.removeChild(t); },350); },3500); }
