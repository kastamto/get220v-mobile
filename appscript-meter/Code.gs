/**
 * ============================================================================
 *  SIAGA — Pencatatan Meter PLN (kWh) & PDAM (m³) per Gedung
 * ----------------------------------------------------------------------------
 *  Konsep  : seperti eCMS Electric Load Calculator
 *            gedung → daya terpasang (VA) → golongan → tarif otomatis → estimasi biaya
 *  File    : Code.gs (backend) · Index.html · Stylesheet.html · JavaScript.html
 *  Deploy  : Web App (Execute as: Me). Script harus container-bound ke Spreadsheet.
 *
 *  Sheet yang dibuat otomatis:
 *   - Gedung        : master gedung (sinkron dari eCMS + gedung baru input lokal)
 *   - Pencatatan    : pembacaan meter bulanan per gedung
 *   - TarifListrik  : tarif PLN per golongan & daya (EDITABLE — verifikasi tarif berlaku!)
 *   - TarifAir      : tarif PDAM per kelompok pelanggan, bertingkat (EDITABLE)
 * ============================================================================
 */

/* ----------------------------- KONFIGURASI ------------------------------ */
const CONFIG = {
  APP_NAME : 'SIAGA',
  TZ       : 'Asia/Jakarta',
  PF       : 0.85,   // faktor daya utk estimasi beban (load calculator)
  PPJ_PCT  : 0,      // Pajak Penerangan Jalan (%) — sesuai daerah, mis. DKI 2.4
  PPN_AIR_PCT: 0,    // PPN air (%) bila dikenakan
  PHOTO_MAX_PX: 1280,

  /* Sumber master gedung eCMS.
     Isi SPREADSHEET_ID dgn ID spreadsheet export/master eCMS (bagian antara /d/ dan /edit).
     Kosongkan bila belum ada → app memakai sheet "Gedung" lokal saja.
     Header kolom dicocokkan lewat ALIASES (tidak case-sensitive). */
  ECMS: {
    SPREADSHEET_ID: '',
    SHEET_NAME    : 'Building',
    ALIASES: {
      kode       : ['kode','code','building code','kode gedung','id gedung'],
      nama       : ['nama','name','building','building name','nama gedung','nama properti'],
      alamat     : ['alamat','address'],
      kota       : ['kota','city'],
      golongan   : ['golongan','golongan tarif','tarif','tariff group'],
      dayaVA     : ['daya','daya va','daya terpasang','daya terpasang (va)','va','installed power'],
      kelompokAir: ['kelompok air','kelompok pdam','golongan air']
    }
  },

  SHEETS: { READ:'Pencatatan', BLD:'Gedung', TL:'TarifListrik', TA:'TarifAir' },
  H: {
    READ: ['ID','BuildingID','Periode','TanggalCatat','Pencatat',
           'KWHNow','KWHPrev','KWHUsage','AirNow','AirPrev','AirUsage',
           'Foto','Lat','Lng','Catatan','UpdatedAt'],
    BLD : ['ID','Kode','Nama','Alamat','Kota','Golongan','DayaVA','KelompokAir','Sumber','UpdatedAt'],
    TL  : ['Golongan','Kode','DayaMinVA','TarifKwh','BebanPerKVA','Keterangan'],
    TA  : ['Kelompok','Blok1Maks','Blok1Tarif','Blok2Maks','Blok2Tarif','Blok3Tarif','BiayaTetap','Keterangan']
  }
};

