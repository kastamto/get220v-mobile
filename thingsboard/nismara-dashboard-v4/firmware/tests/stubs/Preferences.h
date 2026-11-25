#pragma once
#include "Arduino.h"
struct Preferences{bool begin(const char*,bool);bool getBool(const char*,bool);float getFloat(const char*,float);String getString(const char*,String);
 void putBool(const char*,bool);void putFloat(const char*,float);void putString(const char*,String);};
