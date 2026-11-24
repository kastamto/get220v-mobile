// node build_schematics.js
// Menghasilkan SVG wiring + pinout untuk GWT, Garden Lt.1, Garden Roof  dan  schematics.html (galeri)
// Konsisten dengan firmware/*/config.h  — ubah di sini bila pin di config.h berubah.
const fs = require('fs');
const OUT = __dirname;

const COL = { pwr: '#dc2626', gnd: '#111827', v33: '#ea580c', trig: '#f97316', echo: '#9333ea', sda: '#2563eb', scl: '#0891b2',
  flow: '#16a34a', soil: '#0d9488', relay: '#db2777', btn: '#64748b', led: '#ca8a04' };
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const T = (x, y, s, o = {}) => `<text x="${x}" y="${y}" font-size="${o.size || 11}" fill="${o.fill || '#1f2937'}" font-weight="${o.w || 400}" text-anchor="${o.anchor || 'start'}"${o.italic ? ' font-style="italic"' : ''}>${esc(s)}</text>`;
const wrap = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="Arial,Helvetica,sans-serif"><rect width="${w}" height="${h}" fill="#fff"/>${body}</svg>`;

/* ---------- simbol ---------- */
const gndSym = (x, y, dir = 'down') => `<g stroke="#111827" stroke-width="1.6"><line x1="${x}" y1="${y}" x2="${x}" y2="${y + 6}"/><line x1="${x - 8}" y1="${y + 6}" x2="${x + 8}" y2="${y + 6}"/><line x1="${x - 5}" y1="${y + 10}" x2="${x + 5}" y2="${y + 10}"/><line x1="${x - 2}" y1="${y + 14}" x2="${x + 2}" y2="${y + 14}"/></g>`;
const dot = (x, y, c = '#111827') => `<circle cx="${x}" cy="${y}" r="3" fill="${c}"/>`;
const resistor = (x, y, w, label) => `<rect x="${x}" y="${y - 7}" width="${w}" height="14" fill="#fff" stroke="#111827" stroke-width="1.3"/>${T(x + w / 2, y - 10, label, { size: 9, anchor: 'middle', w: 700 })}`;

/* ---------- komponen ---------- */
// pins: {n: nama di komponen, k: 'p5'|'p33'|'gnd'|'sig', net: warna, esp: 'GPIO26', fn: 'TRIG', div: true}
function comp(side, x, y, w, title, sub, pins) {
  const rowH = 26, head = 40, h = head + pins.length * rowH + 6;
  const edge = side === 'L' ? x + w : x, dir = side === 'L' ? 1 : -1;
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="#f8fafc" stroke="#334155" stroke-width="1.6"/>` +
    T(x + w / 2, y + 17, title, { size: 12.5, anchor: 'middle', w: 700 }) + T(x + w / 2, y + 31, sub, { size: 9.5, anchor: 'middle', fill: '#64748b' });
  const out = [];
  pins.forEach((p, i) => {
    const py = y + head + 12 + i * rowH, sx = edge + dir * 16;
    const col = p.k === 'p5' ? COL.pwr : p.k === 'p33' ? COL.v33 : p.k === 'gnd' ? COL.gnd : COL[p.net];
    s += T(side === 'L' ? edge - 8 : edge + 8, py + 4, p.n, { size: 11, anchor: side === 'L' ? 'end' : 'start', w: 700 });
    s += `<line x1="${edge}" y1="${py}" x2="${sx}" y2="${py}" stroke="${col}" stroke-width="2"/>`;
    if (p.k === 'sig') out.push({ py, sx, col, p });
    else if (p.k === 'gnd') s += gndSym(sx, py).replace(/<line x1="(\d+)" y1="(\d+)"/, '<line x1="$1" y1="$2"');   // simbol ground (rotasi tidak perlu)
    else { s += T(sx + dir * 4, py + 4, p.k === 'p5' ? '+5V' : '+3V3', { size: 10, fill: col, w: 700, anchor: side === 'L' ? 'start' : 'end' }); }
  });
  return { svg: s, h, sig: out, side };
}

