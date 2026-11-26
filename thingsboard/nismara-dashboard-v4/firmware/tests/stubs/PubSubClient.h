#pragma once
#include "WiFi.h"
struct PubSubClient{PubSubClient(WiFiClient&){} bool connected(); bool connect(const char*,const char*,const char*);
 void setServer(const char*,int); void setBufferSize(int); void setCallback(void(*)(char*,byte*,unsigned int));
 bool subscribe(const char*); bool publish(const char*,const char*); bool publish(const char*,const uint8_t*,unsigned); void loop();};
