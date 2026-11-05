#!/bin/sh
# فحص المشروع على Linux قبل التشغيل — النظير لـ scripts\check.bat على Windows.
# يتحقق من Node، وصيغة JavaScript، وسلامة JSON، واتساق الإعدادات والحزمة
# (scripts/verify-v8.js)، ثم يطبع قائمة أجهزة الالتقاط كما يراها الخادم.
#   ./scripts/check.sh
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT" || exit 1

fail() {
  echo
  echo "A check failed: $*"
  exit 1
}

echo "[1/5] Checking Node.js..."
command -v node >/dev/null 2>&1 || fail "Node.js not found in PATH."
node -v

echo "[2/5] Checking JavaScript syntax..."
for file in server.js web/admin.js web/viewer.js scripts/ports.js scripts/procs.js \
  scripts/test-stop.js scripts/verify-v8.js scripts/devices.js; do
  [ -f "$file" ] || fail "missing file: $file"
  node --check "$file" || fail "syntax error in $file"
done

echo "[3/5] Checking JSON files..."
node -e "const fs=require('fs');JSON.parse(fs.readFileSync('config.json','utf8').replace(/^\uFEFF/,''));JSON.parse(fs.readFileSync('data.json','utf8').replace(/^\uFEFF/,''));console.log('JSON OK')" \
  || fail "config.json or data.json is not valid JSON."

echo "[4/5] Checking settings and package consistency..."
node scripts/verify-v8.js || fail "scripts/verify-v8.js reported problems."

echo "[5/5] Listing capture devices..."
node scripts/devices.js --no-caps || echo "WARNING: device scan failed — read the message above."

PORTS=$(node scripts/ports.js 2>/dev/null || true)
if [ -n "$PORTS" ]; then
  set -- $PORTS
  echo
  echo "Ports from data.json: nginx=$1 node=$2"
fi

echo
echo "All static checks passed. This does not test physical capture devices or live FFmpeg output."
