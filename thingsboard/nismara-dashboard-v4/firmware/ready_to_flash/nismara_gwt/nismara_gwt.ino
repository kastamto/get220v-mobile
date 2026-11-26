// ====================================================================
// FILE HASIL GENERATE (make_ready_to_flash.py) — jangan diedit tangan.
// Sumber: firmware/nismara_gwt/   Device: GWT
// ====================================================================
/*
 * NISMARA GWT  -  ESP32 + LCD 20x4 I2C + 3x HC-SR04 + flow sensor 1 inch
 * ---------------------------------------------------------------------
 *  T1, T2 : tangki GWT        RW : tangki rain water        FLOW : flow 1" rain water
 *  Semua pin/kalibrasi/WiFi/token -> config.h
 *
 *  Telemetry (v1/devices/me/telemetry):
 *    t1_level t1_vol_l t1_dist_cm  t2_level t2_vol_l t2_dist_cm  balance_diff balance_ok
 *    rw_level rw_vol_l rw_dist_cm rw_flow_lpm rw_total_liters rw_pulses_win
 *    rssi uptime_s heap fw_version
 *  Sensor gagal baca => dist_cm = -1, level = 0 (dashboard menampilkan "ERR").
 *
 *  Library: PubSubClient, LiquidCrystal_I2C (Frank de Brabander)
 */
#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <Preferences.h>
#include <esp_task_wdt.h>
#include "config.h"

// CATATAN: semua tipe harus didefinisikan di sini, SEBELUM fungsi pertama (aturan prototipe otomatis Arduino IDE).
struct TankCfg { uint8_t trig, echo; float emptyCm, fullCm, capacityL; };
struct Reading { float dist, level, vol; bool ok; };
// Jangan memakai nama T1/T2: bentrok dengan konstanta pin touch bawaan board ESP32 (pins_arduino.h).
const TankCfg TANK_T1 = {PIN_T1_TRIG, PIN_T1_ECHO, T1_EMPTY_CM, T1_FULL_CM, T1_CAP_L};
const TankCfg TANK_T2 = {PIN_T2_TRIG, PIN_T2_ECHO, T2_EMPTY_CM, T2_FULL_CM, T2_CAP_L};
const TankCfg TANK_RW = {PIN_RW_TRIG, PIN_RW_ECHO, RW_EMPTY_CM, RW_FULL_CM, RW_CAP_L};

WiFiClient   wifi;
PubSubClient mqtt(wifi);
LiquidCrystal_I2C lcd(LCD_ADDR, LCD_COLS, LCD_ROWS);
Preferences  prefs;

volatile uint32_t flowPulses = 0;
void IRAM_ATTR onFlowPulse() { flowPulses++; }

Reading r1, r2, rw;
float flowLpm = 0, totalL = 0, savedTotalL = 0;
uint32_t pulsesWin = 0;
uint32_t lastFlowMs = 0, lastSampleMs = 0, lastPubMs = 0, lastSaveMs = 0, lastWifiTry = 0, lastMqttTry = 0, lastLedMs = 0;

/* ---------------- watchdog ---------------- */
void wdtInit() {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t c = {};
  c.timeout_ms = WDT_SECONDS * 1000; c.idle_core_mask = 0; c.trigger_panic = true;
  esp_task_wdt_reconfigure(&c);
#else
  esp_task_wdt_init(WDT_SECONDS, true);
#endif
  esp_task_wdt_add(NULL);
}

/* ---------------- ultrasonic ---------------- */
float readDistOnce(const TankCfg& t) {
  digitalWrite(t.trig, LOW);  delayMicroseconds(3);
  digitalWrite(t.trig, HIGH); delayMicroseconds(10);
  digitalWrite(t.trig, LOW);
  unsigned long us = pulseIn(t.echo, HIGH, 30000UL);
  if (us == 0) return -1;
  return us * 0.0343f / 2.0f;
}
Reading readTank(const TankCfg& t) {
  float s[5]; int n = 0;
  for (int i = 0; i < 5; i++) {
    float d = readDistOnce(t);
    if (d >= 2.0f && d <= 400.0f) s[n++] = d;
    delay(30);
  }
  Reading r = {-1, 0, 0, false};
  if (n < 3) return r;
  for (int i = 1; i < n; i++) { float v = s[i]; int j = i - 1; while (j >= 0 && s[j] > v) { s[j + 1] = s[j]; j--; } s[j + 1] = v; }
  float d = s[n / 2];
  float lvl = constrain((t.emptyCm - d) / (t.emptyCm - t.fullCm) * 100.0f, 0.0f, 100.0f);
  r.dist = d; r.level = lvl; r.vol = lvl / 100.0f * t.capacityL; r.ok = true;
  return r;
}

