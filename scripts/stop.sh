#!/bin/sh
# إيقاف PrinceLive على Linux — النظير لـ scripts\stop.bat على Windows.
# أولاً إغلاق البث عبر واجهة /api/stop برمز run/control.token، ثم Nginx الخاص
# بالمشروع (بالبحث عن العملية التي تحمل بادئة nginx/ داخل المشروع)، ثم خادم Node.
# لا يُوقف أي عملية أخرى: خادم Node يُعرَّف من run/server.pid مع التحقق من سطر
# الأوامر، وNginx من سطر أوامره الذي يحتوي مسار nginx داخل هذا المشروع.
# السجلات logs/ وnginx/logs/ تبقى للمراجعة؛ تُنظَّف مقاطع HLS القديمة فقط.
#   ./scripts/stop.sh
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT" || exit 1

fail() { echo "ERROR: $*"; exit 1; }

if [ ! -f server.js ]; then
  fail "server.js not found. Put this script in the project root or inside scripts/."
fi
command -v node >/dev/null 2>&1 || fail "Node.js not found in PATH."

PORTS=$(node scripts/ports.js 2>/dev/null) || fail "could not read ports from data.json / config.json [scripts/ports.js]."
FW_PORT=${PORTS%% *}
API_PORT=${PORTS##* }

STOP_FAILED=0

# عملية حيّة فعلاً: kill -0 ينجح أيضاً مع العملية الزومبي بعد إنهاء الخادم،
# فنستثني الحالة Z حتى لا يظن السكربت أن الإيقاف فشل.
pid_alive() {
  kill -0 "$1" 2>/dev/null || return 1
  _st=$(sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f1)
  [ "$_st" = "Z" ] && return 1
  return 0
}

server_pid() {
  [ -f run/server.pid ] || return 1
  _pid=$(tr -d ' \r\n' < run/server.pid)
  case "$_pid" in ''|*[!0-9]*) return 1 ;; esac
  pid_alive "$_pid" || return 1
  tr '\0' ' ' < "/proc/$_pid/cmdline" 2>/dev/null | grep -q 'server\.js' || return 1
  echo "$_pid"
}

# معرّفات نسخة Nginx التابعة لهذا المشروع فقط: سطر أوامرها يحمل بادئة
# "$ROOT/nginx/" (مثل: nginx: master process nginx -p /path/nginx/ -c conf/nginx.conf).
project_nginx_pids() {
  for _dir in /proc/[0-9]*; do
    _p=${_dir#/proc/}
    _cmd=$(tr '\0' ' ' < "$_dir/cmdline" 2>/dev/null) || continue
    case "$_cmd" in
      *nginx*"$ROOT/nginx/"*) pid_alive "$_p" && echo "$_p" ;;
    esac
  done
}

# ---- 1) إغلاق البث عبر رمز التحكّم المحلي ----
echo "Requesting stream stop through the local API on port $API_PORT..."
node -e 'const http=require("http"),fs=require("fs");let token="";try{token=fs.readFileSync("run/control.token","utf8").trim()}catch{};if(token.length===0){console.log("run/control.token missing: Node may not be running");process.exit(0)}const r=http.request({host:"127.0.0.1",port:Number(process.argv[1]),path:"/api/stop",method:"POST",timeout:15000,headers:{"X-Control-Token":token,"Content-Length":0}},res=>{let d="";res.on("data",x=>d+=x);res.on("end",()=>console.log("HTTP "+res.statusCode+" "+d));});r.on("error",e=>console.log("API not responding: "+e.message));r.on("timeout",()=>{console.log("API timeout after 15s: stopping Node anyway");r.destroy()});r.end();' "$API_PORT"
echo

# ---- 2) Nginx الخاص بالمشروع فقط ----
NGINX_PIDS=$(project_nginx_pids || true)
if [ -z "$NGINX_PIDS" ]; then
  echo "Prince Live Nginx is not running."
else
  echo "Stopping Prince Live Nginx (port $FW_PORT)..."
  for _p in $NGINX_PIDS; do kill -QUIT "$_p" 2>/dev/null || true; done
  _tries=0
  while [ "$_tries" -lt 10 ]; do
    _tries=$((_tries + 1))
    _left=""
    for _p in $NGINX_PIDS; do pid_alive "$_p" && _left="$_left $_p"; done
    [ -z "$_left" ] && break
    sleep 1
  done
  for _p in $NGINX_PIDS; do pid_alive "$_p" && kill -TERM "$_p" 2>/dev/null || true; done
  _left=""
  for _p in $NGINX_PIDS; do pid_alive "$_p" && _left="$_left $_p"; done
  if [ -n "$_left" ]; then
    echo "ERROR: Prince Live Nginx is still running [PID$_left]. Run this script with sudo."
    STOP_FAILED=1
  else
    echo "Nginx stopped."
  fi
fi

# ---- 3) خادم Node.js الخاص بالمشروع فقط ----
PID=$(server_pid || true)
if [ -z "$PID" ]; then
  echo "Prince Live Node.js is not running."
else
  echo "Stopping Prince Live Node.js [PID $PID]..."
  kill "$PID" 2>/dev/null
  _tries=0
  while [ "$_tries" -lt 10 ]; do
    _tries=$((_tries + 1))
    pid_alive "$PID" || break
    sleep 1
  done
  if pid_alive "$PID"; then
    kill -9 "$PID" 2>/dev/null
    sleep 1
  fi
  if pid_alive "$PID"; then
    echo "ERROR: Prince Live Node.js is still running [PID $PID]."
    STOP_FAILED=1
  else
    rm -f run/server.pid
    echo "Node.js stopped."
  fi
fi

# ---- 4) تنظيف مقاطع HLS القديمة حتى لا يظهر بث متوقف كمباشر ----
if [ -d srv/hls ]; then
  echo "Cleaning srv/hls [stale HLS segments of stopped channels]..."
  find srv/hls -mindepth 1 ! -name '.gitkeep' -delete 2>/dev/null || true
  echo "srv/hls cleaned."
fi

echo "Run logs are kept: logs/server.log and nginx/logs/*.log"
echo
if [ "$STOP_FAILED" -eq 0 ]; then
  echo "Prince Live stopped."
  exit 0
fi
echo "Prince Live did NOT stop completely. Read the errors above."
exit 1