/* ---------- diagram wiring ---------- */
function wiring(cfg) {
  const W = 1060, espX = 430, espW = 200, gapY = 24;
  let yL = 80, yR = 80, body = '', sigL = [], sigR = [];
  cfg.left.forEach(c => { const r = comp('L', 30, yL, 230, c.title, c.sub, c.pins); body += r.svg; sigL.push(...r.sig); yL += r.h + gapY; });
  cfg.right.forEach(c => { const r = comp('R', 800, yR, 230, c.title, c.sub, c.pins); body += r.svg; sigR.push(...r.sig); yR += r.h + gapY; });
  const bottom = Math.max(yL, yR) - gapY, top = 70;
  // ESP32
  body += `<rect x="${espX}" y="${top}" width="${espW}" height="${bottom - top + 34}" rx="10" fill="#0f172a" stroke="#0f172a"/>` +
    T(espX + espW / 2, top + 22, 'ESP32 DevKit', { size: 14, anchor: 'middle', fill: '#fff', w: 700 }) +
    T(espX + espW / 2, top + 37, cfg.espNote || '30-pin (DOIT / ESP32-WROOM-32)', { size: 9, anchor: 'middle', fill: '#94a3b8' });
  const drawSig = (arr, side) => arr.forEach(q => {
    const y = q.py, xs = q.sx, xe = side === 'L' ? espX : espX + espW;
    const x1 = xs, x2 = xe;
    if (q.p.div) {
      const a = Math.min(x1, x2), b = Math.max(x1, x2), mid = (a + b) / 2, r1x = mid - 24, r1w = 48;
      body += `<line x1="${x1}" y1="${y}" x2="${side === 'L' ? r1x : r1x + r1w}" y2="${y}" stroke="${q.col}" stroke-width="2"/>` +
        resistor(r1x, y, r1w, '1 kΩ') +
        `<line x1="${side === 'L' ? r1x + r1w : r1x}" y1="${y}" x2="${x2}" y2="${y}" stroke="${q.col}" stroke-width="2"/>`;
      const jx = side === 'L' ? r1x + r1w + 14 : r1x - 14;
      body += dot(jx, y, q.col) + `<line x1="${jx}" y1="${y}" x2="${jx}" y2="${y + 8}" stroke="${q.col}" stroke-width="2"/>` +
        `<rect x="${jx - 7}" y="${y + 8}" width="14" height="26" fill="#fff" stroke="#111827" stroke-width="1.3"/>` + T(jx + 11, y + 25, '2 kΩ', { size: 9, w: 700 }) +
        `<line x1="${jx}" y1="${y + 34}" x2="${jx}" y2="${y + 40}" stroke="#111827" stroke-width="1.6"/>` + gndSym(jx, y + 40);
    } else body += `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${q.col}" stroke-width="2"/>`;
    const lx = side === 'L' ? x1 + 6 : x1 - 6;
    body += T(lx, y - 5, q.p.fn, { size: 9.5, fill: q.col, w: 700, anchor: side === 'L' ? 'start' : 'end' });
    body += dot(xe, y, '#fff');
    body += T(side === 'L' ? espX + 10 : espX + espW - 10, y + 4, q.p.esp, { size: 11.5, fill: '#fff', w: 700, anchor: side === 'L' ? 'start' : 'end' });
  });
  drawSig(sigL, 'L'); drawSig(sigR, 'R');
  // catatan power ESP
  body += T(espX + espW / 2, bottom + 8, 'VIN = +5V', { size: 10, anchor: 'middle', fill: '#fca5a5', w: 700 }) + T(espX + espW / 2, bottom + 22, 'GND = 0V (semua GND disatukan)', { size: 9, anchor: 'middle', fill: '#cbd5e1' });
  let y = bottom + 66;
  body = T(W / 2, 28, cfg.title, { size: 20, anchor: 'middle', w: 700 }) + T(W / 2, 48, cfg.subtitle, { size: 11.5, anchor: 'middle', fill: '#64748b' }) + body;
  // panel daya
  if (cfg.power) { const r = cfg.power(y, W); body += r.svg; y += r.h + 20; }
  // catatan
  const notes = cfg.notes || [];
  body += `<rect x="30" y="${y}" width="${W - 60}" height="${notes.length * 18 + 34}" rx="8" fill="#fffbeb" stroke="#f59e0b"/>` + T(46, y + 22, 'Catatan penting', { size: 12, w: 700, fill: '#92400e' });
  notes.forEach((n, i) => body += T(46, y + 42 + i * 18, '• ' + n, { size: 11, fill: '#78350f' }));
  y += notes.length * 18 + 54;
  return wrap(W, y, body);
}