/* ---------------- flow ---------------- */
void updateFlow() {
  uint32_t now = millis(), dt = now - lastFlowMs;
  if (dt < 1000) return;
  noInterrupts(); uint32_t p = flowPulses; flowPulses = 0; interrupts();
  lastFlowMs = now;
  flowLpm = (p * 1000.0f / dt) / FLOW_K;
  totalL += flowLpm * (dt / 60000.0f);
  pulsesWin += p;
}

/* ---------------- network ---------------- */
void netLoop() {
  uint32_t now = millis();
  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastWifiTry > 10000) { lastWifiTry = now; WiFi.disconnect(); WiFi.begin(WIFI_SSID, WIFI_PASS); }
    return;
  }
  if (!mqtt.connected()) {
    if (now - lastMqttTry > 5000) {
      lastMqttTry = now;
      String id = String("nismara-gwt-") + String((uint32_t)ESP.getEfuseMac(), HEX);
      mqtt.connect(id.c_str(), TB_TOKEN, NULL);
    }
    return;
  }
  mqtt.loop();
}

void publishTelemetry() {
  if (!mqtt.connected()) return;
  bool bothOk = r1.ok && r2.ok;
  float diff = bothOk ? fabsf(r1.level - r2.level) : 0;
  bool balOk = bothOk ? (diff <= BALANCE_WARN_PCT) : true;     // sensor error ditangani dashboard
  char buf[700];
  snprintf(buf, sizeof(buf),
    "{\"t1_level\":%.1f,\"t1_vol_l\":%.0f,\"t1_dist_cm\":%.1f,"
    "\"t2_level\":%.1f,\"t2_vol_l\":%.0f,\"t2_dist_cm\":%.1f,"
    "\"balance_diff\":%.1f,\"balance_ok\":%s,"
    "\"rw_level\":%.1f,\"rw_vol_l\":%.0f,\"rw_dist_cm\":%.1f,"
    "\"rw_flow_lpm\":%.2f,\"rw_total_liters\":%.1f,\"rw_pulses_win\":%lu,"
    "\"rssi\":%d,\"uptime_s\":%lu,\"heap\":%u,\"fw_version\":\"%s\"}",
    r1.level, r1.vol, r1.dist, r2.level, r2.vol, r2.dist, diff, balOk ? "true" : "false",
    rw.level, rw.vol, rw.dist, flowLpm, totalL, (unsigned long)pulsesWin,
    WiFi.RSSI(), (unsigned long)(millis() / 1000), (unsigned)ESP.getFreeHeap(), FW_VERSION);
  mqtt.publish("v1/devices/me/telemetry", buf);
  pulsesWin = 0;
}

/* ---------------- LCD 20x4 ----------------
 *  L0: T1:62% T2:58% B:OK            (B = balance; ERR bila sensor ultrasonik tidak terbaca)
 *  L1: G:2.92kL R:780L               (volume GWT total & tangki hujan)
 *  L2: Rain:78% 11.0L/m              (level & flow tangki hujan)
 *  L3: WiFi-71 TB:OK Up 16h          <-> tiap 4 dtk bergantian: Rain total: 2.38 m3
 */
void lcdLine(uint8_t row, const char* s) {
  char b[LCD_COLS + 1]; snprintf(b, sizeof(b), "%-*s", LCD_COLS, s);          // pad spasi & potong di LCD_COLS
  lcd.setCursor(0, row); lcd.print(b);
}
void pctStr(const Reading& r, char* o, size_t n) { if (r.ok) snprintf(o, n, "%.0f%%", r.level); else snprintf(o, n, "ERR"); }
void volStr(float l, char* o, size_t n) { if (l >= 1000) snprintf(o, n, "%.2fkL", l / 1000.0f); else snprintf(o, n, "%.0fL", l); }
void upStr(uint32_t s, char* o, size_t n) { if (s >= 86400UL) snprintf(o, n, "%lud", (unsigned long)(s / 86400UL)); else if (s >= 3600UL) snprintf(o, n, "%luh", (unsigned long)(s / 3600UL)); else snprintf(o, n, "%lum", (unsigned long)(s / 60UL)); }

