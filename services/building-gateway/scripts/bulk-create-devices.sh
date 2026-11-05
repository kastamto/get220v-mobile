#!/usr/bin/env bash
# Buat device massal di server IoT dari CSV (kolom "label") + simpan access token ke file, bukan ke layar.
#   bash scripts/bulk-create-devices.sh data/doorbell-wo-prioritas.csv           -> DRY RUN (tidak membuat apa pun)
#   APPLY=1 bash scripts/bulk-create-devices.sh data/doorbell-wo-prioritas.csv   -> buat device yang belum ada
# Nama device = NAME_PREFIX + label (default "Door bell "). Device yang sudah ada tidak dibuat ulang; tokennya tetap diambil.
# JWT: diminta tersembunyi, atau JWT_FILE=/root/.tb-jwt (chmod 600) untuk dijalankan non-interaktif.
set -uo pipefail
TB=${TB:-http://localhost:8080}
CSV=${1:?pakai: bulk-create-devices.sh <file.csv>}
PROFILE=${PROFILE:-DOORBELL}
NAME_PREFIX=${NAME_PREFIX:-Door bell }
APPLY=${APPLY:-0}
OUT=${OUT:-/root/doorbell-tokens-$(date +%Y%m%d-%H%M).csv}
command -v jq >/dev/null || { echo "butuh jq (apt install jq)"; exit 1; }

if [ -n "${JWT_FILE:-}" ]; then JWT=$(tr -d '[:space:]' < "$JWT_FILE")
else read -r -s -p "JWT tenant admin: " JWT; echo; fi
[ -n "$JWT" ] || { echo "JWT kosong"; exit 1; }
H="X-Authorization: Bearer $JWT"
TMP=$(mktemp); trap 'rm -f "$TMP"; unset JWT' EXIT
req() { # req METHOD URL [BODY] -> isi di $TMP, echo http code
  if [ $# -ge 3 ]; then curl -sS -o "$TMP" -w '%{http_code}' -X "$1" -H "$H" -H 'Content-Type: application/json' "$2" -d "$3"
  else curl -sS -o "$TMP" -w '%{http_code}' -X "$1" -H "$H" "$2"; fi
}

code=$(req GET "$TB/api/auth/user"); [ "$code" = 200 ] || { echo "JWT tidak valid (HTTP $code)"; exit 1; }
[ "$(jq -r .authority "$TMP")" = TENANT_ADMIN ] || { echo "harus akun TENANT_ADMIN"; exit 1; }
code=$(req GET "$TB/api/deviceProfileInfos?pageSize=100&page=0&textSearch=$PROFILE")
PID=$(jq -r --arg p "$PROFILE" '.data[]? | select(.name==$p) | .id.id' "$TMP" | head -1)
[ -n "$PID" ] || { echo "device profile \"$PROFILE\" tidak ditemukan (cek penulisan huruf besar/kecil)"; exit 1; }
echo "profil $PROFILE = $PID · mode: $([ "$APPLY" = 1 ] && echo APPLY || echo DRY-RUN)"

if [ "$APPLY" = 1 ]; then umask 077; echo "name,label,deviceId,credentialsType,accessToken,status" > "$OUT"; fi
n_new=0; n_exist=0; n_fail=0
while IFS= read -r LABEL; do
  [ -z "$LABEL" ] && continue
  NAME="$NAME_PREFIX$LABEL"
  ENC=$(jq -rn --arg n "$NAME" '$n|@uri')
  code=$(req GET "$TB/api/tenant/devices?deviceName=$ENC")
  if [ "$code" = 200 ]; then ID=$(jq -r .id.id "$TMP"); ST=EXISTS; n_exist=$((n_exist+1))
  elif [ "$code" = 404 ]; then
    if [ "$APPLY" != 1 ]; then echo "  akan dibuat: $NAME"; n_new=$((n_new+1)); continue; fi
    BODY=$(jq -n --arg n "$NAME" --arg l "$LABEL" --arg p "$PID" '{name:$n,label:$l,deviceProfileId:{entityType:"DEVICE_PROFILE",id:$p}}')
    code=$(req POST "$TB/api/device" "$BODY")
    if [ "$code" != 200 ]; then echo "  GAGAL buat: $NAME (HTTP $code: $(jq -r .message "$TMP" 2>/dev/null))"; n_fail=$((n_fail+1)); continue; fi
    ID=$(jq -r .id.id "$TMP"); ST=CREATED; n_new=$((n_new+1))
  else echo "  GAGAL cek: $NAME (HTTP $code)"; n_fail=$((n_fail+1)); continue; fi
  [ "$APPLY" = 1 ] || { echo "  sudah ada:   $NAME"; continue; }
  code=$(req GET "$TB/api/device/$ID/credentials")
  if [ "$code" != 200 ]; then echo "  GAGAL token: $NAME"; n_fail=$((n_fail+1)); continue; fi
  jq -r --arg n "$NAME" --arg l "$LABEL" --arg id "$ID" --arg st "$ST" '[$n,$l,$id,.credentialsType,.credentialsId,$st] | @csv' "$TMP" >> "$OUT"
done < <(python3 -I -c 'import csv,sys
for r in csv.DictReader(open(sys.argv[1], encoding="utf-8-sig")):
    l = (r.get("label") or "").strip()
    if l: print(l)' "$CSV")

if [ "$APPLY" = 1 ]; then
  echo "selesai: dibuat $n_new · sudah ada $n_exist · gagal $n_fail"
  echo "token tersimpan di $OUT (chmod 600). Ambil dari Mac: scp root@202.10.46.167:$OUT ~/Downloads/"
else
  echo "DRY-RUN: akan dibuat $n_new · sudah ada $n_exist · gagal cek $n_fail. Jalankan lagi dengan APPLY=1 untuk membuat."
fi