/* ---------- panel daya ---------- */
function railPanel(y, W, spec) {
  // spec: title, rails:[{name,color}], boxes:[{name,sub,taps:[railName,...]}]
  const x0 = 60, x1 = W - 60, rowGap = 18, nR = spec.rails.length, top = y + 40;
  let s = T(30, y + 14, spec.title, { size: 13, w: 700 });
  const railY = {}; spec.rails.forEach((r, i) => { railY[r.name] = top + i * rowGap; });
  const gndY = railY['GND'];
  spec.rails.forEach(r => { s += `<line x1="${x0}" y1="${railY[r.name]}" x2="${x1}" y2="${railY[r.name]}" stroke="${r.color}" stroke-width="2.4"/>` + T(x0 - 8, railY[r.name] + 4, r.name, { size: 10, anchor: 'end', fill: r.color, w: 700 }); });
  const boxY = top + nR * rowGap + 24, bw = Math.min(150, (x1 - x0) / spec.boxes.length - 10);
  spec.boxes.forEach((b, i) => {
    const cx = x0 + (i + 0.5) * ((x1 - x0) / spec.boxes.length), bx = cx - bw / 2;
    s += `<rect x="${bx}" y="${boxY}" width="${bw}" height="44" rx="7" fill="#f8fafc" stroke="#334155" stroke-width="1.4"/>` + T(cx, boxY + 19, b.name, { size: 10.5, anchor: 'middle', w: 700 }) + T(cx, boxY + 33, b.sub || '', { size: 8.5, anchor: 'middle', fill: '#64748b' });
    b.taps.forEach((t, k) => { const tx = cx - (b.taps.length - 1) * 9 + k * 18, c = spec.rails.find(r => r.name === t).color; s += `<line x1="${tx}" y1="${railY[t]}" x2="${tx}" y2="${boxY}" stroke="${c}" stroke-width="1.8"/>` + dot(tx, railY[t], c); });
  });
  return { svg: s, h: (boxY + 44) - y };
}
function solenoidStage(y, W, zones) {
  let s = T(30, y + 14, 'Driver solenoid (12/24V) — kontak relay & dioda flyback', { size: 13, w: 700 });
  const top = y + 40, bot = y + 190, n = zones.length, step = (W - 160) / n;
  s += `<line x1="70" y1="${top}" x2="${W - 70}" y2="${top}" stroke="${COL.pwr}" stroke-width="2.6"/>` + T(62, top + 4, '+12/24V', { size: 10, anchor: 'end', fill: COL.pwr, w: 700 });
  s += `<line x1="70" y1="${bot}" x2="${W - 70}" y2="${bot}" stroke="${COL.gnd}" stroke-width="2.6"/>` + T(62, bot + 4, '0V', { size: 10, anchor: 'end', w: 700 });
  zones.forEach((z, i) => {
    const cx = 100 + i * step + step / 2;
    // relay contact
    s += `<line x1="${cx - 60}" y1="${top}" x2="${cx - 60}" y2="${top + 18}" stroke="#111827" stroke-width="2"/>` + dot(cx - 60, top);
    s += `<circle cx="${cx - 60}" cy="${top + 22}" r="3" fill="#fff" stroke="#111827" stroke-width="1.5"/>` + T(cx - 70, top + 26, 'COM', { size: 9, anchor: 'end' });
    s += `<line x1="${cx - 60}" y1="${top + 20}" x2="${cx - 44}" y2="${top + 50}" stroke="#111827" stroke-width="2"/>`;
    s += `<circle cx="${cx - 60}" cy="${top + 62}" r="3" fill="#fff" stroke="#111827" stroke-width="1.5"/>` + T(cx - 70, top + 66, 'NO', { size: 9, anchor: 'end' });
    s += `<line x1="${cx - 60}" y1="${top + 65}" x2="${cx - 60}" y2="${top + 80}" stroke="#111827" stroke-width="2"/>`;
    s += `<rect x="${cx - 92}" y="${top + 14}" width="64" height="58" rx="6" fill="none" stroke="${COL.relay}" stroke-dasharray="4 3"/>` + T(cx - 98, top + 46, z.relay, { size: 9.5, anchor: 'end', fill: COL.relay, w: 700 });
    // NO -> solenoid
    s += `<polyline points="${cx - 60},${top + 80} ${cx - 60},${top + 96} ${cx + 22},${top + 96}" fill="none" stroke="#111827" stroke-width="2"/>`;
    s += `<circle cx="${cx + 40}" cy="${top + 96}" r="18" fill="#ecfeff" stroke="#0891b2" stroke-width="2"/>` + T(cx + 40, top + 101, 'S', { size: 14, anchor: 'middle', w: 700, fill: '#0e7490' });
    s += T(cx + 40, top + 66, z.name, { size: 10.5, anchor: 'middle', w: 700 });
    s += `<line x1="${cx + 58}" y1="${top + 96}" x2="${cx + 78}" y2="${top + 96}" stroke="#111827" stroke-width="2"/><line x1="${cx + 78}" y1="${top + 96}" x2="${cx + 78}" y2="${bot}" stroke="#111827" stroke-width="2"/>` + dot(cx + 78, bot);
    // dioda flyback PARALEL solenoid: katoda (garis) ke sisi + (node NO), anoda ke 0V
    const dx = cx - 18;
    s += dot(dx, top + 96) + `<line x1="${dx}" y1="${top + 96}" x2="${dx}" y2="${top + 106}" stroke="#111827" stroke-width="1.8"/>` +
      `<line x1="${dx - 8}" y1="${top + 106}" x2="${dx + 8}" y2="${top + 106}" stroke="#111827" stroke-width="2.6"/>` +
      `<polygon points="${dx - 8},${top + 122} ${dx + 8},${top + 122} ${dx},${top + 108}" fill="#111827"/>` +
      `<line x1="${dx}" y1="${top + 122}" x2="${dx}" y2="${bot}" stroke="#111827" stroke-width="1.8"/>` + dot(dx, bot);
    s += T(dx - 12, top + 116, '1N4007', { size: 9, anchor: 'end', w: 700 }) + T(dx - 12, top + 128, 'flyback', { size: 8.5, anchor: 'end', fill: '#64748b' });
  });
  return { svg: s, h: bot + 14 - y };
}