void drawLcd() {
  char a[8], b[8], c[8], v1[12], v2[12], up[8], l[48];
  pctStr(r1, a, sizeof a); pctStr(r2, b, sizeof b); pctStr(rw, c, sizeof c);
  bool bothOk = r1.ok && r2.ok;
  const char* bal = !bothOk ? "ERR" : (fabsf(r1.level - r2.level) <= BALANCE_WARN_PCT ? "OK" : "!!");
  snprintf(l, sizeof l, "T1:%s T2:%s B:%s", a, b, bal); lcdLine(0, l);

  float gwtVol = (r1.ok ? r1.vol : 0) + (r2.ok ? r2.vol : 0);
  if (r1.ok || r2.ok) volStr(gwtVol, v1, sizeof v1); else snprintf(v1, sizeof v1, "--");
  if (rw.ok) volStr(rw.vol, v2, sizeof v2); else snprintf(v2, sizeof v2, "--");
  snprintf(l, sizeof l, "G:%s R:%s", v1, v2); lcdLine(1, l);

  snprintf(l, sizeof l, "Rain:%s %.1fL/m", c, flowLpm); lcdLine(2, l);

  if (((millis() / 4000UL) & 1) == 0) {
    upStr(millis() / 1000UL, up, sizeof up);
    if (WiFi.status() == WL_CONNECTED) snprintf(l, sizeof l, "WiFi%d TB:%s Up %s", WiFi.RSSI(), mqtt.connected() ? "OK" : "--", up);
    else snprintf(l, sizeof l, "WiFi:-- TB:-- Up %s", up);
  } else {
    if (totalL >= 1000) snprintf(l, sizeof l, "Rain total: %.2f m3", totalL / 1000.0f); else snprintf(l, sizeof l, "Rain total: %.0f L", totalL);
  }
  lcdLine(3, l);
}

/* status LED: cepat = WiFi putus, kedip lambat = TB putus, nyala sebentar = OK */
void ledLoop() {
  uint32_t now = millis();
  uint32_t period = WiFi.status() != WL_CONNECTED ? 200 : (!mqtt.connected() ? 600 : 2000);
  if (now - lastLedMs >= period) { lastLedMs = now; digitalWrite(PIN_STATUS_LED, !digitalRead(PIN_STATUS_LED)); }
}

/* ---------------- setup / loop ---------------- */
void setup() {
  Serial.begin(115200);
  pinMode(PIN_STATUS_LED, OUTPUT);
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  lcd.init(); lcd.backlight(); lcdLine(0, "NISMARA GWT"); lcdLine(1, FW_VERSION); lcdLine(2, "LCD 20x4 I2C"); lcdLine(3, "booting...");

  const TankCfg* ts[] = {&TANK_T1, &TANK_T2, &TANK_RW};
  for (auto t : ts) { pinMode(t->trig, OUTPUT); pinMode(t->echo, INPUT); }
  pinMode(PIN_FLOW, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PIN_FLOW), onFlowPulse, FALLING);

  prefs.begin("gwt", false);
  totalL = savedTotalL = prefs.getFloat("rw_total", 0);        // totalizer tahan reboot

  WiFi.mode(WIFI_STA); WiFi.begin(WIFI_SSID, WIFI_PASS);
  mqtt.setServer(TB_HOST, TB_PORT);
  lastFlowMs = millis();
  wdtInit();
}

void loop() {
  esp_task_wdt_reset();
  netLoop(); updateFlow(); ledLoop();
  uint32_t now = millis();
  if (now - lastSampleMs >= SAMPLE_MS) {
    lastSampleMs = now;
    r1 = readTank(TANK_T1); r2 = readTank(TANK_T2); rw = readTank(TANK_RW);
    drawLcd();
    Serial.printf("T1 %.1f/%.1f T2 %.1f/%.1f RW %.1f/%.1f flow %.2f tot %.1f\n", r1.dist, r1.level, r2.dist, r2.level, rw.dist, rw.level, flowLpm, totalL);
  }
  if (now - lastPubMs >= PUBLISH_MS) { lastPubMs = now; publishTelemetry(); }
  if (now - lastSaveMs >= 60000UL) {                            // simpan max 1x/menit (hemat flash)
    lastSaveMs = now;
    if (totalL - savedTotalL >= 1.0f) { prefs.putFloat("rw_total", totalL); savedTotalL = totalL; }
  }
}
