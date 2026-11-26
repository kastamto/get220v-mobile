#pragma once
#include "Arduino.h"
struct WiFiClient{}; 
struct WiFiT{int status();void disconnect();void begin(const char*,const char*);void mode(int);int RSSI();} extern WiFi;
#define WIFI_STA 1
void configTime(long,int,const char*,const char*); bool getLocalTime(struct tm*,uint32_t ms=5000);
