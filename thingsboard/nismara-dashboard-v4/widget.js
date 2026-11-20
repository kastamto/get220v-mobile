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
    { id:'g1', role:'irrG', label:'Garden Lt.1 · Zone 1', soil:['z1_soil1','z1_soil2'], valve:'z1_valve', color:'#34d399' },
    { id:'g2', role:'irrG', label:'Garden Lt.1 · Zone 2', soil:['z2_soil1','z2_soil2'], valve:'z2_valve', color:'#fbbf24' },
    { id:'r1', role:'irrR', label:'Garden Roof · Zone 1', soil:['z1_soil1','z1_soil2'], valve:'z1_valve', color:'#60a5fa' }
  ],

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
self.onDestroy = function(){};

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
    if (!buckets[id]) buckets[id] = { keys:{}, name: ds.entityLabel || ds.entityName || ds.name || id };
    buckets[id].keys[d.dataKey.name] = d.data || [];
  });

  Object.keys(buckets).forEach(function(id){
    var b = buckets[id];
    var role = classifyRole(b.keys, b.name);
    var t = dev[role] || dev.unknown;
    t.present = true; t.name = b.name; t.dsId = id;
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
  var dry = z.dry!=null?z.dry:cfg.soilDryPct, wet = z.wet!=null?z.wet:cfg.soilWetPct, target = z.target!=null?z.target:cfg.soilTargetPct;
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
  else if (!online) msg='Device offline — data tidak terbaru.';
  else if (status==='err') msg='Sensor tanah error / di luar 0–100% — cek probe & kabel.';
  else if (on){
    if (avg>=wet) msg='Valve ON padahal tanah sudah basah — cek auto-stop / valve macet.';
    else if (onMs>cfg.valveMaxMin*60000) msg='Valve ON > '+cfg.valveMaxMin+' menit — periksa kebocoran / relay.';
    else msg='Sedang menyiram · target '+target+'%.';
  } else if (status==='dry'){
    msg='Perlu siram — '+(cfg.irrigSource==='rain' ? (rainOk?'air hujan tersedia.':'tangki hujan rendah, gunakan GWT.') : 'sumber GWT.');
  } else if (status==='wet') msg='Tanah basah — tidak perlu siram.';
  else msg='Kelembaban optimal.';
  if (hasKeys && mismatch) msg+=' ⚠ Selisih 2 sensor '+Math.abs(valid[0]-valid[1]).toFixed(0)+'%.';

  return { z:z, present:hasKeys, soils:soils, raw:raw, avg:avg, dry:dry, wet:wet, target:target,
           on:on, valveHas:valveHas, online:online, status:status, mismatch:mismatch, onMs:onMs, msg:msg };
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

  function tankGlyph(cx, topY, w, h, pct, color, err){
    var fillH=(Math.max(0,Math.min(100,pct||0))/100)*(h-6);
    var x=cx-w/2;
    var s='<rect x="'+x+'" y="'+topY+'" width="'+w+'" height="'+h+'" rx="6" fill="rgba(255,255,255,.03)" stroke="'+(err?'#ef4444':'rgba(148,163,184,.4)')+'" stroke-width="1.5"/>';
    if (fillH>0) s+='<rect x="'+(x+2)+'" y="'+(topY+h-3-fillH)+'" width="'+(w-4)+'" height="'+(fillH+1)+'" rx="3" fill="'+color+'" opacity="0.85"/>';
    if (err) s+='<text x="'+cx+'" y="'+(topY+h/2+4)+'" text-anchor="middle" fill="#ef4444" font-size="11" font-weight="800">ERR</text>';
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
  var pct=lvlOf(ctx,'gwt','rw_level','rw_dist_cm'), err=tankErr(ctx,'gwt','rw_level','rw_dist_cm');
  var vol=volOf(ctx,'gwt','rw_level','rw_dist_cm','rwCapacityL','rw_vol_l');
  var dist=Lv(ctx,'gwt','rw_dist_cm');
  setText(rootEl,'rwPct', pctTxt(ctx,'gwt','rw_level','rw_dist_cm',1));
  setText(rootEl,'rwVol', vol==null?'--':formatVol(vol));
  setText(rootEl,'rwDist', distTxt(dist));
  setText(rootEl,'rwCap', formatVol(cfg.rwCapacityL));
  drawTank(ctx, ctx.$('[data-rw-svg]'), pct, 120, 200, '#2dd4bf');
  tankCardClass(ctx.$('[data-rw-tank]'), pct, err);
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
  var rootEl=ctx.state.rootEl, cfg=ctx.cfg;
  var fromTs=ctx.state.range.from.getTime(), toTs=ctx.state.range.to.getTime();
  var infos=cfg.irrigZones.map(function(z){ return zoneInfo(ctx,z); });
  var html='', totalWaterL=0, anyWater=false;

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
    var barW = i.avg==null?0:Math.max(0,Math.min(100,i.avg));
    var devName = ctx.state.dev[z.role].name || (z.role==='irrR'?'Garden Roof':'Garden Lt.1');

    html+='<div class="wtr-zone'+(i.on?' on':'')+(i.online?'':' off-line')+'">'+
      '<div class="zn-head"><div><div class="zn-name">'+esc(z.label)+'</div><div class="zn-dev">'+esc(devName)+' · '+(i.online?'online':'offline')+'</div></div>'+
        '<div class="zn-valve"><span class="led"></span>VALVE '+(i.valveHas?(i.on?'OPEN':'CLOSED'):'--')+'</div></div>'+
      '<div><div class="zn-main"><div class="zn-pct">'+(i.avg==null?'--':i.avg.toFixed(0))+'<span class="u">%</span></div><span class="wtr-tag '+tagCls+'" style="margin-top:0">'+tagTxt+'</span></div>'+
        '<div class="zn-bar" style="margin-top:10px"><div class="fill '+i.status+'" style="width:'+barW.toFixed(0)+'%"></div>'+
          '<div class="mk" style="left:'+i.dry+'%" title="dry '+i.dry+'%"></div><div class="mk" style="left:'+i.wet+'%" title="wet '+i.wet+'%"></div></div></div>'+
      '<div class="zn-sensors">'+
        sensorBox('Soil 1', i.raw[0], i.soils[0])+sensorBox('Soil 2', i.raw[1], i.soils[1])+
      '</div>'+
      '<div class="zn-decision">'+esc(i.msg)+'</div>'+
      '<div class="zn-foot"><div>Siram (range): <b>'+formatRuntime(runMs/1000)+'</b></div><div>≈ <b>'+formatVol(waterL)+'</b></div></div>'+
    '</div>';
  });
  wrap.innerHTML=html;

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

/* ============================ TANK SVG ============================ */
function drawTank(ctx, svg, pct, W, H, color){
  if(!svg) return;
  pct=Math.max(0,Math.min(100,pct||0));
  var mX=22, topM=14, botM=14;
  var tankW=W-2*mX, tankH=H-topM-botM;
  var waterMaxH=tankH-12;
  var fillH=(pct/100)*waterMaxH;
  var tx=mX, ty=topM;
  var waterY=ty+tankH-6-fillH;
  var id=uid(svg);
  var s='<defs><linearGradient id="g_'+id+'" x1="0" y1="0" x2="0" y2="1">'+
    '<stop offset="0%" stop-color="'+color+'" stop-opacity="0.85"/>'+
    '<stop offset="100%" stop-color="'+color+'" stop-opacity="0.55"/></linearGradient>'+
    '<clipPath id="c_'+id+'"><rect x="'+(tx+2)+'" y="'+(ty+2)+'" width="'+(tankW-4)+'" height="'+(tankH-4)+'" rx="6"/></clipPath></defs>';
  for (var k=0;k<=4;k++){ var yy=ty+6+(waterMaxH*k/4); var lbl=100-k*25;
    s+='<line x1="'+(tx-4)+'" y1="'+yy+'" x2="'+tx+'" y2="'+yy+'" stroke="rgba(148,163,184,.5)" stroke-width="1"/>';
    s+='<text x="'+(tx-6)+'" y="'+(yy+3)+'" text-anchor="end" fill="#64748b" font-size="8">'+lbl+'</text>';
  }
  s+='<rect x="'+tx+'" y="'+ty+'" width="'+tankW+'" height="'+tankH+'" rx="6" fill="rgba(255,255,255,.02)" stroke="rgba(148,163,184,.4)" stroke-width="1.5"/>';
  if (fillH>0){
    var x0=tx+4, x1=tx+tankW-4;
    var wp='M'+x0+','+waterY, up=true;
    for (var x=x0+14; x<=x1; x+=14){ wp+=' Q'+(x-7)+','+(waterY+(up?-3:3))+' '+x+','+waterY; up=!up; }
    wp+=' L'+x1+','+(ty+tankH-6)+' L'+x0+','+(ty+tankH-6)+' Z';
    s+='<g clip-path="url(#c_'+id+')"><path d="'+wp+'" fill="url(#g_'+id+')"/></g>';
  }
  s+='<rect x="'+(tx+tankW/2-10)+'" y="'+(ty-5)+'" width="20" height="5" rx="1" fill="rgba(148,163,184,.3)"/>';
  svg.innerHTML=s;
}

function drawRoofTank(ctx, svg, pct, N){
  if(!svg) return;
  pct=Math.max(0,Math.min(100,pct||0));
  N=Math.max(1,Math.min(N||1,8));
  var W=280,H=200, mX=14, topM=12, botM=(N>1?22:14);
  var availW=W-2*mX, tankH=H-topM-botM, cellW=availW/N;
  var tankW = N===1?150 : N===2?70 : N===3?50 : N===4?38 : Math.max(20,cellW-6);
  var rTop=N===1?8:4, waterMaxH=tankH-12, fillH=(pct/100)*waterMaxH;
  function cx(i){ return mX+i*cellW+cellW/2; } function lx(i){ return cx(i)-tankW/2; }
  var s='<defs><linearGradient id="rg" x1="0" y1="0" x2="0" y2="1">'+
    '<stop offset="0%" stop-color="#22d3ee" stop-opacity="0.85"/>'+
    '<stop offset="100%" stop-color="#0e7490" stop-opacity="0.92"/></linearGradient>';
  for (var i=0;i<N;i++){ var tx0=lx(i); s+='<clipPath id="rc'+i+'"><rect x="'+(tx0+2)+'" y="'+(topM+2)+'" width="'+(tankW-4)+'" height="'+(tankH-4)+'" rx="'+rTop+'"/></clipPath>'; }
  s+='</defs>';
  var fx=lx(0);
  for (var k=0;k<=4;k++){ var yy=topM+6+(waterMaxH*k/4); var lbl=100-k*25;
    s+='<line x1="'+(fx-4)+'" y1="'+yy+'" x2="'+fx+'" y2="'+yy+'" stroke="rgba(148,163,184,.5)" stroke-width="1"/>';
    s+='<text x="'+(fx-6)+'" y="'+(yy+3)+'" text-anchor="end" fill="#64748b" font-size="8">'+lbl+'</text>'; }
  for (var i2=0;i2<N;i2++){
    var tx=lx(i2), ty=topM, waterY=ty+tankH-6-fillH, sw=N===1?2:1.4;
    s+='<rect x="'+tx+'" y="'+ty+'" width="'+tankW+'" height="'+tankH+'" rx="'+rTop+'" fill="rgba(255,255,255,.02)" stroke="rgba(148,163,184,.4)" stroke-width="'+sw+'"/>';
    if (fillH>0){
      var fc;
      if (N===1 && fillH>4){ var x0=tx+4,x1=tx+tankW-4,wp='M'+x0+','+waterY,up=true;
        for (var x=x0+16;x<=x1;x+=16){ wp+=' Q'+(x-8)+','+(waterY+(up?-3:3))+' '+x+','+waterY; up=!up; }
        wp+=' L'+x1+','+(ty+tankH-6)+' L'+x0+','+(ty+tankH-6)+' Z'; fc='<path d="'+wp+'" fill="url(#rg)"/>'; }
      else fc='<rect x="'+(tx+2)+'" y="'+waterY+'" width="'+(tankW-4)+'" height="'+(fillH+2)+'" fill="url(#rg)"/>';
      s+='<g clip-path="url(#rc'+i2+')">'+fc+'</g>';
    }
    if (N>1) s+='<text x="'+cx(i2)+'" y="'+(topM+tankH+15)+'" text-anchor="middle" fill="#94a3b8" font-size="8" font-weight="700">T'+(i2+1)+'</text>';
  }
  if (N>1){ var pipeY=topM+tankH+4, f=cx(0), l=cx(N-1);
    s+='<line x1="'+f+'" y1="'+pipeY+'" x2="'+l+'" y2="'+pipeY+'" stroke="rgba(34,211,238,.6)" stroke-width="2"/>';
    for (var j=0;j<N;j++){ var jx=cx(j); s+='<line x1="'+jx+'" y1="'+(topM+tankH)+'" x2="'+jx+'" y2="'+pipeY+'" stroke="rgba(34,211,238,.6)" stroke-width="2"/>'; }
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
  if (allTs.length<2){ svg.style.display='none'; if(emptyEl){emptyEl.style.display='flex';} return; }
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
  if (allTs.length<2){ svg.style.display='none'; if(emptyEl) emptyEl.style.display='flex'; if(legend) legend.innerHTML=''; return; }
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
}

/* ============================ EVENTS RENDER ============================ */
function renderEvents(ctx){
  var listEl=ctx.$('[data-event-list]'), countEl=ctx.$('[data-bind="eventCount"]');
  var ev=ctx.state.events||[];
  if (countEl){ countEl.textContent='['+ev.length+']'; }
  if (!ev.length){ if(listEl) listEl.innerHTML='<div class="wtr-event-empty">No events in selected range.</div>'; return; }
  var html='';
  ev.slice(0,80).forEach(function(e){
    var d=new Date(e.ts);
    var time=pad2(d.getDate())+'/'+pad2(d.getMonth()+1)+' '+pad2(d.getHours())+':'+pad2(d.getMinutes());
    html+='<div class="wtr-event-item">'+
      '<div class="wtr-event-type '+e.cls+'">'+esc(e.type)+'</div>'+
      '<div class="wtr-event-time">'+time+'</div>'+
      '<div class="wtr-event-badge '+e.cls+'" style="color:'+badgeColor(e.cls)+'">'+esc(e.badge)+'</div>'+
    '</div>';
  });
  if (listEl) listEl.innerHTML=html;
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