/* Data awal tarif — CONTOH, WAJIB diverifikasi/ubah di sheet sesuai tarif berlaku. */
const SEED_TL = [
  ['Rumah Tangga','R-1/TR',  450,  415,    0,'Subsidi'],
  ['Rumah Tangga','R-1/TR',  900, 1352,    0,'RTM'],
  ['Rumah Tangga','R-1/TR', 1300, 1444.7,  0,''],
  ['Rumah Tangga','R-1/TR', 2200, 1444.7,  0,''],
  ['Rumah Tangga','R-2/TR', 3500, 1699.53, 0,''],
  ['Rumah Tangga','R-3/TR', 6600, 1699.53, 0,''],
  ['Bisnis','B-1/TR',  450, 1444.7,  0,'Contoh'],
  ['Bisnis','B-2/TR', 6600, 1444.7,  0,''],
  ['Bisnis','B-3/TM',200001,1114.74, 0,''],
  ['Industri','I-3/TM',200001,1114.74,0,''],
  ['Industri','I-4/TT',30000000,996.74,0,''],
  ['Sosial','S-2/TR', 6600, 1444.7,  0,'Contoh']
];
const SEED_TA = [
  ['Rumah Tangga', 10, 3550, 20, 4700, 6000, 0, 'Contoh — sesuaikan tarif PDAM'],
  ['Niaga Kecil' , 10, 9000, 20,12000,15000, 0, 'Contoh — sesuaikan tarif PDAM'],
  ['Niaga Besar' , 10,12500, 20,15000,18000, 0, 'Contoh — sesuaikan tarif PDAM']
];
const GOLONGAN_LIST = ['Rumah Tangga','Bisnis','Industri','Sosial'];

/* ------------------------------- ROUTING -------------------------------- */
function doGet() {
  setupAll_();
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('SIAGA · Pencatatan Meter PLN & PDAM')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover')
    .setFaviconUrl('https://ssl.gstatic.com/docs/script/images/favicon.ico');
}
function include(filename) { return HtmlService.createHtmlOutputFromFile(filename).getContent(); }

