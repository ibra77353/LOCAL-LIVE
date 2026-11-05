#!/bin/sh
# قائمة أجهزة الالتقاط على Linux (V4L2 للفيديو + ALSA للصوت).
# نفس التقرير المتاح على Windows عبر scripts\devices.bat: يمر عبر طبقة الالتقاط
# التي يستخدمها الخادم، فتظهر هنا الأجهزة التي ستظهر في لوحة الإدارة بالضبط.
#   ./scripts/devices.sh             ← الأجهزة + أوضاع كل جهاز فيديو
#   ./scripts/devices.sh --no-caps   ← الأجهزة وحدها (أسرع)
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js not found in PATH (Node 18+ required)."
  exit 1
fi

exec node "$ROOT/scripts/devices.js" "$@"
