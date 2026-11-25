// Host test: menjalankan sketch irigasi ASLI dengan stub Arduino, mengirim RPC, memeriksa relay & balasan.
#include "Arduino.h"
#include <string>
#include <vector>
#include <map>
#include <stdio.h>
#include <stdlib.h>

// ---- implementasi stub (state terkontrol) ----
static unsigned long g_ms = 100000;
static int g_raw = 2300;                          // soil ~50%
static std::map<int, int> g_pin;
std::vector<std::pair<std::string, std::string>> g_pub;
unsigned long millis() { return g_ms; }
void delay(unsigned long) {} void delayMicroseconds(unsigned int) {}
void pinMode(uint8_t, uint8_t) {} void digitalWrite(uint8_t p, uint8_t v) { g_pin[p] = v; } int digitalRead(uint8_t p) { return g_pin.count(p) ? g_pin[p] : 1; }
int analogRead(uint8_t) { return g_raw; } void analogReadResolution(int) {} void analogSetAttenuation(int) {}
unsigned long pulseIn(uint8_t, uint8_t, unsigned long) { return 0; }
void attachInterrupt(int, void (*)(), int) {} int digitalPinToInterrupt(int p) { return p; } void noInterrupts() {} void interrupts() {}
SerialT Serial; EspT ESP;
uint32_t EspT::getFreeHeap() { return 200000; } uint64_t EspT::getEfuseMac() { return 0xABCDEF; }
#include "WiFi.h"
WiFiT WiFi; int WiFiT::status() { return 3; } void WiFiT::disconnect() {} void WiFiT::begin(const char*, const char*) {} void WiFiT::mode(int) {} int WiFiT::RSSI() { return -60; }
void configTime(long, int, const char*, const char*) {} bool getLocalTime(struct tm* t, uint32_t) { time_t n = 1700000000 + 6 * 3600; localtime_r(&n, t); t->tm_hour = 6; return true; }   // jam 06 = dalam jendela
#include "PubSubClient.h"
bool PubSubClient::connected() { return true; } bool PubSubClient::connect(const char*, const char*, const char*) { return true; }
void PubSubClient::setServer(const char*, int) {} void PubSubClient::setBufferSize(int) {} void PubSubClient::setCallback(void (*)(char*, byte*, unsigned int)) {}
bool PubSubClient::subscribe(const char*) { return true; } void PubSubClient::loop() {}
bool PubSubClient::publish(const char* t, const char* p) { g_pub.push_back({t, p}); return true; }
bool PubSubClient::publish(const char* t, const uint8_t* p, unsigned n) { g_pub.push_back({t, std::string((const char*)p, n)}); return true; }
#include "Preferences.h"
bool Preferences::begin(const char*, bool) { return true; } bool Preferences::getBool(const char*, bool d) { return d; } float Preferences::getFloat(const char*, float d) { return d; }
String Preferences::getString(const char*, String d) { return d; } void Preferences::putBool(const char*, bool) {} void Preferences::putFloat(const char*, float) {} void Preferences::putString(const char*, String) {}
#include "esp_task_wdt.h"
int esp_task_wdt_init(int, bool) { return 0; } int esp_task_wdt_add(void*) { return 0; } int esp_task_wdt_reset() { return 0; }

#include "nismara_irrigation.cpp"      // sketch asli (disalin run_host_tests.sh)

static int fails = 0;
#define CHECK(c, msg) do { if (!(c)) { printf("  FAIL: %s\n", msg); fails++; } else printf("  ok:   %s\n", msg); } while (0)
static std::string rpc(const char* id, const char* json) {
  g_pub.clear(); std::string topic = std::string("v1/devices/me/rpc/request/") + id;
  onMqtt((char*)topic.c_str(), (byte*)json, strlen(json));
  for (auto& m : g_pub) if (m.first == std::string("v1/devices/me/rpc/response/") + id) return m.second;
  return "<tidak ada balasan>";
}
static bool relayOn(int i) { int lvl = g_pin[RELAY_PINS[i]]; return (RELAY_ACTIVE_LOW ? lvl == LOW : lvl == HIGH); }
static void tick(unsigned long sec) { g_ms += sec * 1000; lastSample = 0; readSoil(); controlLoop(); }

