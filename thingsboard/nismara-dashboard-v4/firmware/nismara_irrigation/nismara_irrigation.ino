/*
 * NISMARA SMART IRRIGATION  -  ESP32  (satu sketch, dua profil device)
 * ---------------------------------------------------------------------
 *  PROFILE_GARDEN_LT1  : Garden Lt.1  -> 2 zone, 4 soil sensor, 2 solenoid (relay)
 *  PROFILE_GARDEN_ROOF : Garden Roof  -> 1 zone, 2 soil sensor, 1 solenoid (relay)
 *  (pilih SATU profil di bawah, flash ke masing-masing ESP32)
 *
 *  - Soil sensor : capacitive analog (v1.2 dsb), 2 sensor / zone, dirata-rata
 *  - Solenoid    : 12/24V via modul relay (+ dioda flyback di solenoid!)
 *  - Auto        : buka valve saat soil < start_pct, tutup saat soil >= stop_pct
 *  - Safety      : max run time, cooldown, 1 valve aktif sekaligus (Lt.1), fail-safe
 *                  tutup bila semua sensor zona gagal, valve selalu OFF saat boot
 *  - Kontrol dari dashboard via SHARED ATTRIBUTES (tanpa RPC):
 *        zN_cmd        "open|<menit>|<ts>"  atau  "close|0|<ts>"
 *        zN_auto       true/false
 *        zN_start_pct  mulai siram bila soil rata-rata < nilai ini
 *        zN_stop_pct   berhenti siram bila soil rata-rata >= nilai ini
 *
 *  Telemetry (N = 1..NZONES) -> key yang dibaca dashboard v4:
 *    zN_soil1 zN_soil2 (%, -1 = sensor error)  zN_valve (0/1)
 *    zN_auto zN_start_pct zN_stop_pct zN_remain_s zN_cycles zN_runtime_s zN_fault
 *    rssi uptime_s heap fw_version
 *    zN_fault: 0 ok | 1 semua sensor zona error | 2 valve dipaksa tutup (max run)
 *
 *  Library: PubSubClient, ArduinoJson (v7)
 *
 *  WIRING (ADC1 saja -> aman bersama WiFi)
 *    Lt.1 : soil Z1 = GPIO34,35  Z2 = GPIO32,33   relay Z1 = GPIO26  Z2 = GPIO27
 *    Roof : soil Z1 = GPIO34,35                   relay Z1 = GPIO26
 *    Sensor capacitive: VCC 3.3V, AOUT -> pin ADC.
 */
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>

/* ===================== PILIH PROFIL ===================== */
#define PROFILE_GARDEN_LT1
//#define PROFILE_GARDEN_ROOF
/* ======================================================== */

#if defined(PROFILE_GARDEN_LT1)
  #define NZONES 2
  const uint8_t SOIL_PINS[NZONES][2] = {{34, 35}, {32, 33}};
  const uint8_t RELAY_PINS[NZONES]   = {26, 27};
  #define MAX_CONCURRENT 1                 // suplai air dipakai bersama -> 1 valve sekaligus
  const char* FW_VERSION = "irr-lt1-1.0";
#elif defined(PROFILE_GARDEN_ROOF)
  #define NZONES 1
  const uint8_t SOIL_PINS[NZONES][2] = {{34, 35}};
  const uint8_t RELAY_PINS[NZONES]   = {26};
  #define MAX_CONCURRENT 1
  const char* FW_VERSION = "irr-roof-1.0";
#else
  #error "Pilih PROFILE_GARDEN_LT1 atau PROFILE_GARDEN_ROOF"
#endif

/* ===================== USER CONFIG ===================== */
const char* WIFI_SSID = "YOUR_WIFI";
const char* WIFI_PASS = "YOUR_PASS";
const char* TB_HOST   = "thingsboard.example.com";
const int   TB_PORT   = 1883;
const char* TB_TOKEN  = "DEVICE_ACCESS_TOKEN";  // token device Garden Lt.1 / Garden Roof

const bool  RELAY_ACTIVE_LOW = true;            // kebanyakan modul relay 1/2/4 channel

// Kalibrasi soil capacitive (ADC 12-bit). UKUR: sensor di udara = DRY, di air = WET.
const int   SOIL_RAW_DRY = 3200;                // <<< kalibrasi
const int   SOIL_RAW_WET = 1400;                // <<< kalibrasi