/* ------------------------------ SHEET UTIL ------------------------------ */
function ensureSheet_(key, seed) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = CONFIG.SHEETS[key], hdr = CONFIG.H[key];
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  var cur = sh.getLastRow() === 0 ? '' :
    sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].join('|');
  if (sh.getLastRow() === 0 || (sh.getLastRow() === 1 && cur !== hdr.join('|'))) {
    sh.clear();
    sh.getRange(1, 1, 1, hdr.length).setValues([hdr])
      .setFontWeight('bold').setBackground('#0f172a').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    if (seed && seed.length) sh.getRange(2, 1, seed.length, hdr.length).setValues(seed);
  }
  return sh;
}
function setupAll_() {
  ensureSheet_('READ'); ensureSheet_('BLD');
  ensureSheet_('TL', SEED_TL); ensureSheet_('TA', SEED_TA);
}
function readTable_(key) {
  var sh = ensureSheet_(key), hdr = CONFIG.H[key], last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, hdr.length).getValues().map(function (r) {
    var o = {}; hdr.forEach(function (h, i) { o[h] = r[i]; }); return o;
  }).filter(function (o) { return o[hdr[0]] !== '' && o[hdr[0]] != null; });
}
function writeTable_(key, rows) {
  var sh = ensureSheet_(key), hdr = CONFIG.H[key], last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, hdr.length).clearContent();
  if (!rows.length) return;
  sh.getRange(2, 1, rows.length, hdr.length).setValues(rows.map(function (o) {
    return hdr.map(function (h) { return o[h] !== undefined ? o[h] : ''; });
  }));
}
function withLock_(fn) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ------------------------------- HELPERS -------------------------------- */
function num_(v)    { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
function round2_(v) { return Math.round(v * 100) / 100; }
function uid_(p)    { return (p || 'M') + Utilities.getUuid().replace(/-/g, '').substring(0, 10).toUpperCase(); }
function now_()     { return Utilities.formatDate(new Date(), CONFIG.TZ, "yyyy-MM-dd'T'HH:mm:ss"); }
function blank_(v)  { return v === '' || v == null; }
function labelPeriode_(p) {
  var b = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  var s = String(p).split('-');
  return s.length === 2 ? b[parseInt(s[1], 10) - 1] + ' ' + s[0] : p;
}
function daysIn_(p) { var s = String(p).split('-'); return new Date(+s[0], +s[1], 0).getDate() || 30; }

/* ------------------------------- TARIF ---------------------------------- */
function getTarifListrik_() {
  return readTable_('TL').map(function (r) {
    return { golongan: String(r.Golongan), kode: String(r.Kode), min: num_(r.DayaMinVA),
             tarif: num_(r.TarifKwh), beban: num_(r.BebanPerKVA), ket: String(r.Keterangan || '') };
  });
}
function getTarifAir_() {
  return readTable_('TA').map(function (r) {
    return { kelompok: String(r.Kelompok), b1: num_(r.Blok1Maks), t1: num_(r.Blok1Tarif),
             b2: num_(r.Blok2Maks), t2: num_(r.Blok2Tarif), t3: num_(r.Blok3Tarif),
             tetap: num_(r.BiayaTetap), ket: String(r.Keterangan || '') };
  });
}
/** Tarif mengikuti daya terpasang: baris golongan dgn DayaMin terbesar ≤ daya. */
function findTarifListrik_(tl, golongan, va) {
  var g = String(golongan || '').toLowerCase();
  var c = tl.filter(function (t) { return t.golongan.toLowerCase() === g; });
  if (!c.length) c = tl;
  if (!c.length) return null;
  var ok = c.filter(function (t) { return t.min <= va; });
  var pool = ok.length ? ok : c;
  return pool.reduce(function (a, t) {
    return ok.length ? (t.min > a.min ? t : a) : (t.min < a.min ? t : a);
  });
}
function costElec_(b, kwh, tl) {
  var t = findTarifListrik_(tl, b.Golongan, num_(b.DayaVA));
  if (!t) return { tarif: 0, kode: '', energi: 0, beban: 0, ppj: 0, total: 0 };
  var u = Math.max(0, kwh);
  var energi = u * t.tarif, beban = (num_(b.DayaVA) / 1000) * t.beban;
  var ppj = (energi + beban) * CONFIG.PPJ_PCT / 100;
  return { tarif: t.tarif, kode: t.kode, energi: Math.round(energi), beban: Math.round(beban),
           ppj: Math.round(ppj), total: Math.round(energi + beban + ppj) };
}
function costAir_(b, m3, ta) {
  var k = String(b.KelompokAir || '').toLowerCase();
  var t = ta.filter(function (x) { return x.kelompok.toLowerCase() === k; })[0];
  if (!t) return { total: 0, ok: false };
  var u = Math.max(0, m3);
  var a = Math.min(u, t.b1) * t.t1;
  var bb = Math.max(0, Math.min(u, t.b2) - t.b1) * t.t2;
  var c = Math.max(0, u - t.b2) * t.t3;
  var sub = a + bb + c + t.tetap;
  var ppn = sub * CONFIG.PPN_AIR_PCT / 100;
  return { total: Math.round(sub + ppn), ok: true };
}

/* ------------------------------ GEDUNG ---------------------------------- */
function bldOut_(b, tl) {
  var t = findTarifListrik_(tl, b.Golongan, num_(b.DayaVA));
  return { id: b.ID, kode: b.Kode, nama: b.Nama, alamat: b.Alamat, kota: b.Kota,
           golongan: b.Golongan, dayaVA: num_(b.DayaVA), kelompokAir: b.KelompokAir,
           sumber: b.Sumber, tarifKwh: t ? t.tarif : 0, tarifKode: t ? t.kode : '',
           bebanKVA: t ? t.beban : 0 };
}
function listBuildings_() {
  var tl = getTarifListrik_();
  return readTable_('BLD').map(function (b) { return bldOut_(b, tl); })
    .sort(function (a, b) { return String(a.nama).localeCompare(String(b.nama)); });
}
function bldValidate_(d, rows, selfId) {
  var nama = String(d.nama || '').trim();
  if (!nama) throw new Error('Nama gedung wajib diisi.');
  var daya = num_(d.dayaVA);
  if (daya <= 0) throw new Error('Daya terpasang (VA) wajib diisi.');
  var kode = String(d.kode || '').trim();
  rows.forEach(function (r) {
    if (r.ID === selfId) return;
    if (String(r.Nama).toLowerCase() === nama.toLowerCase() ||
        (kode && String(r.Kode).toLowerCase() === kode.toLowerCase()))
      throw new Error('Gedung "' + nama + '" / kode tsb sudah terdaftar.');
  });
  return { nama: nama, kode: kode, daya: daya };
}
function apiAddBuilding(d) {
  return withLock_(function () {
    var rows = readTable_('BLD'), v = bldValidate_(d, rows, null), id = uid_('B');
    rows.push({ ID: id, Kode: v.kode || id, Nama: v.nama, Alamat: String(d.alamat || '').trim(),
      Kota: String(d.kota || '').trim(), Golongan: d.golongan || GOLONGAN_LIST[0],
      DayaVA: v.daya, KelompokAir: d.kelompokAir || '', Sumber: 'Lokal', UpdatedAt: now_() });
    writeTable_('BLD', rows);
    return { newId: id, buildings: listBuildings_() };
  });
}
function apiUpdateBuilding(id, d) {
  return withLock_(function () {
    var rows = readTable_('BLD'), i = rows.findIndex(function (r) { return r.ID === id; });
    if (i < 0) throw new Error('Gedung tidak ditemukan.');
    var v = bldValidate_(d, rows, id), r = rows[i];
    r.Kode = v.kode || r.Kode; r.Nama = v.nama; r.Alamat = String(d.alamat || '').trim();
    r.Kota = String(d.kota || '').trim(); r.Golongan = d.golongan || r.Golongan;
    r.DayaVA = v.daya; r.KelompokAir = d.kelompokAir || ''; r.UpdatedAt = now_();
    writeTable_('BLD', rows);
    return { newId: id, buildings: listBuildings_() };
  });
}

/** Tarik master gedung dari eCMS → merge ke sheet Gedung (kunci: Kode, fallback Nama). */
function apiSyncEcms() {
  var cfg = CONFIG.ECMS;
  if (!cfg.SPREADSHEET_ID) throw new Error('ECMS.SPREADSHEET_ID belum diisi di Code.gs.');
  return withLock_(function () {
    var src = SpreadsheetApp.openById(cfg.SPREADSHEET_ID).getSheetByName(cfg.SHEET_NAME);
    if (!src) throw new Error('Sheet "' + cfg.SHEET_NAME + '" tidak ditemukan di file eCMS.');
    var data = src.getDataRange().getValues();
    if (data.length < 2) throw new Error('Sheet eCMS kosong.');
    var head = data[0].map(function (h) { return String(h).trim().toLowerCase(); });
    var col = {};
    Object.keys(cfg.ALIASES).forEach(function (k) {
      for (var i = 0; i < head.length; i++)
        if (cfg.ALIASES[k].indexOf(head[i]) > -1) { col[k] = i; break; }
    });
    if (col.nama === undefined) throw new Error('Kolom nama gedung tidak ditemukan di sheet eCMS.');
    var g = function (r, k) { return col[k] === undefined ? '' : String(r[col[k]]).trim(); };

    var rows = readTable_('BLD'), added = 0, updated = 0;
    for (var n = 1; n < data.length; n++) {
      var r = data[n], nama = g(r, 'nama'); if (!nama) continue;
      var kode = g(r, 'kode');
      var ex = rows.filter(function (x) {
        return (kode && String(x.Kode).toLowerCase() === kode.toLowerCase()) ||
               String(x.Nama).toLowerCase() === nama.toLowerCase();
      })[0];
      var daya = num_(g(r, 'dayaVA'));
      if (ex) {   // data lokal (daya/golongan) dipertahankan bila sudah terisi
        ex.Nama = nama; if (g(r, 'alamat')) ex.Alamat = g(r, 'alamat'); if (g(r, 'kota')) ex.Kota = g(r, 'kota');
        if (blank_(ex.DayaVA) && daya) ex.DayaVA = daya;
        if (blank_(ex.Golongan) && g(r, 'golongan')) ex.Golongan = g(r, 'golongan');
        if (blank_(ex.KelompokAir) && g(r, 'kelompokAir')) ex.KelompokAir = g(r, 'kelompokAir');
        ex.UpdatedAt = now_(); updated++;
      } else {
        var id = uid_('B');
        rows.push({ ID: id, Kode: kode || id, Nama: nama, Alamat: g(r, 'alamat'), Kota: g(r, 'kota'),
          Golongan: g(r, 'golongan') || GOLONGAN_LIST[0], DayaVA: daya || '',
          KelompokAir: g(r, 'kelompokAir'), Sumber: 'eCMS', UpdatedAt: now_() });
        added++;
      }
    }
    writeTable_('BLD', rows);
    return { added: added, updated: updated, buildings: listBuildings_() };
  });
}

/* --------------------------- FOTO KE DRIVE ------------------------------ */
function getPhotoFolder_() {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('PHOTO_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  var f = DriveApp.createFolder('SIAGA Meter Foto'); props.setProperty('PHOTO_FOLDER_ID', f.getId()); return f;
}
function apiUploadPhoto(dataUrl, filename) {
  var m = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error('Format foto tidak valid.');
  var blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], filename || ('meter_' + Date.now() + '.jpg'));
  var file = getPhotoFolder_().createFile(blob);
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
  var id = file.getId();
  return { fileId: id, url: 'https://drive.google.com/file/d/' + id + '/view',
           thumb: 'https://drive.google.com/thumbnail?id=' + id + '&sz=w600' };
}
function parseFotoIds_(v) {
  if (!v) return [];
  try { var a = JSON.parse(v); if (Array.isArray(a)) return a.filter(Boolean); } catch (e) {}
  return String(v).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}