int main() {
  setup(); tick(1);
  printf("Profil: %s  (NZONES=%d)\n", FW_VERSION, NZONES);
  std::string r;
  r = rpc("1", "{\"method\":\"setValve\",\"params\":{\"zone\":1,\"state\":true,\"minutes\":2}}"); printf("  -> %s\n", r.c_str());
  CHECK(relayOn(0), "setValve zone1 ON -> relay menyala"); CHECK(r.find("\"valve\":true") != std::string::npos, "balasan valve:true");
  tick(130); CHECK(!relayOn(0), "otomatis OFF setelah 2 menit (batas waktu)");
  r = rpc("2", "{\"method\":\"setRelay\",\"params\":{\"zone\":1,\"state\":\"on\"}}");
  CHECK(relayOn(0) && r.find("\"remain_s\":600") != std::string::npos || r.find("\"remain_s\":59") != std::string::npos, "setRelay 'on' tanpa minutes = RPC_DEFAULT_MIN (600 dtk)");
  r = rpc("3", "{\"method\":\"getValve1\",\"params\":{}}"); CHECK(r == "true", "getValve1 -> true (boolean utk widget Switch)");
  r = rpc("4", "{\"method\":\"setValve1\",\"params\":false}"); CHECK(!relayOn(0), "setValve1 params false -> relay OFF");
  r = rpc("5", "{\"method\":\"getValve1\"}"); CHECK(r == "false", "getValve1 -> false");
  r = rpc("6", "{\"method\":\"setValve\",\"params\":{\"zone\":1,\"state\":true,\"minutes\":999}}"); CHECK(r.find("\"remain_s\":3599") != std::string::npos || r.find("\"remain_s\":3600") != std::string::npos, "minutes dibatasi MAX_MANUAL_MIN (60 mnt)");
#if NZONES == 2
  r = rpc("7", "{\"method\":\"setValve2\",\"params\":true}"); CHECK(relayOn(1) && !relayOn(0), "setValve2 true -> Z2 ON, Z1 dimatikan (MAX_CONCURRENT=1)");
  r = rpc("8", "{\"method\":\"getState\"}"); printf("  -> %s\n", r.c_str()); CHECK(r.find("\"zones\"") != std::string::npos, "getState semua zona");
#else
  r = rpc("7", "{\"method\":\"setValve2\",\"params\":true}"); CHECK(r.find("error") != std::string::npos, "zona 2 tidak ada di profil Roof -> error");
#endif
  r = rpc("9", "{\"method\":\"setAuto\",\"params\":{\"zone\":1,\"auto\":false}}"); CHECK(!Z[0].autoMode, "setAuto false");
  r = rpc("10", "{\"method\":\"setThresholds\",\"params\":{\"zone\":1,\"start\":25,\"stop\":60}}"); CHECK(Z[0].startPct == 25 && Z[0].stopPct == 60, "setThresholds 25/60");
  r = rpc("11", "{\"method\":\"setThresholds\",\"params\":{\"zone\":1,\"start\":60,\"stop\":25}}"); CHECK(r.find("error") != std::string::npos && Z[0].startPct == 25, "threshold tidak valid ditolak");
  r = rpc("12", "{\"method\":\"closeAll\"}"); CHECK(!relayOn(0) && (NZONES < 2 || !relayOn(1)), "closeAll -> semua relay OFF");
  r = rpc("13", "{\"method\":\"foo\"}"); CHECK(r.find("error") != std::string::npos, "method tidak dikenal -> error");
  r = rpc("14", "{bukan json"); CHECK(r.find("error") != std::string::npos, "JSON rusak -> error, tidak crash");
  g_pub.clear(); publishTelemetry();
  std::string tel; for (auto& m : g_pub) if (m.first == "v1/devices/me/telemetry") tel = m.second;
  CHECK(tel.find("\"z1_soil1\"") != std::string::npos, "telemetry berisi z1_soil1");
#if SOILS_PER_ZONE == 1
  CHECK(tel.find("soil2") == std::string::npos, "profil 1 sensor/zona: tidak ada key soil2");
  CHECK(NZONES < 2 || tel.find("\"z2_soil1\"") != std::string::npos, "zona 2 memakai z2_soil1");
#else
  CHECK(tel.find("\"z1_soil2\"") != std::string::npos, "profil 2 sensor/zona: ada key z1_soil2");
#endif
  // valve ON manual lalu sensor tanah error: tetap manual (operator override)
  printf("\n%s (%d gagal)\n", fails ? "ADA YANG GAGAL" : "SEMUA UJI LULUS", fails);
  return fails ? 1 : 0;
}
