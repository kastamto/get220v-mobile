/*
 * NISMARA GWT  -  ESP32 + LCD 16x2 I2C + 3x HC-SR04 + flow sensor 1 inch
 * ---------------------------------------------------------------------
 *  T1, T2 : tangki GWT (HC-SR04)
 *  RW     : tangki rain water collection (HC-SR04)
 *  FLOW   : flow sensor 1" pada jalur rain water (pulse / hall effect)
 *
 * Telemetry (ThingsBoard MQTT, v1/devices/me/telemetry):
 *   t1_level t1_vol_l t1_dist_cm   t2_level t2_vol_l t2_dist_cm
 *   balance_diff balance_ok
 *   rw_level rw_vol_l rw_dist_cm rw_flow_lpm rw_total_liters rw_pulses_win
 *   rssi uptime_s heap
 *
 * Sensor gagal baca => dist_cm = -1, level = 0, vol = 0
 * (dashboard v4 menampilkan "ERR", bukan 0%).
 *
 * Library: PubSubClient, LiquidCrystal_I2C (Frank de Brabander)
 *
 * WIRING
 *   LCD I2C   : SDA=21 SCL=22 (addr 0x27 / 0x3F)
 *   HC-SR04   : VCC=5V. ECHO WAJIB lewat pembagi tegangan (1k + 2k) ke 3.3V!
 *     T1  TRIG=26 ECHO=27
 *     T2  TRIG=32 ECHO=33
 *     RW  TRIG=18 ECHO=19
 *   FLOW      : sinyal -> GPIO4 (pull-up internal; kalau output sensor 5V pakai pembagi)
 */
#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <Preferences.h>

/* ===================== USER CONFIG ===================== */
const char* WIFI_SSID = "YOUR_WIFI";
const char* WIFI_PASS = "YOUR_PASS";
const char* TB_HOST   = "thingsboard.example.com";
const int   TB_PORT   = 1883;
const char* TB_TOKEN  = "DEVICE_ACCESS_TOKEN";   // access token device "nismara gwt"

#define LCD_ADDR 0x27

// Geometri tangki (cm). EMPTY = jarak sensor ke dasar saat kosong,
// FULL = jarak sensor ke permukaan saat penuh (>= blind zone HC-SR04 ~ 20 cm).
struct TankCfg { uint8_t trig, echo; float emptyCm, fullCm, capacityL; };
TankCfg T1 = {26, 27, 150.0, 20.0, 2500.0};   // <<< sesuaikan
TankCfg T2 = {32, 33, 150.0, 20.0, 2500.0};   // <<< sesuaikan
TankCfg RW = {18, 19, 120.0, 20.0, 1000.0};   // <<< sesuaikan (samakan dgn rwCapacityL di dashboard)

const float BALANCE_WARN_PCT = 10.0;          // selisih T1-T2 > ini => balance_ok=false

// Flow 1": Q(L/min) = freq(Hz) / FLOW_K.  YF-G1 ~ 7.2-7.5; KALIBRASI dengan ember ukur.
const uint8_t FLOW_PIN = 4;
const float   FLOW_K   = 7.5;

const uint32_t PUBLISH_MS = 10000;            // interval kirim telemetry
const uint32_t SAMPLE_MS  = 2000;             // interval baca sensor / LCD
/* ======================================================= */

WiFiClient   wifi;
PubSubClient mqtt(wifi);
LiquidCrystal_I2C lcd(LCD_ADDR, 16, 2);
Preferences  prefs;

volatile uint32_t flowPulses = 0;
void IRAM_ATTR onFlowPulse() { flowPulses++; }

struct Reading { float dist, level, vol; bool ok; };
Reading r1, r2, rw;
float flowLpm = 0, totalL = 0;
uint32_t pulsesWin = 0;
uint32_t lastFlowMs = 0, lastSampleMs = 0, lastPubMs = 0, lastSaveMs = 0;
uint32_t lastWifiTry = 0, lastMqttTry = 0;
float savedTotalL = 0;
uint8_t lcdPage = 0;

/* ---------------- ultrasonic ---------------- */
float readDistOnce(const TankCfg& t) {
  digitalWrite(t.trig, LOW);  delayMicroseconds(3);
  digitalWrite(t.trig, HIGH); delayMicroseconds(10);
  digitalWrite(t.trig, LOW);
  unsigned long us = pulseIn(t.echo, HIGH, 30000UL);   // timeout 30 ms (~5 m)
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
  if (n < 3) return r;                                 // terlalu banyak gagal => ERR
  for (int i = 1; i < n; i++) {                        // insertion sort -> median
    float v = s[i]; int j = i - 1;
    while (j >= 0 && s[j] > v) { s[j + 1] = s[j]; j--; }
    s[j + 1] = v;
  }
  float d = s[n / 2];
  float lvl = (t.emptyCm - d) / (t.emptyCm - t.fullCm) * 100.0f;
  lvl = constrain(lvl, 0.0f, 100.0f);
  r.dist = d; r.level = lvl; r.vol = lvl / 100.0f * t.capacityL; r.ok = true;
  return r;
}

