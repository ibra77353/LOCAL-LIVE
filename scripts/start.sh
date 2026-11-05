#!/bin/sh
# تشغيل PrinceLive على Linux (V4L2 + ALSA) — النظير لـ scripts\start.bat على Windows.
# ينفّذ نفس الخطوات: المجلدات، قراءة المنافذ من scripts/ports.js، تشغيل خادم Node
# والتحقق من /api/status فعلياً، ثم تشغيل Nginx والتحقق من استماعه.
#   ./scripts/start.sh
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT" || exit 1

fail() { echo "ERROR: $*"; exit 1; }

# ---- ملفات المشروع ----
if [ ! -f server.js ]; then
  fail "server.js not found. Put this script in the project root or inside scripts/."
fi
[ -f config.json ] || fail "config.json not found."
command -v node >/dev/null 2>&1 || fail "Node.js not found in PATH (Node 18+ required)."

mkdir -p logs run srv/hls srv/uploads || fail "could not create logs/, run/ or srv/ folders."
mkdir -p nginx/logs nginx/temp/client_body_temp nginx/temp/proxy_temp \
  nginx/temp/fastcgi_temp nginx/temp/uwsgi_temp nginx/temp/scgi_temp >/dev/null 2>&1

# ---- المنافذ: مصدر واحد هو scripts/ports.js (نفس قواعد server.js) ----
PORTS=$(node scripts/ports.js 2>/dev/null) || fail "could not read ports from data.json / config.json [scripts/ports.js]."
FW_PORT=${PORTS%% *}
API_PORT=${PORTS##* }

api_status() {
  node -e 'const http=require("http"),port=Number(process.argv[1]);const r=http.get({host:"127.0.0.1",port:port,path:"/api/status",timeout:2000},res=>{let d="";res.on("data",x=>d+=x);res.on("end",()=>{try{process.exit(JSON.parse(d).ok?0:1)}catch{process.exit(1)}})});r.on("error",()=>process.exit(1));r.on("timeout",()=>{r.destroy();process.exit(1)});' "$API_PORT"
}

port_open() {
  node -e 'const net=require("net"),s=net.connect(Number(process.argv[1]),"127.0.0.1");s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1));s.setTimeout(1500,()=>{s.destroy();process.exit(1)});' "$1"
}

# عملية حيّة فعلاً: العملية الزومبي تُعدّ منتهية حتى لا يُظن أن التشغيل ما زال قائماً.
pid_alive() {
  kill -0 "$1" 2>/dev/null || return 1
  _st=$(sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f1)
  [ "$_st" = "Z" ] && return 1
  return 0
}

# عملية الخادم تُعرَّف بملف run/server.pid الذي يكتبه server.js، ويُتحقق من أن
# سطر أوامرها يشغّل server.js فعلاً حتى لا يُوقف خادم آخر يستخدم المنفذ نفسه.
server_pid() {
  [ -f run/server.pid ] || return 1
  _pid=$(tr -d ' \r\n' < run/server.pid)
  case "$_pid" in ''|*[!0-9]*) return 1 ;; esac
  pid_alive "$_pid" || return 1
  tr '\0' ' ' < "/proc/$_pid/cmdline" 2>/dev/null | grep -q 'server\.js' || return 1
  echo "$_pid"
}

# معرّفات نسخة Nginx التابعة لهذا المشروع فقط (سطر أوامرها يحمل "$ROOT/nginx/").
project_nginx_pids() {
  for _dir in /proc/[0-9]*; do
    _p=${_dir#/proc/}
    _cmd=$(tr '\0' ' ' < "$_dir/cmdline" 2>/dev/null) || continue
    case "$_cmd" in
      *nginx*"$ROOT/nginx/"*) pid_alive "$_p" && echo "$_p" ;;
    esac
  done
}

# ---- خادم Node.js: لا نعلن النجاح قبل أن يجيب الخادم فعلياً ----
NODE_PID=$(server_pid || true)
if [ -n "$NODE_PID" ]; then
  echo "OK: Node API is already running [PID $NODE_PID] on port $API_PORT."
else
  if port_open "$API_PORT"; then
    echo "ERROR: port $API_PORT is already used by another program."
    echo "       The Prince Live API was NOT started. Close that program or change the port."
    exit 1
  fi
  echo "Starting Prince Live API on port $API_PORT..."
  nohup node "$ROOT/server.js" >> "$ROOT/logs/server.out" 2>&1 &
  _tries=0
  while [ "$_tries" -lt 30 ]; do
    _tries=$((_tries + 1))
    api_status && break
    sleep 1
  done
  if api_status; then
    echo "OK: Node API is running on port $API_PORT."
  else
    echo "ERROR: the Prince Live API did not answer on port $API_PORT within 30 seconds."
    echo "       Read logs/server.log and logs/server.out for the reason."
    exit 1
  fi
fi

# ---- خدمة Nginx (نظامية على Linux؛ حزمة nginx/conf تبقى مستخدمة كما على Windows) ----
if command -v nginx >/dev/null 2>&1; then
  if ! nginx -p "$ROOT/nginx/" -c conf/nginx.conf -t; then
    echo "ERROR: Nginx configuration test failed (nginx -t). See nginx/logs/error.log"
    exit 1
  fi
  NGINX_PIDS=$(project_nginx_pids || true)
  if [ -n "$NGINX_PIDS" ]; then
    echo "OK: Nginx is already running [PID $(echo $NGINX_PIDS)] on port $FW_PORT."
  elif port_open "$FW_PORT"; then
    echo "ERROR: port $FW_PORT is already used by another program, not this project's Nginx."
    echo "       The Prince Live Nginx was NOT started. Stop that program or change settings.nginxPort."
    exit 1
  else
    echo "Starting Nginx on port $FW_PORT..."
    if nginx -p "$ROOT/nginx/" -c conf/nginx.conf; then
      _tries=0
      while [ "$_tries" -lt 10 ]; do
        _tries=$((_tries + 1))
        port_open "$FW_PORT" && break
        sleep 1
      done
      if port_open "$FW_PORT"; then
        echo "OK: Nginx is listening on port $FW_PORT."
      else
        echo "ERROR: Nginx is not listening on port $FW_PORT. Check nginx/logs/error.log"
        exit 1
      fi
    else
      echo "ERROR: Nginx failed to start."
      echo "       Ports below 1024 need root: run with sudo, or set settings.nginxPort in data.json."
      exit 1
    fi
  fi
else
  echo "WARNING: nginx not found in PATH. The viewer is served by Node.js only (port $API_PORT)."
  echo "         Install it with: sudo apt install nginx"
fi

echo
echo "---------------------------------------------"
echo "Local UI:  http://127.0.0.1:$API_PORT"
echo "Nginx UI:  http://127.0.0.1:$FW_PORT/"
echo "---------------------------------------------"
echo "Prince Live is running."