function fotoObjs_(ids) {
  return ids.map(function (id) { return { id: id,
    url: 'https://drive.google.com/file/d/' + id + '/view',
    thumb: 'https://drive.google.com/thumbnail?id=' + id + '&sz=w600' }; });
}
function normFotoIds_(f) {
  if (!Array.isArray(f)) return [];
  return f.map(function (x) { return typeof x === 'string' ? x : (x && x.id ? x.id : ''); }).filter(Boolean);
}

/* ------------------------- PERHITUNGAN PEMBACAAN ------------------------ */
/** Hitung ulang prev & usage per gedung, urut periode. */
function recomputeAll_(rows) {
  rows.sort(function (a, b) {
    return String(a.BuildingID).localeCompare(String(b.BuildingID)) ||
           String(a.Periode).localeCompare(String(b.Periode));
  });
  var prev = null;
  rows.forEach(function (r) {
    var kn = num_(r.KWHNow), an = num_(r.AirNow);
    if (!prev || prev.BuildingID !== r.BuildingID) {
      r.KWHPrev = blank_(r.KWHPrev) ? kn : num_(r.KWHPrev);
      r.AirPrev = blank_(r.AirPrev) ? an : num_(r.AirPrev);
    } else { r.KWHPrev = num_(prev.KWHNow); r.AirPrev = num_(prev.AirNow); }
    r.KWHUsage = round2_(kn - num_(r.KWHPrev));
    r.AirUsage = round2_(an - num_(r.AirPrev));
    prev = r;
  });
  return rows;
}