/* ====================== DEFINISI DEVICE ====================== */
const sr04 = (name, trig, echo, t, e) => ({ title: name, sub: 'HC-SR04 ultrasonic', pins: [
  { n: 'VCC', k: 'p5' }, { n: 'TRIG', k: 'sig', net: 'trig', esp: trig, fn: 'TRIG' }, { n: 'ECHO', k: 'sig', net: 'echo', esp: echo, fn: 'ECHO', div: true }, { n: 'GND', k: 'gnd' }] });
const soil = (name, gpio, fn) => ({ title: name, sub: 'Capacitive soil moisture v1.2', pins: [
  { n: 'VCC', k: 'p33' }, { n: 'AOUT', k: 'sig', net: 'soil', esp: gpio, fn }, { n: 'GND', k: 'gnd' }] });
const btn = (name, gpio, fn) => ({ title: name, sub: 'Push button NO', pins: [{ n: '1', k: 'sig', net: 'btn', esp: gpio, fn }, { n: '2', k: 'gnd' }] });

const GWT = wiring({
  title: 'NISMARA GWT — Wiring', subtitle: 'ESP32 · LCD 16x2 I2C · 3× HC-SR04 (T1, T2, Rain tank) · Flow sensor 1" rain water',
  left: [
    { title: 'LCD 16x2 I2C', sub: 'PCF8574 · alamat 0x27 / 0x3F', pins: [{ n: 'GND', k: 'gnd' }, { n: 'VCC', k: 'p5' }, { n: 'SDA', k: 'sig', net: 'sda', esp: 'GPIO21', fn: 'SDA' }, { n: 'SCL', k: 'sig', net: 'scl', esp: 'GPIO22', fn: 'SCL' }] },
    sr04('GWT Tank 1', 'GPIO26', 'GPIO27'),
    sr04('GWT Tank 2', 'GPIO32', 'GPIO33')
  ],
  right: [
    sr04('Rain Water Tank', 'GPIO18', 'GPIO19'),
    { title: 'Flow sensor 1"', sub: 'Hall effect (YF-G1 / sejenis)', pins: [{ n: 'V+ (merah)', k: 'p5' }, { n: 'GND (hitam)', k: 'gnd' }, { n: 'SIG (kuning)', k: 'sig', net: 'flow', esp: 'GPIO4', fn: 'PULSE → interrupt' }] }
  ],
  power: (y, W) => railPanel(y, W, { title: 'Distribusi daya (satu catu 5V, GND disatukan)', rails: [{ name: '+5V', color: COL.pwr }, { name: 'GND', color: COL.gnd }],
    boxes: [{ name: 'Adaptor 5V 2A', sub: 'sumber utama', taps: ['+5V', 'GND'] }, { name: 'ESP32 VIN', sub: 'regulator onboard → 3V3', taps: ['+5V', 'GND'] },
      { name: 'HC-SR04 ×3', sub: 'VCC 5V', taps: ['+5V', 'GND'] }, { name: 'LCD I2C', sub: 'VCC 5V', taps: ['+5V', 'GND'] }, { name: 'Flow sensor', sub: 'V+ 5V (cek datasheet)', taps: ['+5V', 'GND'] }] }),
  notes: [
    'ECHO HC-SR04 mengeluarkan 5V → WAJIB pembagi tegangan 1 kΩ (seri) + 2 kΩ (ke GND) sebelum masuk GPIO ESP32 (hanya toleran 3.3V).',
    'Jarak sensor ke permukaan air minimal 20 cm (blind zone HC-SR04). dist_cm = -1 di telemetry = sensor tidak terbaca / wiring salah.',
    'Output flow sensor: jika open-collector, pull-up internal GPIO4 cukup. Jika outputnya 5V push-pull, tambahkan pembagi 1k/2k seperti ECHO.',
    'LED status memakai LED onboard GPIO2 (cepat = WiFi putus, sedang = ThingsBoard putus, lambat = normal).'
  ]
});

