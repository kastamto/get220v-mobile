/* Mock google.script.run untuk preview lokal (data contoh, tanpa backend) */
(function(){
var TL=[{golongan:'Bisnis',kode:'B-2/TR',min:6600,tarif:1444.7,beban:0,ket:''},{golongan:'Bisnis',kode:'B-1/TR',min:450,tarif:1444.7,beban:0,ket:''},{golongan:'Rumah Tangga',kode:'R-3/TR',min:6600,tarif:1699.53,beban:0,ket:''},{golongan:'Rumah Tangga',kode:'R-1/TR',min:1300,tarif:1444.7,beban:0,ket:''}];
var TA=[{kelompok:'Niaga Kecil',b1:10,t1:9000,b2:20,t2:12000,t3:15000,tetap:0,ket:''},{kelompok:'Rumah Tangga',b1:10,t1:3550,b2:20,t2:4700,t3:6000,tetap:0,ket:''}];
function tar(b){var c=TL.filter(function(t){return t.golongan===b.golongan&&t.min<=b.dayaVA;}).sort(function(a,z){return z.min-a.min;})[0]||TL[0];return c;}
var B=[
 {id:'B1',kode:'RKT-BC',nama:'Rukita Onyx Biak Cideng',alamat:'Jl. Biak',kota:'Jakarta',golongan:'Bisnis',dayaVA:23000,kelompokAir:'Niaga Kecil',sumber:'eCMS'},
 {id:'B2',kode:'RKT-KB',nama:'Rukita Kebon Jeruk',alamat:'',kota:'Jakarta',golongan:'Rumah Tangga',dayaVA:11000,kelompokAir:'Rumah Tangga',sumber:'eCMS'}
];
function fix(b){var t=tar(b);b.tarifKwh=t.tarif;b.tarifKode=t.kode;b.bebanKVA=t.beban;return b;}
B.forEach(fix);
var meter={B1:[[8200,410],[9350,432],[10620,455],[11800,470],[13210,498],[14420,515]],B2:[[3100,120],[3720,128],[4390,141],[5010,150],[5560,152],[6240,166]]};
var R=[],per=['2026-05','2026-06','2026-07','2026-08','2026-09','2026-10'],lbl=['Mei','Jun','Jul','Agu','Sep','Okt'];
Object.keys(meter).forEach(function(id){var b=B.filter(function(x){return x.id===id;})[0];
 meter[id].forEach(function(m,i){var p=i?meter[id][i-1]:m,ku=m[0]-p[0],au=m[1]-p[1];
  var cap=b.dayaVA/1000*.85*24*30,u=Math.min(au,10)*9000+Math.max(0,au-10)*12000;
  R.push({id:'R'+id+i,buildingId:id,gedung:b.nama,kode:b.kode,dayaVA:b.dayaVA,periode:per[i],periodeLabel:lbl[i]+' 2026',tanggal:per[i]+'-28',pencatat:'Ahmad Chumaidi',
   kwhNow:m[0],kwhPrev:p[0],kwhUsage:ku,airNow:m[1],airPrev:p[1],airUsage:au,tarifKwh:b.tarifKwh,tarifKode:b.tarifKode,
   biayaListrik:Math.round(ku*b.tarifKwh),biayaAir:Math.round(u),capKwh:cap,loadPct:Math.round(ku/cap*10000)/100,fotos:[],lat:i==5?-6.2:null,lng:i==5?106.8:null,catatan:i==5?'Meter listrik di belakang dapur':''});});});
function filt(id){return R.filter(function(r){return !id||id==='ALL'||r.buildingId===id;});}
var API={
 apiBootstrap:function(){return{app:'SIAGA',pf:.85,ppj:0,ppnAir:0,today:'2026-11-13',thisMonth:'2026-11',ecmsEnabled:true,golongan:['Rumah Tangga','Bisnis','Industri','Sosial'],tarifListrik:TL,tarifAir:TA,buildings:B};},
 apiGetReadings:function(id){return filt(id).sort(function(a,z){return z.periode.localeCompare(a.periode);});},
 apiGetDashboard:function(id){var by={};filt(id).forEach(function(r,i){var s=by[r.periode]||(by[r.periode]={periode:r.periode,label:r.periodeLabel.split(' ')[0],kwh:0,air:0,biayaListrik:0,biayaAir:0,cap:0});s.kwh+=r.kwhUsage;s.air+=r.airUsage;s.biayaListrik+=r.biayaListrik;s.biayaAir+=r.biayaAir;s.cap+=r.capKwh;});
  var se=Object.keys(by).sort().map(function(k){var s=by[k];s.load=Math.round(s.kwh/s.cap*10000)/100;return s;}),n=se.length,l=se[n-1],p=se[n-2];
  var av=function(k){return Math.round(se.reduce(function(a,x){return a+x[k];},0)/n*100)/100;},dl=function(k){return Math.round((l[k]-p[k])/p[k]*10000)/100;};
  var bl=B.filter(function(b){return id==='ALL'||b.id===id;});
  return{count:n,lastPeriode:l.label+' 2026',kwhLast:l.kwh,airLast:l.air,biayaListrikLast:l.biayaListrik,biayaAirLast:l.biayaAir,loadLast:l.load,dayaVA:bl.reduce(function(a,b){return a+b.dayaVA;},0),kwhAvg:av('kwh'),airAvg:av('air'),kwhDelta:dl('kwh'),airDelta:dl('air'),series:se};},
 apiAddBuilding:function(d){var b=fix({id:'B'+(B.length+1),kode:d.kode||'NEW',nama:d.nama,alamat:d.alamat,kota:d.kota,golongan:d.golongan,dayaVA:+d.dayaVA,kelompokAir:d.kelompokAir,sumber:'Lokal'});B.push(b);return{newId:b.id,buildings:B};},
 apiUpdateBuilding:function(id,d){var b=B.filter(function(x){return x.id===id;})[0];b.nama=d.nama;b.golongan=d.golongan;b.dayaVA=+d.dayaVA;b.kelompokAir=d.kelompokAir;fix(b);return{newId:id,buildings:B};},
 apiSyncEcms:function(){return{added:0,updated:2,buildings:B};}
};
window.google={script:{run:new Proxy({},{get:function(_,k){
 if(k==='withSuccessHandler')return function(ok){var h={ok:ok,fail:function(){}};var px=new Proxy({},{get:function(_,k2){
  if(k2==='withFailureHandler')return function(f){h.fail=f;return px;};
  return function(){var a=arguments;setTimeout(function(){try{if(!API[k2])throw new Error('Preview: '+k2+' tidak tersedia');h.ok(JSON.parse(JSON.stringify(API[k2].apply(null,a))));}catch(e){h.fail(e);}},120);};}});return px;};
}})}};
})();