// Default (bisa di-override dari dashboard, disimpan di NVS)
const float DEF_START_PCT = 30.0;
const float DEF_STOP_PCT  = 55.0;

const uint32_t MAX_RUN_S        = 900;          // paksa tutup bila valve ON > 15 menit
const uint32_t MIN_OFF_S        = 600;          // jeda minimum antar siram (air meresap)
const uint32_t MAX_MANUAL_MIN   = 60;           // batas durasi manual open
const uint32_t SAMPLE_MS        = 2000;
const uint32_t PUBLISH_MS       = 15000;
/* ======================================================== */

struct Zone {
  bool     autoMode;
  float    startPct, stopPct;
  bool     valve;
  bool     manualRun;
  uint32_t manualUntil;       // millis
  uint32_t onSince, offSince; // millis
  uint32_t cycles, runtimeS;
  uint8_t  fault;
  float    soil[2];           // %, -1 = error
  bool     soilOk[2];
  float    avg;
  bool     avgOk;
  String   lastCmd;
};
Zone Z[NZONES];

WiFiClient   wifi;
PubSubClient mqtt(wifi);
Preferences  prefs;

uint32_t lastSample = 0, lastPub = 0, lastWifi = 0, lastMqtt = 0;
bool publishNow = false;

/* ---------------- relay / valve ---------------- */
void relayWrite(int i, bool on) {
  digitalWrite(RELAY_PINS[i], (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW);
}
int activeCount() { int n = 0; for (int i = 0; i < NZONES; i++) if (Z[i].valve) n++; return n; }

void openValve(int i) {
  if (Z[i].valve) return;
  Z[i].valve = true; Z[i].onSince = millis(); Z[i].cycles++;
  Z[i].fault = 0;
  relayWrite(i, true); publishNow = true;
  Serial.printf("[Z%d] valve OPEN\n", i + 1);
}
void closeValve(int i, uint8_t faultCode = 0) {
  if (!Z[i].valve) { if (faultCode) Z[i].fault = faultCode; return; }
  Z[i].runtimeS += (millis() - Z[i].onSince) / 1000;
  Z[i].valve = false; Z[i].offSince = millis(); Z[i].manualRun = false;
  if (faultCode) Z[i].fault = faultCode;
  relayWrite(i, false); publishNow = true;
  Serial.printf("[Z%d] valve CLOSE (fault=%u)\n", i + 1, faultCode);
}

/* ---------------- soil ---------------- */
int readRaw(uint8_t pin) {
  uint32_t s = 0;
  for (int k = 0; k < 16; k++) { s += analogRead(pin); delayMicroseconds(300); }
  return s / 16;
}
void readSoil() {
  for (int i = 0; i < NZONES; i++) {
    float sum = 0; int n = 0;
    for (int j = 0; j < 2; j++) {
      int raw = readRaw(SOIL_PINS[i][j]);
      bool ok = raw > 300 && raw < 4000;             // lepas kabel / short => di luar range
      Z[i].soilOk[j] = ok;
      if (ok) {
        float p = (SOIL_RAW_DRY - raw) * 100.0f / (SOIL_RAW_DRY - SOIL_RAW_WET);
        Z[i].soil[j] = constrain(p, 0.0f, 100.0f); sum += Z[i].soil[j]; n++;
      } else Z[i].soil[j] = -1;
    }
    Z[i].avgOk = n > 0; Z[i].avg = n ? sum / n : -1;
  }
}

/* ---------------- control logic ---------------- */
void controlLoop() {
  uint32_t now = millis();
  for (int i = 0; i < NZONES; i++) {
    Zone& z = Z[i];

    if (z.valve && !z.avgOk && !z.manualRun) closeValve(i, 1);   // fail-safe: buta => tutup
    if (!z.avgOk && z.fault == 0) { z.fault = 1; publishNow = true; }
    if (z.avgOk && z.fault == 1)  { z.fault = 0; publishNow = true; }

    if (z.manualRun) {
      if ((int32_t)(now - z.manualUntil) >= 0) closeValve(i);
    } else if (z.autoMode) {
      if (!z.valve) {
        bool cooled = (now - z.offSince) >= MIN_OFF_S * 1000UL;
        if (z.avgOk && z.avg < z.startPct && cooled && activeCount() < MAX_CONCURRENT) openValve(i);
      } else if (z.avgOk && z.avg >= z.stopPct) closeValve(i);
    }

    if (z.valve && (now - z.onSince) >= MAX_RUN_S * 1000UL && !z.manualRun) closeValve(i, 2);
  }
}

/* ---------------- persistence ---------------- */
void saveZone(int i) {
  char k[16];
  snprintf(k, sizeof(k), "z%d_auto", i + 1);  prefs.putBool(k, Z[i].autoMode);
  snprintf(k, sizeof(k), "z%d_start", i + 1); prefs.putFloat(k, Z[i].startPct);
  snprintf(k, sizeof(k), "z%d_stop", i + 1);  prefs.putFloat(k, Z[i].stopPct);
  snprintf(k, sizeof(k), "z%d_lcmd", i + 1);  prefs.putString(k, Z[i].lastCmd);
}
void loadZone(int i) {
  char k[16];
  snprintf(k, sizeof(k), "z%d_auto", i + 1);  Z[i].autoMode = prefs.getBool(k, true);
  snprintf(k, sizeof(k), "z%d_start", i + 1); Z[i].startPct = prefs.getFloat(k, DEF_START_PCT);
  snprintf(k, sizeof(k), "z%d_stop", i + 1);  Z[i].stopPct  = prefs.getFloat(k, DEF_STOP_PCT);
  snprintf(k, sizeof(k), "z%d_lcmd", i + 1);  Z[i].lastCmd  = prefs.getString(k, "");
}

/* ---------------- shared attributes from ThingsBoard ---------------- */
void applyCmd(int i, const String& cmd) {
  if (cmd == Z[i].lastCmd) return;                // jangan eksekusi ulang cmd lama (mis. setelah reboot)
  Z[i].lastCmd = cmd;
  int p1 = cmd.indexOf('|'), p2 = cmd.indexOf('|', p1 + 1);
  if (p1 < 0) return;
  String act = cmd.substring(0, p1);
  uint32_t minutes = (p2 > p1) ? cmd.substring(p1 + 1, p2).toInt() : 0;

  if (act == "open") {
    minutes = constrain(minutes, 1, MAX_MANUAL_MIN);
    if (activeCount() >= MAX_CONCURRENT && !Z[i].valve)
      for (int k = 0; k < NZONES; k++) if (k != i) closeValve(k);   // hormati batas 1 valve
    Z[i].manualRun = true; Z[i].manualUntil = millis() + minutes * 60000UL;
    openValve(i);
    publishNow = true;
  } else if (act == "close") {
    Z[i].manualRun = false; closeValve(i);
  }
  saveZone(i);
}

void applyAttrs(JsonObjectConst o) {
  char k[16];
  for (int i = 0; i < NZONES; i++) {
    bool changed = false;
    snprintf(k, sizeof(k), "z%d_auto", i + 1);
    if (o[k].is<bool>()) {
      bool a = o[k].as<bool>();
      if (a != Z[i].autoMode) { Z[i].autoMode = a; changed = true; if (!a && !Z[i].manualRun) closeValve(i); }
    }
    snprintf(k, sizeof(k), "z%d_start_pct", i + 1);
    if (o[k].is<float>()) { Z[i].startPct = constrain(o[k].as<float>(), 0.0f, 100.0f); changed = true; }
    snprintf(k, sizeof(k), "z%d_stop_pct", i + 1);
    if (o[k].is<float>()) { Z[i].stopPct = constrain(o[k].as<float>(), 0.0f, 100.0f); changed = true; }
    if (Z[i].stopPct <= Z[i].startPct) Z[i].stopPct = min(100.0f, Z[i].startPct + 5.0f);   // histeresis minimum
    if (changed) { saveZone(i); publishNow = true; }
    snprintf(k, sizeof(k), "z%d_cmd", i + 1);
    if (o[k].is<const char*>()) applyCmd(i, String(o[k].as<const char*>()));
  }
}

void onMqtt(char* topic, byte* payload, unsigned int len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) return;
  JsonObjectConst o = doc["shared"].is<JsonObjectConst>() ? doc["shared"].as<JsonObjectConst>()
                                                          : doc.as<JsonObjectConst>();
  applyAttrs(o);
}

