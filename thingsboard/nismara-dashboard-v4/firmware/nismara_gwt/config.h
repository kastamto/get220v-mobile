#pragma once
/* =====================================================================
 *  NISMARA GWT  -  CONFIG  (semua pin & kalibrasi ada di file ini)
 *  Jangan commit token/password asli ke repo publik.
 * ===================================================================== */

/* ---------------- NETWORK / THINGSBOARD ---------------- */
#define WIFI_SSID       "YOUR_WIFI"
#define WIFI_PASS       "YOUR_PASS"
#define TB_HOST         "thingsboard.example.com"
#define TB_PORT         1883
#define TB_TOKEN        "DEVICE_ACCESS_TOKEN"      // access token device "nismara gwt"
#define FW_VERSION      "gwt-1.2"

/* ---------------- PIN MAP (ESP32 DevKit 30/38 pin) ----------------
 *   Fungsi            GPIO   Catatan
 *   LCD 20x4 SDA      21     I2C (PCF8574 backpack, VCC 5V)
 *   LCD 20x4 SCL      22     I2C
 *   T1  TRIG          26     output
 *   T1  ECHO          27     input  -> WAJIB pembagi tegangan 5V->3.3V
 *   T2  TRIG          32     output
 *   T2  ECHO          33     input  -> WAJIB pembagi tegangan
 *   RW  TRIG          18     output (tangki rain water)
 *   RW  ECHO          19     input  -> WAJIB pembagi tegangan
 *   FLOW signal       4      input pull-up (interrupt), sensor 1" rain flow
 *   STATUS LED        2      LED onboard
 * Pembagi ECHO: ECHO --[1k]--+--> GPIO ;  +--[2k]--> GND
 * ------------------------------------------------------------------ */
#define PIN_I2C_SDA     21
#define PIN_I2C_SCL     22
#define LCD_ADDR        0x27                       // 0x3F untuk beberapa modul (cek dengan I2C scanner)
#define LCD_COLS        20                         // LCD I2C 20x4
#define LCD_ROWS        4
#define PIN_T1_TRIG     26
#define PIN_T1_ECHO     27
#define PIN_T2_TRIG     32
#define PIN_T2_ECHO     33
#define PIN_RW_TRIG     18
#define PIN_RW_ECHO     19
#define PIN_FLOW        4
#define PIN_STATUS_LED  2

/* ---------------- GEOMETRI TANGKI (cm / liter) ----------------
 * EMPTY = jarak sensor -> dasar tangki saat kosong
 * FULL  = jarak sensor -> permukaan saat penuh (>= blind zone HC-SR04 ~20 cm) */
#define T1_EMPTY_CM     150.0f
#define T1_FULL_CM      20.0f
#define T1_CAP_L        2500.0f
#define T2_EMPTY_CM     150.0f
#define T2_FULL_CM      20.0f
#define T2_CAP_L        2500.0f
#define RW_EMPTY_CM     120.0f
#define RW_FULL_CM      20.0f
#define RW_CAP_L        1000.0f                    // samakan dgn rwCapacityL di dashboard

#define BALANCE_WARN_PCT 10.0f                     // selisih T1-T2 > ini => balance_ok=false

/* ---------------- FLOW 1" ----------------
 * Q(L/min) = freq(Hz) / FLOW_K . YF-G1 ~7.2-7.5 . KALIBRASI: tampung 10 L, bandingkan totalizer */
#define FLOW_K          7.5f

/* ---------------- TIMING ---------------- */
#define SAMPLE_MS       2000UL
#define PUBLISH_MS      10000UL
#define WDT_SECONDS     30