/* ---------------- flow ---------------- */
void updateFlow() {
  uint32_t now = millis();
  uint32_t dt = now - lastFlowMs;
  if (dt < 1000) return;
  noInterrupts(); uint32_t p = flowPulses; flowPulses = 0; interrupts();
  lastFlowMs = now;
  float hz = p * 1000.0f / dt;
  flowLpm = hz / FLOW_K;
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
      mqtt.connect(("nismara-gwt-" + String((uint32_t)ESP.getEfuseMac(), HEX)).c_str(), TB_TOKEN, NULL);
    }
    return;
  }
  mqtt.loop();
}

void publishTelemetry() {
  if (!mqtt.connected()) return;
  bool bothOk = r1.ok && r2.ok;
  float diff = bothOk ? fabsf(r1.level - r2.level) : 0;
  bool balOk = bothOk ? (diff <= BALANCE_WARN_PCT) : true;   // sensor error ditangani dashboard

  char buf[640];
  snprintf(buf, sizeof(buf),
    "{\"t1_level\":%.1f,\"t1_vol_l\":%.0f,\"t1_dist_cm\":%.1f,"
    "\"t2_level\":%.1f,\"t2_vol_l\":%.0f,\"t2_dist_cm\":%.1f,"
    "\"balance_diff\":%.1f,\"balance_ok\":%s,"
    "\"rw_level\":%.1f,\"rw_vol_l\":%.0f,\"rw_dist_cm\":%.1f,"
    "\"rw_flow_lpm\":%.2f,\"rw_total_liters\":%.1f,\"rw_pulses_win\":%lu,"
    "\"rssi\":%d,\"uptime_s\":%lu,\"heap\":%u}",
    r1.level, r1.vol, r1.dist, r2.level, r2.vol, r2.dist,
    diff, balOk ? "true" : "false",
    rw.level, rw.vol, rw.dist, flowLpm, totalL, (unsigned long)pulsesWin,
    WiFi.RSSI(), (unsigned long)(millis() / 1000), (unsigned)ESP.getFreeHeap());
  mqtt.publish("v1/devices/me/telemetry", buf);
  pulsesWin = 0;
}

/* ---------------- LCD ---------------- */
void lcdLine(uint8_t row, const String& s) {
  String t = s; while (t.length() < 16) t += ' ';
  lcd.setCursor(0, row); lcd.print(t.substring(0, 16));
}
String pct(const Reading& r) { return r.ok ? String(r.level, 0) + "%" : "ERR"; }

void drawLcd() {
  switch (lcdPage % 3) {
    case 0: lcdLine(0, "GWT1:" + pct(r1) + " GWT2:" + pct(r2));
            lcdLine(1, String("Rain:") + pct(rw) + (flowLpm > 0.5 ? " FLOW" : " idle")); break;
    case 1: lcdLine(0, "Rain " + String(flowLpm, 1) + " L/min");
            lcdLine(1, "Tot " + String(totalL, 0) + " L"); break;
    case 2: lcdLine(0, WiFi.status() == WL_CONNECTED ? "WiFi " + String(WiFi.RSSI()) + "dBm" : "WiFi: --");
            lcdLine(1, mqtt.connected() ? "TB: connected" : "TB: offline"); break;
  }
}

/* ---------------- setup / loop ---------------- */
void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  lcd.init(); lcd.backlight(); lcdLine(0, "NISMARA GWT"); lcdLine(1, "booting...");

  TankCfg* ts[] = {&T1, &T2, &RW};
  for (auto t : ts) { pinMode(t->trig, OUTPUT); pinMode(t->echo, INPUT); }
  pinMode(FLOW_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(FLOW_PIN), onFlowPulse, FALLING);

  prefs.begin("gwt", false);
  totalL = savedTotalL = prefs.getFloat("rw_total", 0);   // totalizer tahan reboot

  WiFi.mode(WIFI_STA); WiFi.begin(WIFI_SSID, WIFI_PASS);
  mqtt.setServer(TB_HOST, TB_PORT);
  lastFlowMs = millis();
}

void loop() {
  netLoop();
  updateFlow();
  uint32_t now = millis();

  if (now - lastSampleMs >= SAMPLE_MS) {
    lastSampleMs = now;
    r1 = readTank(T1); r2 = readTank(T2); rw = readTank(RW);
    lcdPage++; drawLcd();
    Serial.printf("T1 %.1f/%.1f T2 %.1f/%.1f RW %.1f/%.1f flow %.2f tot %.1f\n",
                  r1.dist, r1.level, r2.dist, r2.level, rw.dist, rw.level, flowLpm, totalL);
  }
  if (now - lastPubMs >= PUBLISH_MS) { lastPubMs = now; publishTelemetry(); }
  if (now - lastSaveMs >= 60000) {                          // simpan max 1x/menit (hemat flash)
    lastSaveMs = now;
    if (totalL - savedTotalL >= 1.0f) { prefs.putFloat("rw_total", totalL); savedTotalL = totalL; }
  }
}
