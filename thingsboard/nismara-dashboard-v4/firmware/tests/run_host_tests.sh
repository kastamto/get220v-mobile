#!/usr/bin/env bash
# Uji logika sketch irigasi (RPC, relay, batas waktu) di komputer biasa — tanpa ESP32.
# Butuh: g++, curl (untuk mengunduh ArduinoJson sekali).   Jalankan:  bash run_host_tests.sh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"; FW="$HERE/.."; TMP="$(mktemp -d)"
[ -f "$HERE/stubs/ArduinoJson.h" ] || curl -sSL -o "$HERE/stubs/ArduinoJson.h" https://github.com/bblanchon/ArduinoJson/releases/download/v7.2.0/ArduinoJson-v7.2.0.h
echo "=== aturan Arduino IDE (lint + prototipe otomatis) ==="
python3 -I "$HERE/lint_arduino_sketch.py" "$FW/nismara_gwt/nismara_gwt.ino" "$FW/nismara_irrigation/nismara_irrigation.ino"
python3 -I "$HERE/proto_check.py" "$FW/nismara_gwt/nismara_gwt.ino" "$HERE/stubs" "$FW/nismara_gwt"
python3 -I "$HERE/proto_check.py" "$FW/nismara_irrigation/nismara_irrigation.ino" "$HERE/stubs" "$FW/nismara_irrigation"
cp "$FW/nismara_irrigation/nismara_irrigation.ino" "$TMP/nismara_irrigation.cpp"
for P in LT1 ROOF; do
  mkdir -p "$TMP/$P"
  if [ "$P" = ROOF ]; then sed 's|^#define PROFILE_GARDEN_LT1|//&|; s|^//#define PROFILE_GARDEN_ROOF|#define PROFILE_GARDEN_ROOF|' "$FW/nismara_irrigation/config.h" > "$TMP/$P/config.h"
  else cp "$FW/nismara_irrigation/config.h" "$TMP/$P/config.h"; fi
  g++ -std=c++17 -Wno-unused-variable -Wno-sign-compare -Wno-format-truncation -I"$HERE/stubs" -I"$TMP" -I"$TMP/$P" "$HERE/rpc_test.cpp" -o "$TMP/test_$P"
  echo "=== profil $P ==="; "$TMP/test_$P" | grep -E "Profil|ok:|FAIL|UJI|GAGAL|LCD|^\[|^\||^\+--"
done
# --- tampilan LCD 20x4 sketch GWT ---
cp "$FW/nismara_gwt/nismara_gwt.ino" "$TMP/nismara_gwt.cpp"
g++ -std=c++17 -Wno-unused-variable -Wno-sign-compare -Wno-format-truncation -I"$HERE/stubs" -I"$TMP" -I"$FW/nismara_gwt" "$HERE/lcd_test.cpp" -o "$TMP/test_lcd"
echo "=== LCD GWT ==="; "$TMP/test_lcd"