const irrCommon = ['Hanya pin ADC1 (GPIO32–39) dipakai untuk soil sensor — ADC2 tidak bisa dibaca saat WiFi aktif.',
  'Dioda 1N4007 dipasang PARALEL solenoid (katoda ke sisi +12/24V) untuk meredam lonjakan saat relay lepas.',
  'Modul relay active-low (umum): IN = LOW → relay ON. Atur RELAY_ACTIVE_LOW di config.h. GND logika & GND 12/24V disatukan.',
  'Tombol manual: tekan sekali = buka valve 5 menit, tekan lagi = tutup (pull-up internal ESP32).']

const LT1 = wiring({
  title: 'NISMARA Garden Lt.1 — Wiring (2 zone)', subtitle: 'ESP32 · 4× soil capacitive · modul relay 2 channel · 2× solenoid · 2 tombol manual',
  left: [soil('Z1 · Soil 1', 'GPIO34', 'ADC1'), soil('Z1 · Soil 2', 'GPIO35', 'ADC1'), soil('Z2 · Soil 1', 'GPIO32', 'ADC1'), soil('Z2 · Soil 2', 'GPIO33', 'ADC1')],
  right: [
    { title: 'Relay 2 channel', sub: 'active-low · opto-isolated', pins: [{ n: 'VCC', k: 'p5' }, { n: 'IN1', k: 'sig', net: 'relay', esp: 'GPIO26', fn: 'Solenoid Z1' }, { n: 'IN2', k: 'sig', net: 'relay', esp: 'GPIO27', fn: 'Solenoid Z2' }, { n: 'GND', k: 'gnd' }] },
    btn('Tombol manual Z1', 'GPIO13', 'ke GND'), btn('Tombol manual Z2', 'GPIO14', 'ke GND')
  ],
  power: (y, W) => {
    const a = railPanel(y, W, { title: 'Distribusi daya logika (5V)', rails: [{ name: '+5V', color: COL.pwr }, { name: '+3V3', color: COL.v33 }, { name: 'GND', color: COL.gnd }],
      boxes: [{ name: 'Buck 12/24V → 5V', sub: '2A, dari adaptor solenoid', taps: ['+5V', 'GND'] }, { name: 'ESP32', sub: 'VIN 5V · pin 3V3 keluar', taps: ['+5V', '+3V3', 'GND'] },
        { name: 'Relay module', sub: 'VCC 5V', taps: ['+5V', 'GND'] }, { name: 'Soil sensor ×4', sub: 'VCC 3V3 dari ESP32', taps: ['+3V3', 'GND'] }] });
    const b = solenoidStage(y + a.h + 24, W, [{ name: 'Solenoid Zone 1', relay: 'Relay CH1' }, { name: 'Solenoid Zone 2', relay: 'Relay CH2' }]);
    return { svg: a.svg + b.svg, h: a.h + 24 + b.h };
  },
  notes: ['Satu valve aktif sekaligus (MAX_CONCURRENT = 1) karena suplai air dipakai bersama.', ...irrCommon]
});

