#pragma once
#include <stdint.h>
#include <stdio.h>
#include <string>
#include <math.h>
#include <time.h>
#include <algorithm>
#include <stdarg.h>
#include <string.h>
#include <vector>
typedef uint8_t byte;
#define IRAM_ATTR
#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1
#define INPUT_PULLUP 2
#define FALLING 2
#define HEX 16
#define ADC_11db 3
#define constrain(x,a,b) ((x)<(a)?(a):((x)>(b)?(b):(x)))
#define WL_CONNECTED 3
#define ESP_ARDUINO_VERSION_MAJOR 2
unsigned long millis(); void delay(unsigned long); void delayMicroseconds(unsigned int);
void pinMode(uint8_t,uint8_t); void digitalWrite(uint8_t,uint8_t); int digitalRead(uint8_t);
int analogRead(uint8_t); void analogReadResolution(int); void analogSetAttenuation(int);
unsigned long pulseIn(uint8_t,uint8_t,unsigned long);
void attachInterrupt(int,void(*)(),int); int digitalPinToInterrupt(int); void noInterrupts(); void interrupts();
class String : public std::string { public:
  String(){} String(const char*s):std::string(s){} String(const std::string&s):std::string(s){}
  String(int v):std::string(std::to_string(v)){} String(float v,int d=2){char b[32];snprintf(b,32,"%.*f",d,v);assign(b);}
  String(uint32_t v,int base){char b[32];snprintf(b,32,base==16?"%x":"%u",v);assign(b);}
  int indexOf(char c,int from=0)const{auto p=find(c,from);return p==npos?-1:(int)p;}
  String substring(int a,int b=-1)const{return String(b<0?substr(a):substr(a,b-a));}
  long toInt()const{return atol(c_str());} const char*c_str()const{return std::string::c_str();}
  String operator+(const String&o)const{return String(std::string(*this)+std::string(o));}
  String operator+(const char*o)const{return String(std::string(*this)+o);}
  friend String operator+(const char*a,const String&b){return String(std::string(a)+std::string(b));}
  String& operator+=(const char*o){append(o);return *this;} String& operator+=(const String&o){append(o);return *this;}
  unsigned length()const{return size();}
  void toLowerCase(){for(auto&c:*this)c=tolower(c);} void remove(unsigned i){erase(i);}
};
struct SerialT{void begin(int){} void printf(const char*f,...){va_list a;va_start(a,f);vprintf(f,a);va_end(a);}} extern Serial;
struct EspT{uint32_t getFreeHeap();uint64_t getEfuseMac();} extern ESP;
using std::min; using std::max;
#include <ctype.h>
#define isDigit(c) isdigit(c)