/** Pembacaan + info gedung + estimasi biaya & beban (load). */
function enrich_(buildingId) {
  var tl = getTarifListrik_(), ta = getTarifAir_();
  var bmap = {}; readTable_('BLD').forEach(function (b) { bmap[b.ID] = b; });
  return readTable_('READ')
    .filter(function (r) { return !buildingId || buildingId === 'ALL' || r.BuildingID === buildingId; })
    .map(function (r) {
      var b = bmap[r.BuildingID] || { Nama: '(gedung dihapus)', DayaVA: 0 };
      var kwh = num_(r.KWHUsage), air = num_(r.AirUsage), va = num_(b.DayaVA);
      var ce = costElec_(b, kwh, tl), ca = costAir_(b, air, ta);
      var capKwh = (va / 1000) * CONFIG.PF * 24 * daysIn_(r.Periode);
      return {
        id: r.ID, buildingId: r.BuildingID, gedung: b.Nama, kode: b.Kode || '', dayaVA: va,
        periode: r.Periode, periodeLabel: labelPeriode_(r.Periode),
        tanggal: r.TanggalCatat, pencatat: r.Pencatat,
        kwhNow: num_(r.KWHNow), kwhPrev: num_(r.KWHPrev), kwhUsage: kwh,
        airNow: num_(r.AirNow), airPrev: num_(r.AirPrev), airUsage: air,
        tarifKwh: ce.tarif, tarifKode: ce.kode, biayaListrik: ce.total, biayaAir: ca.total,
        capKwh: capKwh, loadPct: capKwh > 0 ? round2_(kwh / capKwh * 100) : 0,
        fotos: fotoObjs_(parseFotoIds_(r.Foto)),
        lat: blank_(r.Lat) ? null : num_(r.Lat), lng: blank_(r.Lng) ? null : num_(r.Lng),
        catatan: r.Catatan, updatedAt: r.UpdatedAt
      };
    });
}