const ROOF = wiring({
  title: 'NISMARA Garden Roof — Wiring (1 zone)', subtitle: 'ESP32 · 2× soil capacitive · modul relay 1 channel · 1× solenoid · 1 tombol manual',
  left: [soil('Z1 · Soil 1', 'GPIO34', 'ADC1'), soil('Z1 · Soil 2', 'GPIO35', 'ADC1')],
  right: [
    { title: 'Relay 1 channel', sub: 'active-low · opto-isolated', pins: [{ n: 'VCC', k: 'p5' }, { n: 'IN', k: 'sig', net: 'relay', esp: 'GPIO26', fn: 'Solenoid Z1' }, { n: 'GND', k: 'gnd' }] },
    btn('Tombol manual Z1', 'GPIO13', 'ke GND')
  ],
  power: (y, W) => {
    const a = railPanel(y, W, { title: 'Distribusi daya logika (5V)', rails: [{ name: '+5V', color: COL.pwr }, { name: '+3V3', color: COL.v33 }, { name: 'GND', color: COL.gnd }],
      boxes: [{ name: 'Buck 12/24V → 5V', sub: '2A, dari adaptor solenoid', taps: ['+5V', 'GND'] }, { name: 'ESP32', sub: 'VIN 5V · pin 3V3 keluar', taps: ['+5V', '+3V3', 'GND'] },
        { name: 'Relay module', sub: 'VCC 5V', taps: ['+5V', 'GND'] }, { name: 'Soil sensor ×2', sub: 'VCC 3V3 dari ESP32', taps: ['+3V3', 'GND'] }] });
    const b = solenoidStage(y + a.h + 24, W, [{ name: 'Solenoid Zone 1', relay: 'Relay CH1' }]);
    return { svg: a.svg + b.svg, h: a.h + 24 + b.h };
  },
  notes: irrCommon
});