/* ---------------- telemetry ---------------- */
void publishTelemetry() {
  if (!mqtt.connected()) return;
  JsonDocument d; char k[20]; uint32_t now = millis();
  for (int i = 0; i < NZONES; i++) {
    int n = i + 1; Zone& z = Z[i];
    snprintf(k, sizeof(k), "z%d_soil1", n);     d[k] = z.soilOk[0] ? roundf(z.soil[0] * 10) / 10 : -1;
    snprintf(k, sizeof(k), "z%d_soil2", n);     d[k] = z.soilOk[1] ? roundf(z.soil[1] * 10) / 10 : -1;
    snprintf(k, sizeof(k), "z%d_valve", n);     d[k] = z.valve ? 1 : 0;
    snprintf(k, sizeof(k), "z%d_auto", n);      d[k] = z.autoMode ? 1 : 0;
    snprintf(k, sizeof(k), "z%d_start_pct", n); d[k] = z.startPct;
    snprintf(k, sizeof(k), "z%d_stop_pct", n);  d[k] = z.stopPct;
    snprintf(k, sizeof(k), "z%d_remain_s", n);
    d[k] = (z.valve && z.manualRun) ? (int)max(0, (int)((int32_t)(z.manualUntil - now) / 1000)) : 0;
    snprintf(k, sizeof(k), "z%d_cycles", n);    d[k] = z.cycles;
    snprintf(k, sizeof(k), "z%d_runtime_s", n); d[k] = z.runtimeS + (z.valve ? (now - z.onSince) / 1000 : 0);
    snprintf(k, sizeof(k), "z%d_fault", n);     d[k] = z.fault;
  }
  d["rssi"] = WiFi.RSSI();
  d["uptime_s"] = now / 1000;
  d["heap"] = ESP.getFreeHeap();
  d["fw_version"] = FW_VERSION;
  char buf[900]; size_t n = serializeJson(d, buf, sizeof(buf));
  mqtt.publish("v1/devices/me/telemetry", (const uint8_t*)buf, n);
}

