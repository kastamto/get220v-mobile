/*
 * NISMARA SMART IRRIGATION  -  ESP32  (satu sketch, dua profil device)
 * ---------------------------------------------------------------------
 *  Profil, pin, kalibrasi, jadwal & keselamatan -> config.h
 *
 *  Auto   : buka valve saat soil < start_pct, tutup saat >= stop_pct (histeresis)
 *  Jadwal : auto hanya MULAI dalam jendela waktu (NTP), opsional
 *  Safety : valve OFF saat boot, max run, cooldown, 1 valve sekaligus (Lt.1),
 *           tutup bila semua sensor zona error, watchdog
 *  Manual : tombol fisik per zona + perintah dashboard
 *
 *  KONTROL RELAY / VALVE via RPC (server-side RPC ThingsBoard, request/response):
 *     setValve   {"zone":1,"state":true,"minutes":10}   ON (maks MAX_MANUAL_MIN) / {"zone":1,"state":false} OFF
 *     setValveN  params true|false  (N = nomor zona, mis. setValve2)   -> cocok utk widget "Switch control"
 *     getValveN  -> true|false                                          -> pasangan setValveN
 *     setRelay / getRelay = alias setValve / getValve
 *     setAuto    {"zone":1,"auto":true}
 *     setThresholds {"zone":1,"start":30,"stop":55}
 *     getState   {"zone":1} (tanpa zone = semua zona)
 *     closeAll
 *  RPC ON tanpa "minutes" = RPC_DEFAULT_MIN menit. Valve tidak pernah menyala tanpa batas waktu.
 *
 *  Kontrol dashboard = SHARED ATTRIBUTES:
 *     zN_cmd "open|<menit>|<ts>" / "close|0|<ts>"   zN_auto true/false
 *     zN_start_pct   zN_stop_pct
 *
 *  Telemetry (N=1..NZONES):
 *     zN_soil1 zN_soil2 (%, -1 = error)  zN_valve  zN_auto  zN_start_pct  zN_stop_pct
 *     zN_remain_s zN_cycles zN_runtime_s zN_fault(0 ok|1 sensor|2 max-run)
 *     rssi uptime_s heap fw_version in_window time_ok win
 *
 *  Library: PubSubClient, ArduinoJson (v7)
 */
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <time.h>
#include <esp_task_wdt.h>
#include "config.h"

const uint8_t SOIL_PINS[NZONES][2] = SOIL_PINS_INIT;
const uint8_t RELAY_PINS[NZONES]   = RELAY_PINS_INIT;
const uint8_t BUTTON_PINS[NZONES]  = BUTTON_PINS_INIT;
const uint8_t WINDOWS[NWINDOWS][2] = WINDOWS_INIT;

struct Zone {
  bool autoMode = true;
  float startPct = DEF_START_PCT, stopPct = DEF_STOP_PCT;
  bool valve = false, manualRun = false;
  uint32_t manualUntil = 0, onSince = 0, offSince = 0, cycles = 0, runtimeS = 0;
  uint8_t fault = 0;
  float soil[2] = {-1, -1}; bool soilOk[2] = {false, false};
  float avg = -1; bool avgOk = false;
  String lastCmd;
  // tombol fisik
  bool btnLast = true; uint32_t btnChange = 0;
};
Zone Z[NZONES];

WiFiClient   wifi;
PubSubClient mqtt(wifi);
Preferences  prefs;

uint32_t lastSample = 0, lastPub = 0, lastWifi = 0, lastMqtt = 0, lastLed = 0;
bool publishNow = false, ntpStarted = false;

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

/* ---------------- relay / valve ---------------- */
void relayWrite(int i, bool on) { digitalWrite(RELAY_PINS[i], (on ^ (bool)RELAY_ACTIVE_LOW) ? HIGH : LOW); }
int activeCount() { int n = 0; for (int i = 0; i < NZONES; i++) if (Z[i].valve) n++; return n; }