/* ====================== PINOUT BOARD ====================== */
const LEFT = ['EN', 'VP · 36', 'VN · 39', '34', '35', '32', '33', '25', '26', '27', '14', '12', '13', 'GND', 'VIN'];
const RIGHT = ['23', '22', 'TX0 · 1', 'RX0 · 3', '21', '19', '18', '5', '17 · TX2', '16 · RX2', '4', '2', '15', 'GND', '3V3'];
const gpioOf = s => { const m = s.match(/^(\d+)/) || s.match(/·\s*(\d+)/); return /^(EN|GND|VIN|3V3)$/.test(s) ? s : (m ? m[1] : s); };
function pinout(title, subtitle, used, extraNotes) {
  const W = 1000, rowH = 34, top = 120, bx = 380, bw = 240, H = top + LEFT.length * rowH + 150;
  let s = T(W / 2, 30, title, { size: 20, anchor: 'middle', w: 700 }) + T(W / 2, 50, subtitle, { size: 11.5, anchor: 'middle', fill: '#64748b' });
  s += `<rect x="${bx}" y="${top - 40}" width="${bw}" height="${LEFT.length * rowH + 80}" rx="14" fill="#0f172a"/>` +
    `<rect x="${bx + 70}" y="${top - 52}" width="100" height="26" rx="4" fill="#475569"/>` + T(bx + bw / 2, top - 34, 'antena', { size: 9, anchor: 'middle', fill: '#e2e8f0' }) +
    `<rect x="${bx + 85}" y="${top + LEFT.length * rowH + 22}" width="70" height="34" rx="4" fill="#94a3b8"/>` + T(bx + bw / 2, top + LEFT.length * rowH + 43, 'USB', { size: 11, anchor: 'middle', w: 700 }) +
    T(bx + bw / 2, top + 20, 'ESP32', { size: 22, anchor: 'middle', fill: '#e2e8f0', w: 700 }) + T(bx + bw / 2, top + 40, 'DevKit V1 · 30 pin', { size: 10, anchor: 'middle', fill: '#94a3b8' });
  const strap = new Set(['2', '12', '15']), inOnly = new Set(['34', '35', 'VP · 36', 'VN · 39']);
  function side(list, left) {
    list.forEach((lbl, i) => {
      const y = top + 14 + i * rowH, px = left ? bx : bx + bw, g = gpioOf(lbl), u = used[g] || used[lbl];
      const col = u ? u.c : '#cbd5e1';
      s += `<circle cx="${px}" cy="${y}" r="7" fill="${u ? col : '#94a3b8'}" stroke="#fff" stroke-width="1.5"/>`;
      s += T(left ? px + 14 : px - 14, y + 4, lbl, { size: 11, anchor: left ? 'start' : 'end', fill: '#e2e8f0', w: u ? 700 : 400 });
      if (u) {
        const ex = left ? bx - 40 : bx + bw + 40, tx = left ? ex - 10 : ex + 10, w = Math.max(120, u.t.length * 6.6 + 24);
        s += `<line x1="${px}" y1="${y}" x2="${ex}" y2="${y}" stroke="${col}" stroke-width="2.4"/>`;
        s += `<rect x="${left ? ex - w : ex}" y="${y - 12}" width="${w}" height="24" rx="12" fill="${col}"/>` + T(left ? ex - w / 2 : ex + w / 2, y + 4, u.t, { size: 11, anchor: 'middle', fill: '#fff', w: 700 });
      } else if (strap.has(g)) s += T(left ? px - 14 : px + 14, y + 4, '⚠ strapping', { size: 9, anchor: left ? 'end' : 'start', fill: '#b45309' });
      else if (inOnly.has(lbl)) s += T(left ? px - 14 : px + 14, y + 4, 'input only', { size: 9, anchor: left ? 'end' : 'start', fill: '#64748b' });
    });
  }
  side(LEFT, true); side(RIGHT, false);
  const ny = H - 70;
  s += `<rect x="30" y="${ny - 14}" width="${W - 60}" height="${extraNotes.length * 17 + 30}" rx="8" fill="#f1f5f9" stroke="#cbd5e1"/>` + T(46, ny + 4, 'Keterangan', { size: 12, w: 700 });
  extraNotes.forEach((n, i) => s += T(46, ny + 24 + i * 17, '• ' + n, { size: 10.5, fill: '#334155' }));
  return wrap(W, ny + extraNotes.length * 17 + 36, s);
}
const U = (t, c) => ({ t, c });
const pinNotes = ['Urutan pin antar vendor board bisa sedikit berbeda — cocokkan dengan label yang tercetak di PCB.', 'Pin ⚠ strapping (GPIO2, 12, 15) mempengaruhi boot; GPIO2 dipakai LED onboard (aman).', 'GPIO34–39 hanya input (tanpa pull-up internal) — dipakai untuk ADC soil sensor.'];
const PIN_GWT = pinout('Pin config — NISMARA GWT', 'config.h: nismara_gwt', {
  '21': U('LCD SDA', COL.sda), '22': U('LCD SCL', COL.scl), '26': U('T1 TRIG', COL.trig), '27': U('T1 ECHO (÷)', COL.echo), '32': U('T2 TRIG', COL.trig), '33': U('T2 ECHO (÷)', COL.echo),
  '18': U('RAIN TRIG', COL.trig), '19': U('RAIN ECHO (÷)', COL.echo), '4': U('FLOW sensor', COL.flow), '2': U('LED status', COL.led), VIN: U('+5V masuk', COL.pwr), GND: U('GND', COL.gnd), '3V3': U('3V3 (tidak dipakai)', '#94a3b8')
}, ['(÷) = lewat pembagi tegangan 1 kΩ / 2 kΩ.', ...pinNotes]);
const PIN_LT1 = pinout('Pin config — NISMARA Garden Lt.1', 'config.h: PROFILE_GARDEN_LT1', {
  '34': U('Z1 Soil 1', COL.soil), '35': U('Z1 Soil 2', COL.soil), '32': U('Z2 Soil 1', COL.soil), '33': U('Z2 Soil 2', COL.soil), '26': U('Relay Z1', COL.relay), '27': U('Relay Z2', COL.relay),
  '13': U('Tombol Z1', COL.btn), '14': U('Tombol Z2', COL.btn), '2': U('LED status', COL.led), VIN: U('+5V masuk', COL.pwr), '3V3': U('3V3 → soil sensor', COL.v33), GND: U('GND', COL.gnd)
}, pinNotes);
const PIN_ROOF = pinout('Pin config — NISMARA Garden Roof', 'config.h: PROFILE_GARDEN_ROOF', {
  '34': U('Z1 Soil 1', COL.soil), '35': U('Z1 Soil 2', COL.soil), '26': U('Relay Z1', COL.relay), '13': U('Tombol Z1', COL.btn), '2': U('LED status', COL.led),
  VIN: U('+5V masuk', COL.pwr), '3V3': U('3V3 → soil sensor', COL.v33), GND: U('GND', COL.gnd)
}, pinNotes);

