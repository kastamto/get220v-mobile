#pragma once
/* =====================================================================
 *  NISMARA SMART IRRIGATION  -  CONFIG  (pin, profil, kalibrasi, jadwal)
 *  Pilih SATU profil, flash ke masing-masing ESP32.
 * ===================================================================== */

/* ---------------- PILIH PROFIL ---------------- */
#define PROFILE_GARDEN_LT1          // Garden Lt.1  : 2 zone, 4 soil, 2 solenoid
//#define PROFILE_GARDEN_ROOF       // Garden Roof  : 1 zone, 2 soil, 1 solenoid

/* ---------------- NETWORK / THINGSBOARD ---------------- */
#define WIFI_SSID       "YOUR_WIFI"
#define WIFI_PASS       "YOUR_PASS"
#define TB_HOST         "thingsboard.example.com"
#define TB_PORT         1883
#define TB_TOKEN        "DEVICE_ACCESS_TOKEN"     // token device Garden Lt.1 / Garden Roof (BEDA per device)

/* ---------------- PIN MAP ----------------
 *  Hanya ADC1 (GPIO32-39) untuk soil sensor -> aman bersama WiFi.
 *
 *  GARDEN LT.1                      GARDEN ROOF
 *  Z1 soil1  GPIO34 (AOUT)          Z1 soil1  GPIO34
 *  Z1 soil2  GPIO35                 Z1 soil2  GPIO35
 *  Z2 soil1  GPIO32                 Z1 relay  GPIO26
 *  Z2 soil2  GPIO33                 Z1 button GPIO13 (ke GND)
 *  Z1 relay  GPIO26 (IN1)           LED       GPIO2
 *  Z2 relay  GPIO27 (IN2)
 *  Z1 button GPIO13 (ke GND)        Sensor capacitive : VCC 3.3V, GND, AOUT -> pin ADC
 *  Z2 button GPIO14 (ke GND)        Relay module      : VCC 5V (JD-VCC terpisah bila ada), IN -> GPIO
 *  LED       GPIO2                  Solenoid          : 12/24V via relay COM/NO + dioda flyback 1N4007
 *                                   Button manual     : tekan = buka 5 mnt, tekan lagi = tutup
 * ---------------------------------------- */
#if defined(PROFILE_GARDEN_LT1)
  #define NZONES            2
  #define SOIL_PINS_INIT    {{34, 35}, {32, 33}}
  #define RELAY_PINS_INIT   {26, 27}
  #define BUTTON_PINS_INIT  {13, 14}
  #define MAX_CONCURRENT    1                   // suplai bersama -> 1 valve sekaligus
  #define FW_VERSION        "irr-lt1-1.1"
#elif defined(PROFILE_GARDEN_ROOF)
  #define NZONES            1
  #define SOIL_PINS_INIT    {{34, 35}}
  #define RELAY_PINS_INIT   {26}
  #define BUTTON_PINS_INIT  {13}
  #define MAX_CONCURRENT    1
  #define FW_VERSION        "irr-roof-1.1"
#else
  #error "Pilih PROFILE_GARDEN_LT1 atau PROFILE_GARDEN_ROOF"
#endif
#define PIN_STATUS_LED      2

#define RELAY_ACTIVE_LOW    1                   // 1 = relay aktif saat pin LOW (umum)

/* ---------------- KALIBRASI SOIL (ADC 12-bit, 11dB) ----------------
 * Ukur: sensor di udara = DRY, tercelup air = WET. Lihat Serial Monitor "raw". */
#define SOIL_RAW_DRY        3200
#define SOIL_RAW_WET        1400

/* ---------------- DEFAULT THRESHOLD (bisa diubah dari dashboard) ---------------- */
#define DEF_START_PCT       30.0f               // buka valve bila soil < nilai ini
#define DEF_STOP_PCT        55.0f               // tutup valve bila soil >= nilai ini

/* ---------------- KESELAMATAN ---------------- */
#define MAX_RUN_S           900UL               // paksa tutup bila ON > 15 menit
#define MIN_OFF_S           600UL               // jeda minimum antar siram (air meresap)
#define MAX_MANUAL_MIN      60UL
#define BUTTON_MANUAL_MIN   5UL                 // durasi saat tombol fisik ditekan

/* ---------------- JENDELA WAKTU SIRAM (NTP) ----------------
 * Auto hanya MULAI siram di dalam jendela. Stop tidak dibatasi.
 * Bila NTP belum sync => dianggap boleh (fail-open). Format jam 0-23, [from, to). */
#define USE_TIME_WINDOW     1
#define GMT_OFFSET_S        (7 * 3600)          // WIB
#define WINDOWS_INIT        {{5, 9}, {16, 19}}  // 05:00-09:00 dan 16:00-19:00
#define NWINDOWS            2
#define WINDOW_TEXT         "05-09,16-19"       // hanya utk tampilan di dashboard

/* ---------------- TIMING ---------------- */
#define SAMPLE_MS           2000UL
#define PUBLISH_MS          15000UL
#define WDT_SECONDS         30
