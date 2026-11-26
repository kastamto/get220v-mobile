// Host test: tampilan LCD 20x4 sketch GWT (isi 4 baris, lebar 20 kolom). Menjalankan sketch asli dengan stub.
#include "Arduino.h"
#include <string>
#include <stdio.h>
#include <stdlib.h>

static unsigned long g_ms = 100000;
unsigned long millis() { return g_ms; }
void delay(unsigned long) {} void delayMicroseconds(unsigned int) {}
void pinMode(uint8_t, uint8_t) {} void digitalWrite(uint8_t, uint8_t) {} int digitalRead(uint8_t) { return 0; }
int analogRead(uint8_t) { return 0; } void analogReadResolution(int) {} void analogSetAttenuation(int) {}
unsigned long pulseIn(uint8_t, uint8_t, unsigned long) { return 0; }
void attachInterrupt(int, void (*)(), int) {} int digitalPinToInterrupt(int p) { return p; } void noInterrupts() {} void interrupts() {}
SerialT Serial; EspT ESP;
uint32_t EspT::getFreeHeap() { return 200000; } uint64_t EspT::getEfuseMac() { return 0xABCDEF; }
#include "WiFi.h"
static bool g_wifi = true;
WiFiT WiFi; int WiFiT::status() { return g_wifi ? 3 : 6; } void WiFiT::disconnect() {} void WiFiT::begin(const char*, const char*) {} void WiFiT::mode(int) {} int WiFiT::RSSI() { return -71; }
#include "PubSubClient.h"
bool PubSubClient::connected() { return true; } bool PubSubClient::connect(const char*, const char*, const char*) { return true; }
void PubSubClient::setServer(const char*, int) {} void PubSubClient::setBufferSize(int) {} void PubSubClient::setCallback(void (*)(char*, byte*, unsigned int)) {}
bool PubSubClient::subscribe(const char*) { return true; } void PubSubClient::loop() {}
bool PubSubClient::publish(const char*, const char*) { return true; } bool PubSubClient::publish(const char*, const uint8_t*, unsigned) { return true; }
#include "Preferences.h"
bool Preferences::begin(const char*, bool) { return true; } bool Preferences::getBool(const char*, bool d) { return d; } float Preferences::getFloat(const char*, float d) { return d; }
String Preferences::getString(const char*, String d) { return d; } void Preferences::putBool(const char*, bool) {} void Preferences::putFloat(const char*, float) {} void Preferences::putString(const char*, String) {}
#include "esp_task_wdt.h"
int esp_task_wdt_init(int, bool) { return 0; } int esp_task_wdt_add(void*) { return 0; } int esp_task_wdt_reset() { return 0; }
#include "Wire.h"
WireT Wire; void WireT::begin(int, int) {}
#include "LiquidCrystal_I2C.h"
static int g_row = 0; static std::string g_screen[8];
void LiquidCrystal_I2C::init() {} void LiquidCrystal_I2C::backlight() {}
void LiquidCrystal_I2C::setCursor(int, int r) { g_row = r; }
void LiquidCrystal_I2C::print(const String& s) { g_screen[g_row] = s; }

#include "nismara_gwt.cpp"      // sketch asli (disalin run_host_tests.sh)

static int fails = 0;
#define CHECK(c, msg) do { if (!(c)) { printf("  FAIL: %s\n", msg); fails++; } else printf("  ok:   %s\n", msg); } while (0)
static void show(const char* title) {
  printf("\n[%s]\n+--------------------+\n", title);
  for (int i = 0; i < LCD_ROWS; i++) printf("|%s|\n", g_screen[i].c_str());
  printf("+--------------------+\n");
}
static bool widthOk() { for (int i = 0; i < LCD_ROWS; i++) if ((int)g_screen[i].size() != LCD_COLS) return false; return true; }

int main() {
  printf("LCD %dx%d\n", LCD_COLS, LCD_ROWS);
  // 1) normal, fase status (millis/4000 genap)
  g_ms = 16000 * 3 + 4000 * 0; g_ms = 3 * 3600 * 1000UL + 0;                       // 3 jam uptime
  g_ms = (g_ms / 8000) * 8000;                                                      // fase genap
  r1 = {80.0f, 62.0f, 1550.0f, true}; r2 = {85.0f, 58.0f, 1450.0f, true}; rw = {60.0f, 78.0f, 780.0f, true};
  flowLpm = 11.0f; totalL = 2380.0f;
  drawLcd(); show("normal - fase status");
  CHECK(widthOk(), "semua baris tepat 20 kolom");
  CHECK(g_screen[0].find("T1:62% T2:58% B:OK") == 0, "baris 0: level T1/T2 + balance (B:OK)");
  CHECK(g_screen[1].find("G:3.00kL R:780L") == 0, "baris 1: volume GWT total (kL) & tangki hujan (L)");
  CHECK(g_screen[2].find("Rain:78% 11.0L/m") == 0, "baris 2: level & flow tangki hujan");
  CHECK(g_screen[3].find("WiFi-71 TB:OK Up 3h") == 0, "baris 3 (fase A): WiFi, TB, uptime");
  // 2) fase total hujan
  g_ms += 4000; drawLcd(); show("normal - fase total hujan");
  CHECK(g_screen[3].find("Rain total: 2.38 m3") == 0, "baris 3 (fase B): total hujan dalam m3");
  // 3) sensor error T1 & T2 (seperti telemetry asli: dist=-1)
  r1 = {-1, 0, 0, false}; r2 = {-1, 0, 0, false}; g_ms = (g_ms / 8000) * 8000;
  drawLcd(); show("T1 & T2 sensor error");
  CHECK(widthOk() && g_screen[0].find("T1:ERR T2:ERR B:ERR") == 0, "ERR tampil, B:ERR, lebar tetap 20");
  CHECK(g_screen[1].find("G:-- R:780L") == 0, "volume GWT '--' saat kedua sensor error");
  // 4) imbalance + rain sensor error + WiFi putus
  r1 = {80, 90, 2250, true}; r2 = {85, 50, 1250, true}; rw = {-1, 0, 0, false}; g_wifi = false; flowLpm = 0; totalL = 45;
  drawLcd(); show("imbalance, rain error, WiFi putus");
  CHECK(g_screen[0].find("B:!!") != std::string::npos, "imbalance -> B:!!");
  CHECK(g_screen[2].find("Rain:ERR 0.0L/m") == 0, "rain sensor error -> Rain:ERR");
  CHECK(g_screen[3].find("WiFi:-- TB:-- Up 3h") == 0, "WiFi putus -> WiFi:--");
  CHECK(widthOk(), "lebar tetap 20 kolom pada semua skenario");
  // 5) angka besar tidak melebihi lebar
  r1 = {80, 100, 2500, true}; r2 = {80, 100, 2500, true}; rw = {60, 100, 1000, true}; g_wifi = true; flowLpm = 28.5f; totalL = 123456;
  drawLcd(); show("tangki penuh, angka besar");
  CHECK(widthOk() && g_screen[0] == "T1:100% T2:100% B:OK", "angka besar (100%) tetap muat 20 kolom tanpa terpotong");
  printf("\n%s (%d gagal)\n", fails ? "ADA YANG GAGAL" : "SEMUA UJI LCD LULUS", fails);
  return fails ? 1 : 0;
}