const files = { gwt_wiring: GWT, gwt_pinout: PIN_GWT, irrigation_lt1_wiring: LT1, irrigation_lt1_pinout: PIN_LT1, irrigation_roof_wiring: ROOF, irrigation_roof_pinout: PIN_ROOF };
Object.entries(files).forEach(([n, svg]) => fs.writeFileSync(`${OUT}/${n}.svg`, svg));
const sections = [['NISMARA GWT', 'gwt'], ['Garden Lt.1 (2 zone)', 'irrigation_lt1'], ['Garden Roof (1 zone)', 'irrigation_roof']];
const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NISMARA — Schematic & Pin Config</title>
<style>body{margin:0;background:#e2e8f0;font-family:Arial,Helvetica,sans-serif;color:#0f172a}header{padding:18px 24px;background:#0f172a;color:#fff;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
header h1{font-size:18px;margin:0}nav{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto}nav a,nav button{padding:7px 14px;border-radius:999px;background:#1e293b;color:#e2e8f0;text-decoration:none;font-size:12px;font-weight:700;border:0;cursor:pointer}
section{max-width:1100px;margin:24px auto;padding:0 16px}h2{font-size:15px;margin:0 0 8px}.card{background:#fff;border-radius:12px;box-shadow:0 8px 24px -16px rgba(0,0,0,.4);padding:10px;margin-bottom:18px;overflow-x:auto}
.card svg{width:100%;height:auto;display:block}@media print{header nav{display:none}body{background:#fff}.card{box-shadow:none;break-inside:avoid}}</style></head><body>
<header><h1>⚡ NISMARA — Schematic & Pin Config</h1><nav>${sections.map(s => `<a href="#${s[1]}">${s[0]}</a>`).join('')}<button onclick="window.print()">🖨 Print / PDF</button></nav></header>
${sections.map(s => `<section id="${s[1]}"><h2>${s[0]} — wiring</h2><div class="card">${files[s[1] + '_wiring']}</div><h2>${s[0]} — pin config</h2><div class="card">${files[s[1] + '_pinout']}</div></section>`).join('')}
</body></html>`;
fs.writeFileSync(`${OUT}/schematics.html`, html);
console.log('OK', Object.keys(files).length, 'svg + schematics.html');