/* --------------------------- API UNTUK CLIENT --------------------------- */
function apiBootstrap() {
  setupAll_();
  return {
    app: CONFIG.APP_NAME, tz: CONFIG.TZ, pf: CONFIG.PF, ppj: CONFIG.PPJ_PCT, ppnAir: CONFIG.PPN_AIR_PCT,
    today: Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd'),
    thisMonth: Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM'),
    ecmsEnabled: !!CONFIG.ECMS.SPREADSHEET_ID,
    golongan: GOLONGAN_LIST,
    tarifListrik: getTarifListrik_(), tarifAir: getTarifAir_(),
    buildings: listBuildings_()
  };
}

function apiGetReadings(buildingId) {
  return enrich_(buildingId).sort(function (a, b) {
    return String(b.periode).localeCompare(String(a.periode)) || String(a.gedung).localeCompare(String(b.gedung));
  });
}

function apiGetDashboard(buildingId) {
  var rows = enrich_(buildingId), by = {};
  rows.forEach(function (r) {
    var s = by[r.periode] || (by[r.periode] = { periode: r.periode, label: r.periodeLabel,
      kwh: 0, air: 0, biayaListrik: 0, biayaAir: 0, cap: 0 });
    s.kwh += r.kwhUsage; s.air += r.airUsage; s.biayaListrik += r.biayaListrik;
    s.biayaAir += r.biayaAir; s.cap += r.capKwh;
  });
  var series = Object.keys(by).sort().map(function (k) {
    var s = by[k];
    return { periode: s.periode, label: s.label, kwh: round2_(s.kwh), air: round2_(s.air),
             biayaListrik: s.biayaListrik, biayaAir: s.biayaAir,
             load: s.cap > 0 ? round2_(s.kwh / s.cap * 100) : 0 };
  });
  var n = series.length, last = n ? series[n - 1] : null, prev = n > 1 ? series[n - 2] : null;
  function avg(k) { return n ? round2_(series.reduce(function (a, x) { return a + x[k]; }, 0) / n) : 0; }
  function delta(k) { return last && prev && prev[k] ? round2_((last[k] - prev[k]) / prev[k] * 100) : null; }
  var bl = listBuildings_().filter(function (b) { return !buildingId || buildingId === 'ALL' || b.id === buildingId; });
  var dayaVA = bl.reduce(function (a, b) { return a + b.dayaVA; }, 0);
  return {
    count: n, lastPeriode: last ? last.label : '—',
    kwhLast: last ? last.kwh : 0, airLast: last ? last.air : 0,
    biayaListrikLast: last ? last.biayaListrik : 0, biayaAirLast: last ? last.biayaAir : 0,
    loadLast: last ? last.load : 0, dayaVA: dayaVA,
    kwhAvg: avg('kwh'), airAvg: avg('air'),
    kwhDelta: delta('kwh'), airDelta: delta('air'), series: series
  };
}