/* ---------------- network ---------------- */
void requestSharedAttrs() {
  String keys;
  for (int i = 1; i <= NZONES; i++) {
    if (i > 1) keys += ",";
    keys += "z" + String(i) + "_auto,z" + String(i) + "_start_pct,z" + String(i) + "_stop_pct";   // cmd sengaja tidak di-request
  }
  String msg = "{\"sharedKeys\":\"" + keys + "\"}";
  mqtt.publish("v1/devices/me/attributes/request/1", msg.c_str());
}

void netLoop() {
  uint32_t now = millis();
  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastWifi > 10000) { lastWifi = now; WiFi.disconnect(); WiFi.begin(WIFI_SSID, WIFI_PASS); }
    return;
  }
  if (!mqtt.connected()) {
    if (now - lastMqtt > 5000) {
      lastMqtt = now;
      String id = String("nismara-irr-") + String((uint32_t)ESP.getEfuseMac(), HEX);
      if (mqtt.connect(id.c_str(), TB_TOKEN, NULL)) {
        mqtt.subscribe("v1/devices/me/attributes");
        mqtt.subscribe("v1/devices/me/attributes/response/+");
        requestSharedAttrs();
        publishNow = true;
      }
    }
    return;
  }
  mqtt.loop();
}

/* ---------------- setup / loop ---------------- */
void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);
  prefs.begin("irr", false);
  for (int i = 0; i < NZONES; i++) {
    pinMode(RELAY_PINS[i], OUTPUT); relayWrite(i, false);      // valve OFF saat boot
    Z[i] = Zone();
    loadZone(i);
    Z[i].offSince = millis() - MIN_OFF_S * 1000UL;             // boleh langsung siram bila kering
    Z[i].soil[0] = Z[i].soil[1] = -1;
  }
  WiFi.mode(WIFI_STA); WiFi.begin(WIFI_SSID, WIFI_PASS);
  mqtt.setServer(TB_HOST, TB_PORT);
  mqtt.setBufferSize(1024);
  mqtt.setCallback(onMqtt);
  readSoil();
}

void loop() {
  netLoop();
  uint32_t now = millis();
  if (now - lastSample >= SAMPLE_MS) {
    lastSample = now;
    readSoil();
    controlLoop();
    for (int i = 0; i < NZONES; i++)
      Serial.printf("Z%d soil %.0f/%.0f avg %.0f valve %d auto %d (%.0f-%.0f)\n", i + 1,
                    Z[i].soil[0], Z[i].soil[1], Z[i].avg, Z[i].valve, Z[i].autoMode, Z[i].startPct, Z[i].stopPct);
  }
  if (publishNow || now - lastPub >= PUBLISH_MS) { publishNow = false; lastPub = now; publishTelemetry(); }
}