void openValve(int i) {
  if (Z[i].valve) return;
  Z[i].valve = true; Z[i].onSince = millis(); Z[i].cycles++; Z[i].fault = 0;
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
void manualOpen(int i, uint32_t minutes) {
  minutes = constrain(minutes, 1UL, MAX_MANUAL_MIN);
  if (activeCount() >= MAX_CONCURRENT && !Z[i].valve)
    for (int k = 0; k < NZONES; k++) if (k != i) closeValve(k);     // hormati batas 1 valve
  Z[i].manualRun = true; Z[i].manualUntil = millis() + minutes * 60000UL;
  openValve(i); publishNow = true;
}

/* ---------------- waktu ---------------- */
bool timeOk() { struct tm t; return getLocalTime(&t, 0); }
bool inWindow() {
#if USE_TIME_WINDOW
  struct tm t; if (!getLocalTime(&t, 0)) return true;               // belum sync => izinkan
  for (int w = 0; w < NWINDOWS; w++) {
    uint8_t a = WINDOWS[w][0], b = WINDOWS[w][1];
    if (a <= b ? (t.tm_hour >= a && t.tm_hour < b) : (t.tm_hour >= a || t.tm_hour < b)) return true;
  }
  return false;
#else
  return true;
#endif
}

/* ---------------- soil ---------------- */
int readRaw(uint8_t pin) { uint32_t s = 0; for (int k = 0; k < 16; k++) { s += analogRead(pin); delayMicroseconds(300); } return s / 16; }
void readSoil() {
  for (int i = 0; i < NZONES; i++) {
    float sum = 0; int n = 0;
    for (int j = 0; j < 2; j++) {
      int raw = readRaw(SOIL_PINS[i][j]);
      bool ok = raw > 300 && raw < 4000;                            // lepas kabel / short => di luar range
      Z[i].soilOk[j] = ok;
      if (ok) { Z[i].soil[j] = constrain((SOIL_RAW_DRY - raw) * 100.0f / (SOIL_RAW_DRY - SOIL_RAW_WET), 0.0f, 100.0f); sum += Z[i].soil[j]; n++; }
      else Z[i].soil[j] = -1;
    }
    Z[i].avgOk = n > 0; Z[i].avg = n ? sum / n : -1;
  }
}

/* ---------------- tombol fisik ---------------- */
void buttonLoop() {
  uint32_t now = millis();
  for (int i = 0; i < NZONES; i++) {
    bool lvl = digitalRead(BUTTON_PINS[i]);
    if (lvl != Z[i].btnLast && now - Z[i].btnChange > 50) {         // debounce 50 ms
      Z[i].btnChange = now; Z[i].btnLast = lvl;
      if (lvl == LOW) {                                             // ditekan
        if (Z[i].valve) { Z[i].manualRun = false; closeValve(i); }
        else manualOpen(i, BUTTON_MANUAL_MIN);
      }
    }
  }
}

/* ---------------- control logic ---------------- */
void controlLoop() {
  uint32_t now = millis(); bool win = inWindow();
  for (int i = 0; i < NZONES; i++) {
    Zone& z = Z[i];
    if (z.valve && !z.avgOk && !z.manualRun) closeValve(i, 1);      // fail-safe: buta => tutup
    if (!z.avgOk && z.fault == 0) { z.fault = 1; publishNow = true; }
    if (z.avgOk && z.fault == 1)  { z.fault = 0; publishNow = true; }

    if (z.manualRun) {
      if ((int32_t)(now - z.manualUntil) >= 0) closeValve(i);
    } else if (z.autoMode) {
      if (!z.valve) {
        bool cooled = (now - z.offSince) >= MIN_OFF_S * 1000UL;
        if (z.avgOk && z.avg < z.startPct && cooled && win && activeCount() < MAX_CONCURRENT) openValve(i);
      } else if (z.avgOk && z.avg >= z.stopPct) closeValve(i);
    }
    if (z.valve && !z.manualRun && (now - z.onSince) >= MAX_RUN_S * 1000UL) closeValve(i, 2);
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

/* ---------------- shared attributes dari ThingsBoard ---------------- */
void applyCmd(int i, const String& cmd) {
  if (cmd == Z[i].lastCmd) return;                                  // jangan eksekusi ulang cmd lama
  Z[i].lastCmd = cmd;
  int p1 = cmd.indexOf('|'), p2 = cmd.indexOf('|', p1 + 1);
  if (p1 < 0) return;
  String act = cmd.substring(0, p1);
  uint32_t minutes = (p2 > p1) ? cmd.substring(p1 + 1, p2).toInt() : 0;
  if (act == "open") manualOpen(i, minutes);
  else if (act == "close") { Z[i].manualRun = false; closeValve(i); }
  saveZone(i);
}
void applyAttrs(JsonObjectConst o) {
  char k[16];
  for (int i = 0; i < NZONES; i++) {
    bool changed = false;
    snprintf(k, sizeof(k), "z%d_auto", i + 1);
    if (o[k].is<bool>()) { bool a = o[k].as<bool>(); if (a != Z[i].autoMode) { Z[i].autoMode = a; changed = true; if (!a && !Z[i].manualRun) closeValve(i); } }
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
/* ---------------- RPC (v1/devices/me/rpc/request/<id>  ->  .../response/<id>) ---------------- */
bool parseOn(JsonVariantConst v, bool& on) {
  if (v.is<bool>()) { on = v.as<bool>(); return true; }
  if (v.is<int>())  { on = v.as<int>() != 0; return true; }
  if (v.is<const char*>()) {
    String t = v.as<const char*>(); t.toLowerCase();
    if (t == "on" || t == "open" || t == "true" || t == "1")  { on = true;  return true; }
    if (t == "off" || t == "close" || t == "false" || t == "0") { on = false; return true; }
  }
  return false;
}
void rpcSend(const char* id, const char* json) {
  char t[64]; snprintf(t, sizeof(t), "v1/devices/me/rpc/response/%s", id);
  mqtt.publish(t, json);
}
void zoneJson(int i, JsonObject o) {
  Zone& z = Z[i];
  o["zone"] = i + 1; o["valve"] = z.valve; o["auto"] = z.autoMode;
  o["soil"] = z.avgOk ? roundf(z.avg * 10) / 10 : -1; o["start_pct"] = z.startPct; o["stop_pct"] = z.stopPct;
  o["remain_s"] = (z.valve && z.manualRun) ? (int)max(0, (int)((int32_t)(z.manualUntil - millis()) / 1000)) : 0;
  o["fault"] = z.fault;
}
void rpcError(const char* id, const char* msg) { JsonDocument d; d["error"] = msg; char b[120]; serializeJson(d, b, sizeof(b)); rpcSend(id, b); }

void handleRpc(const char* id, JsonDocument& req) {
  String method = (const char*)(req["method"] | "");
  JsonVariantConst p = req["params"];
  int zone = 1;
  String base = method; int n = base.length();
  if (n > 0 && isDigit(base[n - 1])) { zone = base[n - 1] - '0'; base.remove(n - 1); }       // setValve2 / getValve2
  if (p.is<JsonObjectConst>() && p["zone"].is<int>()) zone = p["zone"].as<int>();
  bool zoneOk = zone >= 1 && zone <= NZONES; int zi = zone - 1;
  char buf[400];

  if (base == "setValve" || base == "setRelay" || base == "setValue") {
    if (!zoneOk) { rpcError(id, "zone tidak valid"); return; }
    bool on; JsonVariantConst sv = p.is<JsonObjectConst>() ? (p["state"].isNull() ? p["value"] : p["state"]) : p;
    if (!parseOn(sv, on)) { rpcError(id, "params state tidak valid (true/false)"); return; }
    if (on) {
      uint32_t minutes = p.is<JsonObjectConst>() ? (uint32_t)(p["minutes"] | (int)RPC_DEFAULT_MIN) : RPC_DEFAULT_MIN;
      manualOpen(zi, minutes);
    } else { Z[zi].manualRun = false; closeValve(zi); }
    JsonDocument d; zoneJson(zi, d.to<JsonObject>()); serializeJson(d, buf, sizeof(buf)); rpcSend(id, buf);
  } else if (base == "getValve" || base == "getRelay" || base == "getValue") {
    if (!zoneOk) { rpcError(id, "zone tidak valid"); return; }
    if (method.length() > base.length()) rpcSend(id, Z[zi].valve ? "true" : "false");           // getValveN -> boolean (widget Switch)
    else { JsonDocument d; zoneJson(zi, d.to<JsonObject>()); serializeJson(d, buf, sizeof(buf)); rpcSend(id, buf); }
  } else if (base == "setAuto") {
    if (!zoneOk) { rpcError(id, "zone tidak valid"); return; }
    bool a; JsonVariantConst av = p.is<JsonObjectConst>() ? p["auto"] : p;
    if (!parseOn(av, a)) { rpcError(id, "params auto tidak valid"); return; }
    Z[zi].autoMode = a; if (!a && !Z[zi].manualRun) closeValve(zi);
    saveZone(zi); publishNow = true;
    JsonDocument d; zoneJson(zi, d.to<JsonObject>()); serializeJson(d, buf, sizeof(buf)); rpcSend(id, buf);
  } else if (base == "setThresholds") {
    if (!zoneOk) { rpcError(id, "zone tidak valid"); return; }
    float s = p["start"] | -1.0f, e = p["stop"] | -1.0f;
    if (s < 0 || e > 100 || e <= s) { rpcError(id, "start/stop tidak valid (0<=start<stop<=100)"); return; }
    Z[zi].startPct = s; Z[zi].stopPct = e; saveZone(zi); publishNow = true;
    JsonDocument d; zoneJson(zi, d.to<JsonObject>()); serializeJson(d, buf, sizeof(buf)); rpcSend(id, buf);
  } else if (base == "getState") {
    JsonDocument d;
    if (p.is<JsonObjectConst>() && p["zone"].is<int>()) { if (!zoneOk) { rpcError(id, "zone tidak valid"); return; } zoneJson(zi, d.to<JsonObject>()); }
    else { JsonArray a = d["zones"].to<JsonArray>(); for (int i = 0; i < NZONES; i++) zoneJson(i, a.add<JsonObject>()); d["fw"] = FW_VERSION; }
    serializeJson(d, buf, sizeof(buf)); rpcSend(id, buf);
  } else if (base == "closeAll") {
    for (int i = 0; i < NZONES; i++) { Z[i].manualRun = false; closeValve(i); }
    rpcSend(id, "{\"ok\":true}");
  } else rpcError(id, "method tidak dikenal");
}

void onMqtt(char* topic, byte* payload, unsigned int len) {
  static const char RPC_REQ[] = "v1/devices/me/rpc/request/";
  if (strncmp(topic, RPC_REQ, sizeof(RPC_REQ) - 1) == 0) {
    JsonDocument req;
    if (deserializeJson(req, payload, len)) { rpcError(topic + sizeof(RPC_REQ) - 1, "JSON tidak valid"); return; }
    handleRpc(topic + sizeof(RPC_REQ) - 1, req);
    return;
  }
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) return;
  JsonObjectConst o = doc["shared"].is<JsonObjectConst>() ? doc["shared"].as<JsonObjectConst>() : doc.as<JsonObjectConst>();
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
    snprintf(k, sizeof(k), "z%d_remain_s", n);  d[k] = (z.valve && z.manualRun) ? (int)max(0, (int)((int32_t)(z.manualUntil - now) / 1000)) : 0;
    snprintf(k, sizeof(k), "z%d_cycles", n);    d[k] = z.cycles;
    snprintf(k, sizeof(k), "z%d_runtime_s", n); d[k] = z.runtimeS + (z.valve ? (now - z.onSince) / 1000 : 0);
    snprintf(k, sizeof(k), "z%d_fault", n);     d[k] = z.fault;
  }
  d["rssi"] = WiFi.RSSI(); d["uptime_s"] = now / 1000; d["heap"] = ESP.getFreeHeap(); d["fw_version"] = FW_VERSION;
  d["time_ok"] = timeOk() ? 1 : 0; d["in_window"] = inWindow() ? 1 : 0; d["win"] = USE_TIME_WINDOW ? WINDOW_TEXT : "24h";
  char buf[1000]; size_t n = serializeJson(d, buf, sizeof(buf));
  mqtt.publish("v1/devices/me/telemetry", (const uint8_t*)buf, n);
}

/* ---------------- network ---------------- */
void requestSharedAttrs() {
  String keys;
  for (int i = 1; i <= NZONES; i++) { if (i > 1) keys += ","; keys += "z" + String(i) + "_auto,z" + String(i) + "_start_pct,z" + String(i) + "_stop_pct"; }
  String msg = "{\"sharedKeys\":\"" + keys + "\"}";
  mqtt.publish("v1/devices/me/attributes/request/1", msg.c_str());   // zN_cmd sengaja tidak di-request
}
void netLoop() {
  uint32_t now = millis();
  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastWifi > 10000) { lastWifi = now; WiFi.disconnect(); WiFi.begin(WIFI_SSID, WIFI_PASS); }
    return;
  }
#if USE_TIME_WINDOW
  if (!ntpStarted) { configTime(GMT_OFFSET_S, 0, "pool.ntp.org", "time.google.com"); ntpStarted = true; }
#endif
  if (!mqtt.connected()) {
    if (now - lastMqtt > 5000) {
      lastMqtt = now;
      String id = String("nismara-irr-") + String((uint32_t)ESP.getEfuseMac(), HEX);
      if (mqtt.connect(id.c_str(), TB_TOKEN, NULL)) {
        mqtt.subscribe("v1/devices/me/attributes");
        mqtt.subscribe("v1/devices/me/attributes/response/+");
        mqtt.subscribe("v1/devices/me/rpc/request/+");
        requestSharedAttrs(); publishNow = true;
      }
    }
    return;
  }
  mqtt.loop();
}

/* LED: cepat = WiFi putus | sedang = TB putus | nyala tetap = ada valve terbuka | kedip lambat = normal */
void ledLoop() {
  uint32_t now = millis();
  if (activeCount() > 0 && WiFi.status() == WL_CONNECTED && mqtt.connected()) { digitalWrite(PIN_STATUS_LED, HIGH); return; }
  uint32_t period = WiFi.status() != WL_CONNECTED ? 200 : (!mqtt.connected() ? 600 : 2000);
  if (now - lastLed >= period) { lastLed = now; digitalWrite(PIN_STATUS_LED, !digitalRead(PIN_STATUS_LED)); }
}

/* ---------------- setup / loop ---------------- */
void setup() {
  Serial.begin(115200);
  analogReadResolution(12); analogSetAttenuation(ADC_11db);
  pinMode(PIN_STATUS_LED, OUTPUT);
  prefs.begin("irr", false);
  for (int i = 0; i < NZONES; i++) {
    digitalWrite(RELAY_PINS[i], (bool)RELAY_ACTIVE_LOW ? HIGH : LOW);   // set level OFF dulu supaya tidak "klik" saat pinMode
    pinMode(RELAY_PINS[i], OUTPUT);
    pinMode(BUTTON_PINS[i], INPUT_PULLUP);
    loadZone(i);
    Z[i].offSince = millis() - MIN_OFF_S * 1000UL;                      // boleh langsung siram bila kering
  }
  WiFi.mode(WIFI_STA); WiFi.begin(WIFI_SSID, WIFI_PASS);
  mqtt.setServer(TB_HOST, TB_PORT); mqtt.setBufferSize(1024); mqtt.setCallback(onMqtt);
  readSoil();
  wdtInit();
}

void loop() {
  esp_task_wdt_reset();
#if SOIL_CAL_MODE
  static uint32_t lastCal = 0;
  if (millis() - lastCal >= 500) {
    lastCal = millis();
    for (int i = 0; i < NZONES; i++) for (int j = 0; j < 2; j++) {
      int raw = readRaw(SOIL_PINS[i][j]);
      Serial.printf("Z%d-S%d GPIO%d raw=%4d  -> %3.0f%%  %s\n", i + 1, j + 1, SOIL_PINS[i][j], raw,
                    constrain((SOIL_RAW_DRY - raw) * 100.0f / (SOIL_RAW_DRY - SOIL_RAW_WET), 0.0f, 100.0f),
                    (raw > 300 && raw < 4000) ? "" : "<< di luar range: kabel lepas / short?");
    }
    Serial.println("----");
  }
  return;                                   // mode kalibrasi: tidak menjalankan kontrol/jaringan
#endif
  netLoop(); buttonLoop(); ledLoop();
  uint32_t now = millis();
  if (now - lastSample >= SAMPLE_MS) {
    lastSample = now;
    readSoil(); controlLoop();
    for (int i = 0; i < NZONES; i++)
      Serial.printf("Z%d soil %.0f/%.0f avg %.0f valve %d auto %d (%.0f-%.0f) win %d\n", i + 1,
                    Z[i].soil[0], Z[i].soil[1], Z[i].avg, Z[i].valve, Z[i].autoMode, Z[i].startPct, Z[i].stopPct, inWindow());
  }
  if (publishNow || now - lastPub >= PUBLISH_MS) { publishNow = false; lastPub = now; publishTelemetry(); }
}
