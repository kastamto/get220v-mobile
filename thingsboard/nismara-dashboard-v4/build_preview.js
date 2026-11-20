// node build_preview.js -> preview.html  (standalone, data simulasi, bisa dibuka langsung di browser)
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/widget.html', 'utf8');
const js = fs.readFileSync(__dirname + '/widget.js', 'utf8');
const esc = s => JSON.stringify(s).replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

const page = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NISMARA Dashboard v4 — Preview</title>
<style>
html,body{margin:0;height:100%;background:#030712;font-family:-apple-system,BlinkMacSystemFont,Inter,Segoe UI,Roboto,sans-serif}
#bar{position:fixed;z-index:10000;top:0;left:0;right:0;display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:7px 14px;background:rgba(2,6,23,.92);border-bottom:1px solid #1e293b;color:#94a3b8;font-size:12px;backdrop-filter:blur(6px)}
#bar b{color:#22d3ee}#bar select,#bar button{background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:4px 9px;font-size:12px;cursor:pointer}
#bar .hint{margin-left:auto;opacity:.75}
#host{position:absolute;top:44px;left:0;right:0;bottom:0}
</style></head><body>
<div id="bar"><b>PREVIEW</b> data simulasi ·
 <label>Skenario <select id="scn"><option value="normal">Normal</option><option value="err">GWT sensor error (seperti telemetry asli)</option><option value="dry">Tanah kering semua zona</option></select></label>
 <button id="rain">🌧 Toggle hujan</button>
 <span class="hint">Tombol AUTO / ▶ / Stop / ⚙ di kartu irigasi berfungsi pada simulasi ini</span></div>
<div id="host"></div>
<script>
const HTML=${esc(html)}, JS=${esc(js)};
document.getElementById('host').innerHTML=HTML;
const host=document.getElementById('host');
const now0=Date.now(), STEP=5*60000, N=288;           // 24 jam, tiap 5 menit
const rnd=(a,b)=>a+Math.random()*(b-a);
const DEV={gwt:{id:'dev-gwt',name:'nismara gwt'},flow:{id:'dev-flow',name:'Transfer Flow'},roof:{id:'dev-roof',name:'Roof Tank'},irrG:{id:'dev-g',name:'Garden Lt.1'},irrR:{id:'dev-r',name:'Garden Roof'}};
const data=[]; const ser={};
function key(dev,k){const id=dev.id+'|'+k; if(!ser[id]){ser[id]=[]; data.push({datasource:{entityId:dev.id,entityType:'DEVICE',entityName:dev.name},dataKey:{name:k},data:ser[id]});} return ser[id];}
function put(dev,k,ts,v){key(dev,k).push([ts,v]);}

/* ---- state simulasi ---- */
const S={rain:false,scn:'normal',rw:46,rwTot:12400,flowTot:48210,roof:68,pump:false,
 zones:{g1:{soil:[44,41],valve:0,auto:1,start:30,stop:55,until:0,cycles:11,run:3200,pre:'z1',dev:'irrG'},
        g2:{soil:[58,60],valve:0,auto:1,start:30,stop:55,until:0,cycles:9,run:2500,pre:'z2',dev:'irrG'},
        r1:{soil:[37,35],valve:0,auto:1,start:30,stop:55,until:0,cycles:6,run:1800,pre:'z1',dev:'irrR'}}};
const sleep=0;
function snapshot(ts,hist){
  const e=S.scn==='err';
  const t1=e?0:62+Math.sin(ts/9e5)*3, t2=e?0:60+Math.sin(ts/8e5)*3;
  put(DEV.gwt,'t1_level',ts,t1);put(DEV.gwt,'t1_vol_l',ts,t1*25);put(DEV.gwt,'t1_dist_cm',ts,e?-1:150-t1*1.3);
  put(DEV.gwt,'t2_level',ts,t2);put(DEV.gwt,'t2_vol_l',ts,t2*25);put(DEV.gwt,'t2_dist_cm',ts,e?-1:150-t2*1.3);
  put(DEV.gwt,'balance_diff',ts,Math.abs(t1-t2));put(DEV.gwt,'balance_ok',ts,true);put(DEV.gwt,'rssi',ts,S.scn==='err'?-89:-71);put(DEV.gwt,'uptime_s',ts,59937+(ts-now0)/1000);put(DEV.gwt,'heap',ts,208740);
  put(DEV.gwt,'rw_level',ts,S.rw);put(DEV.gwt,'rw_vol_l',ts,S.rw*10);put(DEV.gwt,'rw_dist_cm',ts,120-S.rw);
  const rf=S.rain?rnd(9,15):0; put(DEV.gwt,'rw_flow_lpm',ts,rf);put(DEV.gwt,'rw_total_liters',ts,S.rwTot);put(DEV.gwt,'rw_pulses_win',ts,Math.round(rf*7.5*10));
  const fl=S.pump?rnd(21,24):0; put(DEV.flow,'flow_lpm',ts,fl);put(DEV.flow,'pump_running',ts,S.pump?1:0);put(DEV.flow,'total_liters',ts,S.flowTot);put(DEV.flow,'pulses_win',ts,Math.round(fl*10));put(DEV.flow,'rssi',ts,-64);put(DEV.flow,'uptime_s',ts,120000+(ts-now0)/1000);
  put(DEV.roof,'level_pct',ts,S.roof);put(DEV.roof,'distance_cm',ts,150-S.roof);put(DEV.roof,'volume_l',ts,S.roof*90);put(DEV.roof,'pressure_bar',ts,S.pump?2.1:2.8+Math.sin(ts/3e5)*.15);
  put(DEV.roof,'pump1_status',ts,S.roof<45?1:0);put(DEV.roof,'pump2_status',ts,0);put(DEV.roof,'pump1_runtime_s',ts,5400);put(DEV.roof,'pump2_runtime_s',ts,1200);put(DEV.roof,'pump1_cycles',ts,48);put(DEV.roof,'pump2_cycles',ts,12);put(DEV.roof,'tank_count',ts,4);put(DEV.roof,'rssi',ts,-58);put(DEV.roof,'uptime_s',ts,300000+(ts-now0)/1000);
  for(const id in S.zones){const z=S.zones[id],d=DEV[z.dev],p=z.pre;
    put(d,p+'_soil1',ts,+z.soil[0].toFixed(1));put(d,p+'_soil2',ts,id==='g2'&&S.scn==='err'?-1:+z.soil[1].toFixed(1));put(d,p+'_valve',ts,z.valve);
    put(d,p+'_auto',ts,z.auto);put(d,p+'_start_pct',ts,z.start);put(d,p+'_stop_pct',ts,z.stop);
    put(d,p+'_remain_s',ts,z.until>ts?Math.round((z.until-ts)/1000):0);put(d,p+'_cycles',ts,z.cycles);put(d,p+'_runtime_s',ts,z.run);put(d,p+'_fault',ts,0);
  }
  ['irrG','irrR'].forEach(r=>{put(DEV[r],'rssi',ts,r==='irrG'?-67:-87);put(DEV[r],'in_window',ts,1);put(DEV[r],'win',ts,'05-09,16-19');put(DEV[r],'uptime_s',ts,86400+(ts-now0)/1000);put(DEV[r],'heap',ts,231000);});
}
function step(ts,dtMin){   // satu langkah simulasi
  S.rw=Math.max(5,Math.min(98,S.rw+(S.rain?0.9*dtMin/5:-0.05*dtMin/5)));
  if(S.rain){S.rwTot+=12*dtMin;}
  S.pump=S.roof<52||(S.pump&&S.roof<80); if(S.pump){S.roof+=0.7*dtMin/5;S.flowTot+=22*dtMin;} else S.roof=Math.max(20,S.roof-0.35*dtMin/5);
  for(const id in S.zones){const z=S.zones[id];
    const avg=(z.soil[0]+z.soil[1])/2;
    if(z.valve && z.until && ts>=z.until){z.valve=0;z.until=0;}
    if(z.auto && !z.until){ if(!z.valve&&avg<z.start){z.valve=1;z.cycles++;} else if(z.valve&&avg>=z.stop)z.valve=0; }
    const d=z.valve?1.6:-0.18*(S.rain&&id!=='r1'?-1.5:1)*dtMin/5; 
    z.soil=z.soil.map((v,i)=>Math.max(8,Math.min(95,v+d*dtMin/5+(i?0.02:-0.02))));
    if(z.valve)z.run+=dtMin*60;
  }
}
/* history */
{ let t=now0-N*STEP; S.rain=false; for(let i=0;i<N;i++,t+=STEP){ S.rain=(i>120&&i<150)||(i>230&&i<250); if(i%40===0){} step(t,5); snapshot(t,true); } S.rain=false; }

/* ctx + sim commands */
const ctx={$container:[host],settings:{view:'full'},data,
 attributeService:{saveEntityAttributes:(ent,scope,list)=>{
   list.forEach(a=>{const z=Object.values(S.zones).find(z=>DEV[z.dev].id===ent.id&&a.key.indexOf(z.pre+'_')===0); if(!z)return;
     const k=a.key.slice(z.pre.length+1);
     if(k==='auto'){z.auto=a.value?1:0; if(!a.value&&!z.until)z.valve=0;}
     else if(k==='start_pct')z.start=a.value; else if(k==='stop_pct')z.stop=a.value;
     else if(k==='cmd'){const[p,m]=String(a.value).split('|'); if(p==='open'){Object.values(S.zones).forEach(o=>{if(o!==z&&o.dev===z.dev){o.valve=0;o.until=0;}}); z.valve=1;z.until=Date.now()+m*60000;z.cycles++;} else {z.valve=0;z.until=0;}}
   }); tick(); return {subscribe:ok=>ok&&ok()};}}};
const self_={ctx}; new Function('self',JS)(self_); self_.onInit();
function tick(){ const ts=Date.now(); step(ts,1); snapshot(ts); self_.onDataUpdated(); }
setInterval(tick,3000); tick();
document.getElementById('rain').onclick=()=>{S.rain=!S.rain;tick();};
document.getElementById('scn').onchange=e=>{S.scn=e.target.value; if(S.scn==='dry'){Object.values(S.zones).forEach(z=>{z.soil=[24,22];z.valve=0;});} tick();};
</script></body></html>`;
fs.writeFileSync(__dirname + '/preview.html', page);
console.log('preview.html', (page.length / 1024).toFixed(0) + ' KB');