function apiAddReading(data) {
  return withLock_(function () {
    var periode = String(data.periode || '').trim();
    if (!/^\d{4}-\d{2}$/.test(periode)) throw new Error('Periode tidak valid. Format: YYYY-MM.');
    var bld = readTable_('BLD').filter(function (b) { return b.ID === data.buildingId; })[0];
    if (!bld) throw new Error('Pilih gedung terlebih dahulu.');
    if (!String(data.pencatat || '').trim()) throw new Error('Nama pencatat wajib diisi.');
    if (blank_(data.kwhNow)) throw new Error('Angka meter kWh wajib diisi.');
    if (blank_(data.airNow)) throw new Error('Angka meter air wajib diisi.');

    var rows = readTable_('READ');
    if (rows.some(function (r) { return r.BuildingID === bld.ID && r.Periode === periode; }))
      throw new Error(bld.Nama + ' periode ' + labelPeriode_(periode) + ' sudah tercatat. Gunakan Edit.');
    rows.push({
      ID: uid_('M'), BuildingID: bld.ID, Periode: periode,
      TanggalCatat: data.tanggal || Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd'),
      Pencatat: String(data.pencatat).trim(),
      KWHNow: num_(data.kwhNow), KWHPrev: blank_(data.kwhPrev) ? '' : num_(data.kwhPrev), KWHUsage: 0,
      AirNow: num_(data.airNow), AirPrev: blank_(data.airPrev) ? '' : num_(data.airPrev), AirUsage: 0,
      Foto: JSON.stringify(normFotoIds_(data.fotos)),
      Lat: blank_(data.lat) ? '' : num_(data.lat), Lng: blank_(data.lng) ? '' : num_(data.lng),
      Catatan: String(data.catatan || '').trim(), UpdatedAt: now_()
    });
    writeTable_('READ', recomputeAll_(rows));
    return apiGetReadings(data.buildingId);
  });
}

function apiUpdateReading(id, data) {
  return withLock_(function () {
    var rows = readTable_('READ'), i = rows.findIndex(function (r) { return r.ID === id; });
    if (i < 0) throw new Error('Data tidak ditemukan.');
    var r = rows[i], periode = String(data.periode || r.Periode).trim();
    if (!/^\d{4}-\d{2}$/.test(periode)) throw new Error('Periode tidak valid. Format: YYYY-MM.');
    if (rows.some(function (x, k) { return k !== i && x.BuildingID === r.BuildingID && x.Periode === periode; }))
      throw new Error('Periode ' + labelPeriode_(periode) + ' sudah dipakai baris lain.');
    r.Periode = periode; r.TanggalCatat = data.tanggal || r.TanggalCatat;
    r.Pencatat = String(data.pencatat || r.Pencatat).trim();
    r.KWHNow = num_(data.kwhNow); r.AirNow = num_(data.airNow);
    if (data.kwhPrev !== undefined) r.KWHPrev = blank_(data.kwhPrev) ? '' : num_(data.kwhPrev);
    if (data.airPrev !== undefined) r.AirPrev = blank_(data.airPrev) ? '' : num_(data.airPrev);
    if (data.fotos !== undefined) r.Foto = JSON.stringify(normFotoIds_(data.fotos));
    if (data.lat !== undefined) r.Lat = blank_(data.lat) ? '' : num_(data.lat);
    if (data.lng !== undefined) r.Lng = blank_(data.lng) ? '' : num_(data.lng);
    r.Catatan = String(data.catatan !== undefined ? data.catatan : r.Catatan || '').trim();
    r.UpdatedAt = now_();
    writeTable_('READ', recomputeAll_(rows));
    return apiGetReadings(data.listFilter || 'ALL');
  });
}

function apiDeleteReading(id, listFilter) {
  return withLock_(function () {
    var rows = readTable_('READ').filter(function (r) { return r.ID !== id; });
    writeTable_('READ', recomputeAll_(rows));
    return apiGetReadings(listFilter || 'ALL');
  });
}
