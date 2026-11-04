'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const os = require('os');
const net = require('net');
const crypto = require('crypto');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
} catch (err) {
  console.error(`تعذر قراءة config.json: ${err.message}`);
  process.exit(1);
}

// المسارات قابلة للتجاوز بمتغيرات بيئة اختيارية حتى يمكن تشغيل الخادم من
// حزمة للقراءة فقط أو من حاوية، مع بقاء القيم الافتراضية كما في Windows.
const HLS_DIR = path.resolve(process.env.HLS_ROOT || path.join(ROOT, cfg.hlsRoot || 'srv/hls'));
const WEB_DIR = path.join(ROOT, 'web');
const UPLOADS_DIR = path.resolve(process.env.UPLOADS_ROOT || path.join(ROOT, 'srv', 'uploads'));
const LOG_DIR = path.resolve(process.env.LOG_DIR || path.join(ROOT, 'logs'));
const SERVER_LOG = path.join(LOG_DIR, 'server.log');
if (process.env.FFMPEG_PATH) cfg.ffmpegPath = process.env.FFMPEG_PATH;
if (process.env.FFPROBE_PATH) cfg.ffprobePath = process.env.FFPROBE_PATH;

// ffmpegPath في config.json قد يكون اسماً مجرداً مثل "ffmpeg" مع أن الحزمة تحمل
// ffmpeg.exe بجانب server.js؛ الاعتماد على PATH كان يفشل بـ ENOENT إذا شُغّل
// الخادم من مجلد آخر. نحل الاسم إلى الملف المرفق إن وُجد ثم نترك PATH كبديل.
function resolveTool(toolName) {
  const value = String(toolName || '').trim();
  if (!value || path.isAbsolute(value)) return value;
  const names = process.platform === 'win32' ? [value, `${value}.exe`] : [value];
  for (const name of names) {
    const candidate = path.join(ROOT, name);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return value;
}
function ffmpegBin() { return resolveTool(cfg.ffmpegPath); }

const streams = new Map(); // channelId -> independent FFmpeg runtime
let ffmpegLog = '';
let lastExit = null;
let servedBytes = 0;
const viewerSessions = new Map();
let previousCpu = os.cpus().map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a,b) => a+b, 0) }));
let cpuPercent = null;
let egressBps = 0;
let totalViewerCount = 0;
let lastServedSample = { bytes: 0, at: Date.now() };

// API model: persisted locally in data.json. This release runs one capture pipeline
// (one physical DirectShow input) and exposes it as a configurable channel.
// data.json هو المصدر الوحيد للحالة: settings + sources + channels.
const DATA_PATH = path.resolve(process.env.DATA_FILE || path.join(ROOT, 'data.json'));
// الإعدادات فقط هي الافتراضية؛ لا تُنشأ مصادر أو قنوات تلقائياً عند أول تشغيل.
function defaultData() {
  return {
    settings: {
      siteName: cfg.siteName || 'البرنس لايف',
      siteNameLatin: cfg.siteNameLatin || 'BRINCE Live',
      phone: cfg.phone || '',
      ticker: cfg.ticker || 'أهلاً بكم في البرنس لايف — البث المباشر المحلي',
      tickerEnabled: cfg.tickerEnabled !== false,
      logo: cfg.logo || 'logo.png',
      theme: cfg.theme || 'default',
      autoStartOnDemand: !!cfg.autoStartOnDemand,
      playerMaxBufferLength: Number(cfg.playerMaxBufferLength) || 20,
      playerBackBufferLength: Number(cfg.playerBackBufferLength) || 10,
      playerLiveSyncDuration: Number(cfg.playerLiveSyncDuration) || 4,
      capLevelToPlayerSize: cfg.capLevelToPlayerSize !== false,
      cpuSaverDefault: !!cfg.cpuSaverDefault,
      ffmpegPath: cfg.ffmpegPath || 'ffmpeg', ffprobePath: cfg.ffprobePath || 'ffprobe', nginxPath: cfg.nginxPath || 'nginx/nginx.exe',
      x264QualityMode: !!cfg.x264QualityMode,
      outputWidth: Number(cfg.outputWidth) || 640,
      outputHeight: Number(cfg.outputHeight) || 360,
      outputFps: Number(cfg.outputFps) || 20,
      gopSeconds: Number(cfg.gopSeconds) || 2,
      startupQueueDelayMs: Number(cfg.startupQueueDelayMs) || 8000,
      startupConcurrency: Number(cfg.startupConcurrency) || 1,
      x264Preset: cfg.preset || 'veryfast',
      x264Threads: Number(cfg.threads) || 2,
      hlsTime: Number(cfg.hlsTime) || 2,
      hlsListSize: Number(cfg.hlsListSize) || 6,
      hlsDeleteThreshold: Number(cfg.hlsDeleteThreshold) || 4,
      port: Number(cfg.port)||3001, nginxPort: Number(cfg.nginxPort)||80,
      autoRestartCrashed: cfg.autoRestart !== false,
      hideCosmeticLogs: cfg.hideCosmeticLogs !== false,
      maxRestarts: Number(cfg.maxRestarts) || 20,
      restartBackoffMs: Number(cfg.restartDelayMs) || 5000,
      idleStopEnabled: !!cfg.idleStopEnabled,
      idleStopMinutes: Number(cfg.idleStopMinutes) || 2,
      sourceFailStopMinutes: Number(cfg.sourceFailStopMinutes) || 3,
      blockedStopMinutes: Number(cfg.blockedStopMinutes) || 1000,
      streamUserAgent: cfg.streamUserAgent || 'VLC/3.0.20 LibVLC/3.0.20',
      logoImage: cfg.logoImage || '', logoPosition: cfg.logoPosition || 'top-right',
      logoSizePct: Number(cfg.logoSizePct) || 10, logoOpacityPct: Number(cfg.logoOpacityPct) || 50,
    },
    sources: [],
    channels: []
  };
}
function readData() {
  try {
    const value = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8').replace(/^\uFEFF/, ''));
    if (!value.settings || !Array.isArray(value.sources) || !Array.isArray(value.channels)) throw new Error('invalid data schema');
    return value;
  } catch {
    const value = defaultData();
    writeData(value);
    return value;
  }
}
function writeData(value) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  const temp = DATA_PATH + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, DATA_PATH);
}
let data = readData();
if (Object.prototype.hasOwnProperty.call(data.settings,'ads')) delete data.settings.ads;
// حقول قنوات ملغاة من المخطط (لا يقرأها أي كود): threads و manualStopped.
// تُحذف من data.json عند الإقلاع حتى تتطابق الملفات القديمة مع المخطط الحالي.
let prunedChannelFields = false;
for (const channel of data.channels) {
  for (const key of ['threads', 'manualStopped']) {
    if (Object.prototype.hasOwnProperty.call(channel, key)) { delete channel[key]; prunedChannelFields = true; }
  }
}
if (prunedChannelFields) writeData(data);
data.settings = { ...defaultData().settings, ...data.settings };
Object.assign(cfg, {
  ffmpegPath: data.settings.ffmpegPath ?? cfg.ffmpegPath,
  ffprobePath: data.settings.ffprobePath ?? cfg.ffprobePath,
  port:data.settings.port ?? cfg.port, nginxPort:data.settings.nginxPort ?? cfg.nginxPort,
  outputWidth: data.settings.outputWidth ?? cfg.outputWidth,
  outputHeight: data.settings.outputHeight ?? cfg.outputHeight,
  outputFps: data.settings.outputFps ?? cfg.outputFps,
  preset: data.settings.x264Preset ?? cfg.preset,
  threads: data.settings.x264Threads ?? cfg.threads,
  hlsTime: data.settings.hlsTime ?? cfg.hlsTime,
  hlsListSize: data.settings.hlsListSize ?? cfg.hlsListSize,
  autoRestart: data.settings.autoRestartCrashed ?? cfg.autoRestart,
  maxRestarts: data.settings.maxRestarts ?? cfg.maxRestarts,
  restartDelayMs: data.settings.restartBackoffMs ?? cfg.restartDelayMs
});
function activeChannel() { return data.channels.find(c => c.enabled !== false) || data.channels[0] || null; }
function sourceForChannel(channel = activeChannel()) { return channel ? (data.sources.find(x => x.id === channel.sourceId) || null) : null; }
function channelRuntime(channelId) { return streams.get(channelId) || null; }
function channelHlsDir(channel) { return path.join(HLS_DIR, channel.id); }
function playlistPath(channel) { return path.join(channelHlsDir(channel), 'index.m3u8'); }
// مسارات الملفات المرفوعة تُخزَّن كما في الحزمة (srv/uploads/x) وتُعرض عبر /uploads/x.
function publicAsset(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:/i.test(raw) || raw.startsWith('/uploads/')) return raw;
  return '/' + raw.replace(/^\.?\/+/, '').replace(/^srv\/uploads\/?/, 'uploads/');
}
function isCopyQuality(q) { const v = String(q || '').toLowerCase(); return v === 'source' || v === 'copy'; }
function publicChannel(channel) {
  const source = sourceForChannel(channel);
  const runtime = channelRuntime(channel.id);
  let playlistExists = false, playlistAgeMs = null;
  try { const st = fs.statSync(playlistPath(channel)); playlistExists = st.isFile(); playlistAgeMs = Date.now() - st.mtimeMs; } catch {}
  const live = !!(channel.enabled && runtime?.proc && playlistExists && playlistAgeMs < 15000);
  const viewers = [...viewerSessions.values()].filter(v => v.channelId === channel.id && Date.now()-v.lastSeen <= 45000).length;
  const lastErrorText = runtime?.lastExit || '';
  return { ...channel, chanId: channel.chanId || channel.id, sort: Number(channel.sortOrder) || 0,
    url: `/hls/${channel.id}/index.m3u8`, cover: publicAsset(channel.cover),
    device: source?.videoDevice || '', sourceName: source?.name || '', live,
    status: live ? 'running' : (!channel.enabled ? 'stopped' : (runtime?.proc ? 'starting' : (runtime?.lastExit ? 'error' : 'stopped'))),
    state: live ? 'running' : 'stopped', pid: runtime?.proc?.pid || null, viewers, restarts: runtime?.restartCount || 0,
    lastErrorText,
    lastError: lastErrorText ? { text: lastErrorText, severity: /exit|error|فشل|تعذر/i.test(lastErrorText) ? 'high' : 'low' } : null,
    lastErrors: lastErrorText ? [lastErrorText] : [], bytesOut: 0 };
}

function readBody(req, maxBytes=1024*1024) {
  return new Promise((resolve, reject) => {
    let raw = ''; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > maxBytes) { reject(new Error('حجم الطلب كبير')); req.destroy(); return; } raw += chunk; });
    req.on('end', () => { if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON غير صالح')); } });
    req.on('error', reject);
  });
}
// اختبار رابط بث: يقرأ الترويسات وأول بايتات ليحدد نوع المصدر (m3u8/ts/آخر).
function probeStreamUrl(target) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(target); } catch { return reject(new Error('صيغة الرابط غير صحيحة')); }
    const client = parsed.protocol === 'https:' ? require('https') : require('http');
    const request = client.get(parsed, { timeout: 10000, headers: { 'User-Agent': data.settings.streamUserAgent || 'PrinceLive' } }, response => {
      const contentType = String(response.headers['content-type'] || '');
      let preview = '';
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        const kind = /mpegurl/i.test(contentType) || preview.includes('#EXTM3U') ? 'm3u8'
          : (/mp2t|octet-stream/i.test(contentType) ? 'ts' : 'other');
        resolve({ status: response.statusCode, statusText: response.statusMessage || '', contentType, preview: preview.slice(0, 2000), kind });
      };
      response.setEncoding('utf8');
      response.on('data', chunk => { preview += chunk; if (preview.length >= 2000) { finish(); response.destroy(); } });
      response.on('end', finish);
      response.on('close', finish);
      response.on('error', finish);
    });
    request.on('timeout', () => request.destroy(new Error('انتهت مهلة الاتصال بالرابط')));
    request.on('error', reject);
  });
}

function readRawBody(req, maxBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > maxBytes) { reject(new Error('حجم الملف أكبر من المسموح')); req.destroy(); return; } chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
// تحليل بسيط لطلب multipart/form-data دون مكتبات خارجية (رفع الشعار والغلاف والنسخة الاحتياطية).
function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  if (!match) return [];
  const boundary = Buffer.from('--' + (match[1] || match[2]).trim());
  const parts = [];
  let index = buffer.indexOf(boundary);
  while (index !== -1) {
    const start = index + boundary.length;
    const next = buffer.indexOf(boundary, start);
    if (next === -1) break;
    let chunk = buffer.slice(start, next);
    if (chunk.slice(0, 2).toString() === '\r\n') chunk = chunk.slice(2);
    if (chunk.slice(-2).toString() === '\r\n') chunk = chunk.slice(0, -2);
    const headerEnd = chunk.indexOf('\r\n\r\n');
    if (headerEnd > -1) {
      const headers = chunk.slice(0, headerEnd).toString('utf8');
      parts.push({
        name: (/name="([^"]*)"/i.exec(headers) || [])[1] || '',
        filename: (/filename="([^"]*)"/i.exec(headers) || [])[1] || '',
        type: (/content-type:\s*([^\r\n]+)/i.exec(headers) || [])[1] || '',
        data: chunk.slice(headerEnd + 4)
      });
    }
    index = next;
  }
  return parts;
}
function safeUploadName(filename) {
  const base = path.basename(String(filename || 'file')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
  const ext = path.extname(base).toLowerCase();
  const allowed = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.json'];
  const name = allowed.includes(ext) ? base : base + '.bin';
  return `${Date.now()}_${name}`;
}
function apiError(res, code, message) { return send(res, code, { ok: false, error: message, message }); }
function safeId(value) { return /^[a-zA-Z0-9_-]{1,80}$/.test(String(value || '')); }
function getNetworkInterfaces() {
  const result = [];
  const all = os.networkInterfaces();
  for (const [name, addresses] of Object.entries(all)) {
    for (const item of (addresses || [])) {
      if (item.family !== 'IPv4' || item.internal || !item.address || item.address.startsWith('169.254.')) continue;
      // عناوين المحوّلات الافتراضية (Hyper-V/WSL/VMware...) لا تُفتح من أجهزة الشبكة،
      // فإظهارها بين روابط المشاهدة يجعل المستخدم يجرّب رابطاً لا يعمل من جهاز آخر.
      if (/vEthernet|VirtualBox|VMware|Hyper-V|Loopback|WSL|Docker|TAP-|Tailscale|ZeroTier/i.test(name)) continue;
      result.push({ name, address: item.address, netmask: item.netmask || '', cidr: item.cidr || '', url: `http://${item.address}/`, adminUrl: `http://${item.address}/admin` });
    }
  }
  return result.sort((a, b) => {
    const rank = x => /wi-?fi|wireless/i.test(x.name) ? 0 : /ethernet/i.test(x.name) ? 1 : 2;
    return rank(a) - rank(b) || a.name.localeCompare(b.name) || a.address.localeCompare(b.address);
  });
}
// حساب الإدارة: كلمة المرور مشفّرة بـ scrypt(salt) داخل cfg.admin،
// مع السماح بالحقول القديمة adminUsername/adminPassword وبـ defaultPassword.
function adminAccount() {
  const admin = cfg.admin || {};
  return {
    user: String(admin.user || cfg.adminUsername || 'admin'),
    salt: String(admin.salt || ''),
    hash: String(admin.hash || '').toLowerCase()
  };
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// كلمة مرور واحدة فقط: مطابقة hash(scrypt) مع salt من config.json.
function isAdminPassword(password) {
  const account = adminAccount();
  if (!account.salt || !account.hash) return false;
  try {
    return sameSecret(crypto.scryptSync(password, account.salt, 32).toString('hex'), account.hash);
  } catch { return false; }
}

// جلسة لوحة التحكم: كوكي HttpOnly موقّع بمفتاح مشتق من حساب الإدارة في config.json،
// فلا حاجة لملف أسرار إضافي. تسجيل الدخول بالجلسة هو الطريقة الوحيدة للمصادقة؛
// لا يوجد Basic Auth، وسكربتات الإيقاف المحلية تستخدم رمز التحكّم في run/control.token.
const ADMIN_COOKIE = 'pl_admin';
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
// رمز تحكّم محلي بديل عن Basic Auth: يُكتب في run/control.token عند كل تشغيل،
// ويُقبل فقط في طلبات 127.0.0.1 التي تحمله في ترويسة X-Control-Token، حتى تستطيع
// scripts/stop.bat إيقاف البث بأمان دون كلمة مرور مكتوبة داخل السكربت.
const RUN_DIR = path.join(ROOT, 'run');
const CONTROL_TOKEN_FILE = path.join(RUN_DIR, 'control.token');
const CONTROL_TOKEN = crypto.randomBytes(24).toString('hex');
function sessionKey() {
  const account = adminAccount();
  return crypto.createHash('sha256').update(`prince-live-session:${account.user}:${account.hash}:${account.salt}`).digest();
}
function issueSessionToken() {
  const exp = String(Date.now() + ADMIN_SESSION_TTL_MS);
  return `${exp}.${crypto.createHmac('sha256', sessionKey()).update(exp).digest('hex')}`;
}
function isValidSessionToken(token) {
  const [exp, mac] = String(token || '').split('.');
  if (!exp || !mac || !Number.isFinite(Number(exp)) || Number(exp) < Date.now()) return false;
  return sameSecret(mac, crypto.createHmac('sha256', sessionKey()).update(exp).digest('hex'));
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    try { out[name] = decodeURIComponent(part.slice(index + 1).trim()); } catch { out[name] = ''; }
  }
  return out;
}
function hasAdminSession(req) { return isValidSessionToken(parseCookies(req)[ADMIN_COOKIE]); }
function setAdminSession(req, res) {
  const secure = String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=${issueSessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ADMIN_SESSION_TTL_MS / 1000}${secure}`);
}
function clearAdminSession(res) {
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
// تغيير كلمة المرور: يُكتب salt/hash الجديدان في config.json فقط (لا يمسّ data.json)،
// وتُلغى كل الجلسات القديمة تلقائياً لأن مفتاح التوقيع مشتق من hash+salt.
function setAdminPassword(password) {
  const user = adminAccount().user;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`تعذر قراءة config.json: ${err.message}`);
  }
  stored.admin = { ...(stored.admin || {}), user, salt, hash };
  delete stored.admin.defaultPassword;
  delete stored.adminUsername;
  delete stored.adminPassword;
  const temp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(stored, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, CONFIG_PATH);
  cfg.admin = stored.admin;
  delete cfg.adminUsername;
  delete cfg.adminPassword;
}
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}
// حد بسيط لمحاولات الدخول الفاشلة: 8 محاولات لكل عنوان خلال 10 دقائق.
const loginFailures = new Map();
function loginBlocked(ip) {
  const record = loginFailures.get(ip);
  if (!record) return false;
  if (Date.now() - record.first > 10 * 60 * 1000) { loginFailures.delete(ip); return false; }
  return record.count >= 8;
}
function noteLoginFailure(ip) {
  const record = loginFailures.get(ip);
  if (!record || Date.now() - record.first > 10 * 60 * 1000) loginFailures.set(ip, { count: 1, first: Date.now() });
  else record.count += 1;
}

function isLoopback(req) {
  const address = String((req.socket && req.socket.remoteAddress) || '');
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
// المصادقة: جلسة اللوحة فقط (لا Basic Auth). الاستثناء الوحيد رمز التحكّم المحلي
// في run/control.token لسكربتات الجهاز نفسه، ولا يُقبل إلا من 127.0.0.1.
function isAdminAuthorized(req) {
  if (hasAdminSession(req)) return true;
  const token = String(req.headers['x-control-token'] || '');
  return !!token && isLoopback(req) && sameSecret(token, CONTROL_TOKEN);
}
function requireAdmin(req, res) {
  if (isAdminAuthorized(req)) return true;
  apiError(res, 401, 'يجب تسجيل الدخول إلى لوحة التحكم');
  return false;
}

fs.mkdirSync(HLS_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });
// يُحدَّث رمز التحكّم عند كل تشغيل ليقرأه scripts/stop.bat من نفس الجهاز.
try {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(CONTROL_TOKEN_FILE, CONTROL_TOKEN, 'utf8');
} catch (err) {
  console.error(`تعذر كتابة ${CONTROL_TOKEN_FILE}: ${err.message}`);
}

function safeText(value) {
  return String(value ?? '').replace(/[\r\n]/g, ' ').slice(0, 1000);
}

// هوية طالب الأمر في السجل: IP حقيقي (خلف Nginx) + المتصفح + المسار،
// لتتبّع أوامر تشغيل/إيقاف القنوات القادمة من أجهزة خارجية بدقة.
function clientInfo(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || String(req.headers['x-real-ip'] || '').trim() || req.socket?.remoteAddress || 'غير معروف';
  return `IP ${ip} | ${safeText(req.headers['user-agent'] || 'بدون وكيل')} | ${req.method} ${req.url}`;
}

function logLine(message) {
  const line = `[${new Date().toISOString()}] ${safeText(message)}`;
  console.log(line);
  ffmpegLog = (ffmpegLog + line + '\n').slice(-20000);
  try {
    fs.appendFileSync(SERVER_LOG, line + '\n', 'utf8');
  } catch (err) {
    console.error(`تعذر الكتابة إلى سجل الخادم: ${err.message}`);
  }
}

// سجل مستقل لكل قناة لعرضه وتصفيته وتنزيله من لوحة التحكم.
const channelLogs = new Map();
function appendChannelLog(channelId, message) {
  const line = `[${new Date().toISOString()}] ${safeText(message)}`;
  channelLogs.set(channelId, ((channelLogs.get(channelId) || '') + line + '\n').slice(-40000));
}

// تحذيرات FFmpeg الشكلية (لا تعني فشلاً): تظهر عند كل تشغيل/إيقاف لبطاقة التقاط
// MJPEG، وتُخفى من السجل عند تفعيل «إخفاء التحذيرات التجميلية» في الإعدادات.
const COSMETIC_FFMPEG_RE = /deprecated pixel format used|Guessed Channel Layout|Found EOI before any SOF|No JPEG data found in image|message repeated \d+ times/i;
// «Error submitting packet to decoder» يُعد شكلياً فقط حين يكون نتيجة الإطار المقطوع
// من بطاقة MJPEG نفسها، لا حين يأتي منفرداً (حينها قد يعني مصدراً تالفاً فعلاً).
const MJPEG_CONTEXT_RE = /mjpeg|Found EOI|No JPEG data/i;
function isCosmeticFfmpegLine(line) {
  const l = String(line).trim();
  return COSMETIC_FFMPEG_RE.test(l) || (/Error submitting packet to decoder/i.test(l) && MJPEG_CONTEXT_RE.test(l));
}
// FFmpeg يرسل عدة سطور في دفعة واحدة، لذلك نفلتر سطراً بسطر: تُحذف السطور
// التجميلية فقط ويبقى أي سطر خطأ حقيقي في نفس الدفعة ظاهراً.
function filterCosmeticFfmpegLines(chunk) {
  return String(chunk).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !isCosmeticFfmpegLine(l)).join('\n');
}

// فحص خفيف: هل هناك خدمة تستمع فعلياً على منفذ Nginx؟
let nginxListening = false;
function probeNginxPort() {
  const port = Number(data.settings.nginxPort) || 80;
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.setTimeout(800);
  socket.once('connect', () => { nginxListening = true; socket.destroy(); });
  socket.once('timeout', () => { nginxListening = false; socket.destroy(); });
  socket.once('error', () => { nginxListening = false; socket.destroy(); });
}

function send(res, code, data) {
  if (res.headersSent) return;
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function getStatus(channelId) {
  const channel = channelId ? data.channels.find(c => c.id === channelId) : activeChannel();
  const nginxPort = Number(data.settings.nginxPort) || 80;
  const base = {
    siteName: data.settings.siteName || cfg.siteName || 'البرنس لايف',
    nginx: nginxListening,
    nginxBinding: { listening: nginxListening, port: nginxPort, reason: nginxListening ? '' : `لم يستجب أي خدمة على المنفذ ${nginxPort}` },
    uptime: Math.floor(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    license: { valid: true, plan: 'محلي' },
    messages: []
  };
  if (!channel) return { ...base, ticker: data.settings.ticker || cfg.ticker || '', running: false, playlistExists: false, channels: data.channels.map(publicChannel) };
  const source = sourceForChannel(channel), runtime = channelRuntime(channel.id);
  let playlistExists = false, playlistAgeMs = null;
  try { const st = fs.statSync(playlistPath(channel)); playlistExists = st.isFile(); playlistAgeMs = Date.now() - st.mtimeMs; } catch {}
  return { ...base, ticker: data.settings.ticker || cfg.ticker || '',
    running: !!runtime?.proc, pid: runtime?.proc?.pid || null, startedAt: runtime?.startedAt || null,
    restartCount: runtime?.restartCount || 0, lastExit: runtime?.lastExit || null, playlistExists, playlistAgeMs,
    streamUrl: `/hls/${channel.id}/index.m3u8`, sourceType: source?.type || '', videoDevice: source?.videoDevice || '', audioDevice: source?.audioDevice || '',
    audioEnabled: !!source?.audioDevice, outputWidth: Number(data.settings.outputWidth) || 640,
    outputHeight: Number(String(channel.quality || '').replace(/p$/i,'')) || Number(data.settings.outputHeight) || 360,
    outputFps: Number(channel.fps) || Number(data.settings.outputFps) || 20, videoBitrate: channel.bitrate || '',
    channel: { id: channel.id, name: channel.name, enabled: channel.enabled !== false }, channels: data.channels.map(publicChannel) };
}
function clearChannelHls(channel) {
  const dir = channelHlsDir(channel); fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) if (/\.(ts|m3u8|m4s|mp4)$/i.test(name)) { try { fs.unlinkSync(path.join(dir,name)); } catch {} }
}

function syncNginxPorts(){
  const file=path.join(ROOT,'nginx','conf','nginx.conf');
  try{
    if(!fs.existsSync(file))return false;
    let text=fs.readFileSync(file,'utf8');
    text=text.replace(/(listen\s+)\d+(\s*;)/,`$1${Number(data.settings.nginxPort)||80}$2`);
    text=text.replace(/(proxy_pass\s+http:\/\/127\.0\.0\.1:)\d+(\s*;)/g,`$1${Number(data.settings.port)||3001}$2`);
    // تنقية نسخ قديمة من nginx.conf: reuseport غير مدعوم في بناء ويندوز،
    // وكتلة types المكررة (موجودة في mime.types) تنتج تحذير duplicate extension.
    text=text.replace(/\s+reuseport\b/g,'');
    text=text.replace(/[ \t]*types\s*\{[^}]*m3u8[^}]*\}[ \t]*\r?\n/,'');
    fs.writeFileSync(file,text,'utf8');return true;
  }catch(err){logLine(`تعذر تحديث منافذ Nginx: ${err.message}`);return false;}
}

function validateNetworkStreamUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 4096 || /[\r\n\0]/.test(raw)) throw new Error('أدخل رابط بث شبكي صالحًا');
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('صيغة رابط البث غير صحيحة'); }
  if (!['http:', 'https:', 'rtsp:'].includes(parsed.protocol)) throw new Error('المصدر الشبكي يدعم HTTP وHTTPS وRTSP فقط');
  if (!parsed.hostname) throw new Error('عنوان المضيف في رابط البث غير موجود');
  return parsed.toString();
}

// توحيد أنواع المصادر القادمة من اللوحة (usb/http/hls/file/screen) إلى أنواع الخادم.
function normalizeSourceType(value) {
  const raw = String(value || 'usb').toLowerCase();
  const map = { usb: 'usb', http: 'http-hls', hls: 'http-hls', 'http-hls': 'http-hls', network: 'http-hls', rtsp: 'rtsp', file: 'file', screen: 'screen' };
  return map[raw] || '';
}
// يطبّق حقول نموذج المصدر على كائن المصدر ويعيد نص الخطأ أو '' عند النجاح.
function applySourceFields(source, body) {
  const has = key => Object.prototype.hasOwnProperty.call(body, key);
  if (has('name') && String(body.name || '').trim()) source.name = String(body.name).trim().slice(0, 100);
  if (has('videoDevice')) source.videoDevice = String(body.videoDevice || '').slice(0, 300);
  if (has('videoDeviceLabel')) source.videoDeviceLabel = String(body.videoDeviceLabel || '').slice(0, 200);
  if (has('audioDevice')) source.audioDevice = String(body.audioDevice || '').slice(0, 300);
  if (has('videoSize')) source.videoSize = String(body.videoSize || '').slice(0, 20);
  if (has('fps')) source.fps = body.fps ? Number(body.fps) : null;
  if (has('pixelFormat')) source.pixelFormat = String(body.pixelFormat || '').slice(0, 30);
  if (has('vcodec')) source.vcodec = String(body.vcodec || '').slice(0, 30);
  if (has('captureSafeMode')) source.captureSafeMode = !!body.captureSafeMode;
  if (has('enabled')) source.enabled = body.enabled !== false;
  if (source.type === 'usb') {
    if (!String(source.videoDevice || '').trim()) return 'جهاز الفيديو مطلوب لمصدر USB';
  } else if (source.type === 'http-hls' || source.type === 'rtsp') {
    const raw = has('url') ? body.url : (has('streamUrl') ? body.streamUrl : (source.streamUrl || ''));
    try { source.streamUrl = validateNetworkStreamUrl(raw); } catch (e) { return e.message; }
  } else if (source.type === 'file') {
    const raw = has('path') ? body.path : (source.path || '');
    const value = String(raw || '').trim();
    if (!value) return 'مسار الملف مطلوب لمصدر الملف المحلي';
    source.path = value.slice(0, 1000);
  }
  return '';
}

function buildArgs(channel, forceTranscode = false) {
  const source = sourceForChannel(channel);
  if (!channel || channel.enabled === false) throw new Error('القناة غير موجودة أو معطلة');
  if (!source || source.enabled === false) throw new Error('مصدر البث غير موجود أو معطل');
  const settings = data.settings;
  const [srcW, srcH] = String(source.videoSize || cfg.videoSize || '1280x720').split('x').map(Number);
  const outputHeight = isCopyQuality(channel.quality) ? (srcH || 720) : Number(String(channel.quality || '').replace(/p$/i,'')) || 360;
  const derivedWidth=Math.max(160,Math.round((srcW||1280)*outputHeight/(srcH||720)/2)*2);
  const configuredWidth=Number(settings.outputWidth)||640;
  const outputWidth=isCopyQuality(channel.quality)?(srcW||1280):(outputHeight===(Number(settings.outputHeight)||360)?configuredWidth:derivedWidth);
  const outputFps = Number(channel.fps) || Number(settings.outputFps) || 20;
  const videoBitrate = String(channel.bitrate || (outputHeight >= 720 ? '2000k' : outputHeight >= 480 ? '1000k' : '500k'));
  const hlsTime = Number(settings.hlsTime) || 2;
  const gop = Math.max(1, Math.round(outputFps * (Number(settings.gopSeconds) || hlsTime)));
  const sourceType = String(source.type || 'usb').toLowerCase();
  const isNetwork = ['http-hls','http','hls','network','rtsp'].includes(sourceType);
  const audioDevice = source.audioDevice || '';
  const args = ['-hide_banner','-loglevel','warning','-thread_queue_size','512'];
  if (isNetwork) {
    const streamUrl = validateNetworkStreamUrl(source.streamUrl || source.url || '');
    args.push('-rw_timeout','15000000');
    if (sourceType !== 'rtsp') args.push('-reconnect','1','-reconnect_streamed','1','-reconnect_delay_max','5');
    else args.push('-rtsp_transport','tcp');
    args.push('-i',streamUrl);
  } else if (sourceType === 'file') {
    const filePath = String(source.path || '').trim();
    if (!filePath) throw new Error('مسار ملف المصدر غير محدد');
    args.push('-re','-stream_loop','-1','-i',filePath);
  } else if (sourceType === 'screen') {
    const screenFps = String(Number(source.fps) || 15);
    if (process.platform === 'win32') args.push('-f','gdigrab','-framerate',screenFps,'-i','desktop');
    else args.push('-f','x11grab','-framerate',screenFps,'-i',String(process.env.DISPLAY || ':0.0'));
  } else {
    const inputSpec = audioDevice ? `video=${source.videoDevice}:audio=${audioDevice}` : `video=${source.videoDevice}`;
    args.push('-f','dshow','-rtbufsize','256M');
    // الوضع الآمن: لا نفرض الدقة/الإطارات على الجهاز (يعالج خطأ "Could not set video options").
    if (!source.captureSafeMode) args.push('-framerate',String(Number(source.fps)||30),'-video_size',String(source.videoSize||'1280x720'));
    // صيغة الإدخال: pixelFormat أولاً، وإلا vcodec (اختيار «mjpeg» في الواجهة كان يُهمَل سابقاً).
    const inputFormat = String(source.pixelFormat || source.vcodec || '').trim();
    if (inputFormat) args.push('-pixel_format',inputFormat);
    args.push('-i',inputSpec);
  }
  // Conservative HLS-safe remux: only network inputs can request source-copy; USB capture is always encoded.
  if (isCopyQuality(channel.quality) && !isNetwork && sourceType !== 'file' && sourceType !== 'screen') throw new Error('نسخ المصدر دون إعادة ترميز غير متاح لهذا النوع من التقاط USB؛ اختر 240p أو 360p أو 480p أو 720p.');
  if (isCopyQuality(channel.quality) && isNetwork && !forceTranscode) {
    args.push('-map','0:v:0','-map','0:a:0?','-c:v','copy','-c:a','aac','-b:a',cfg.audioBitrate||'96k');
  } else {
    args.push('-map','0:v:0','-vf',`scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=decrease,pad=${outputWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2,fps=${outputFps}`,
      '-c:v','libx264','-preset',settings.x264Preset||'veryfast','-pix_fmt','yuv420p','-threads',String(Number(settings.x264Threads)||2),
      '-r',String(outputFps),'-g',String(gop),'-keyint_min',String(gop),'-sc_threshold','0');
    if(settings.x264QualityMode===true) args.push('-crf','23');
    else args.push('-b:v',videoBitrate,'-maxrate',videoBitrate,'-bufsize','1000k');
    if (isNetwork || audioDevice || sourceType === 'file') args.push('-map','0:a:0?','-af','aresample=async=1:first_pts=0','-c:a','aac','-b:a',cfg.audioBitrate||'96k','-ar',String(Number(cfg.audioSampleRate)||44100),'-ac',String(Number(cfg.audioChannels)||2));
    else args.push('-an');
  }
  const dir = channelHlsDir(channel); fs.mkdirSync(dir,{recursive:true});
  args.push('-f','hls','-hls_time',String(hlsTime),'-hls_list_size',String(Number(settings.hlsListSize)||6),'-hls_delete_threshold',String(Number(settings.hlsDeleteThreshold)||4),
    '-hls_flags','delete_segments+append_list+omit_endlist+independent_segments+program_date_time','-hls_segment_filename',path.join(dir,'seg_%05d.ts'),path.join(dir,'index.m3u8'));
  return args;
}
function startChannel(channelId) {
  const channel = data.channels.find(c=>c.id===channelId);
  if (!channel) return {ok:false,message:'القناة غير موجودة'};
  if (channel.enabled===false) return {ok:false,message:'القناة معطلة'};
  const source = sourceForChannel(channel); if (!source || source.enabled===false) return {ok:false,message:'مصدر القناة غير متاح'};
  for (const [otherId, rt] of streams) {
    if (otherId!==channelId && rt.proc && source.type==='usb' && data.sources.find(x=>x.id===rt.sourceId)?.videoDevice===source.videoDevice) return {ok:false,message:'جهاز USB مستخدم بالفعل بواسطة قناة أخرى'};
  }
  const old=streams.get(channelId);
  if (old?.proc && !old.stopping) return {ok:true,message:'القناة تعمل بالفعل',channelId};
  if (old?.proc && old.stopping) return {ok:false,message:'القناة ما زالت تغلق؛ انتظر اكتمال الإيقاف ثم أعد التشغيل',channelId};
  if(old?.restartTimer)clearTimeout(old.restartTimer);
  const runtime={proc:null,restartCount:old?.restartCount||0,restartTimer:null,stopping:false,startedAt:null,lastExit:null,sourceId:source.id,forceTranscode:!!old?.forceTranscode};
  streams.set(channelId,runtime); clearTimeout(runtime.restartTimer); clearChannelHls(channel);
  let args; try { args=buildArgs(channel,runtime.forceTranscode); } catch(e) { runtime.lastExit=e.message; return {ok:false,message:e.message}; }
  const safeArgs=args.map((a,i)=> i>0 && args[i-1]==='-i' && /^(https?|rtsp):/i.test(a) ? '[network-url-hidden]' : a);
  logLine(`بدء القناة ${channel.name} (${channel.id}) من المصدر ${source.name}. FFmpeg args: ${safeArgs.join(' ')}`);
  try { runtime.proc=spawn(ffmpegBin(),args,{cwd:ROOT,windowsHide:true,stdio:['ignore','ignore','pipe']}); }
  catch(e) { runtime.lastExit=e.message; return {ok:false,message:e.message}; }
  const proc=runtime.proc; runtime.startedAt=new Date().toISOString();
  proc.stderr.on('data',b=>{
    let m=b.toString().trim(); if(!m) return;
    if(data.settings.hideCosmeticLogs===true){ m=filterCosmeticFfmpegLines(m); if(!m) return; }
    logLine(`[${channel.name}] FFmpeg: ${m}`);appendChannelLog(channelId,`FFmpeg: ${m}`);
  });
  proc.on('error',e=>{runtime.lastExit=e.message;runtime.proc=null;logLine(`[${channel.name}] تعذر تشغيل FFmpeg: ${e.message}`);scheduleChannelRestart(channelId);});
  proc.on('exit',(code,signal)=>{
    runtime.lastExit=`code=${code}; signal=${signal||''}`;
    runtime.proc=null;
    logLine(`[${channel.name}] انتهى FFmpeg: ${runtime.lastExit} — ${runtime.stopping ? 'إيقاف مطلوب يدوياً' : 'خروج غير متوقع'}${runtime.forceTranscode ? ' | نسخ قسري بعد فشل' : ''}`);
    const currentSource=sourceForChannel(channel);
    const networkSource=currentSource && ['http-hls','http','hls','network','rtsp'].includes(String(currentSource.type||'').toLowerCase());
    if(code!==0 && isCopyQuality(channel.quality) && networkSource && !runtime.forceTranscode && !runtime.stopping){
      runtime.forceTranscode=true;
      logLine(`[${channel.name}] فشل نسخ المصدر؛ ستتم إعادة المحاولة بإعادة الترميز لضمان توافق HLS.`);
    }
    if(streams.get(channelId)===runtime && !runtime.stopping)scheduleChannelRestart(channelId);
  });
  return {ok:true,message:`تم إرسال أمر تشغيل القناة ${channel.name}`,channelId,pid:proc.pid};
}
function scheduleChannelRestart(channelId) {
  const rt=streams.get(channelId), channel=data.channels.find(c=>c.id===channelId);
  if(!rt||!channel||rt.stopping||!data.settings.autoRestartCrashed||rt.restartCount>=Number(data.settings.maxRestarts||20))return;
  clearTimeout(rt.restartTimer);rt.restartCount++;
  const delay=Number(data.settings.restartBackoffMs)||5000;
  rt.restartTimer=setTimeout(()=>{if(!rt.stopping&&!rt.proc)startChannel(channelId);},delay);
  logLine(`إعادة تشغيل ${channel.name} بعد ${delay}ms (المحاولة ${rt.restartCount})`);
}
function stopChannel(channelId, origin = '') {
  const channel = data.channels.find(c => c.id === channelId);
  const label = channel ? channel.name : 'قناة غير معروفة';
  const context = origin ? ` — الطالب: ${origin}` : '';
  const rt = streams.get(channelId);
  if (!rt) { logLine(`إيقاف «${label}» (${channelId})${context}: لا توجد عملية تشغيل مسجّلة، القناة متوقفة أصلاً`); return {ok:true,message:'القناة متوقفة بالفعل',channelId}; }
  rt.stopping=true;clearTimeout(rt.restartTimer);rt.restartTimer=null;
  if (!rt.proc) { logLine(`إيقاف «${label}» (${channelId})${context}: لا توجد عملية FFmpeg نشطة | آخر خروج: ${rt.lastExit || 'لا يوجد'}`); return {ok:true,message:'القناة متوقفة بالفعل',channelId}; }
  const proc=rt.proc;
  const uptimeSec = rt.startedAt ? Math.round((Date.now() - new Date(rt.startedAt).getTime()) / 1000) : null;
  try {
    proc.kill();
    logLine(`إيقاف «${label}» (${channelId})${context}: أُرسلت إشارة الإيقاف إلى FFmpeg pid=${proc.pid}${uptimeSec !== null ? ` بعد تشغيل ${uptimeSec} ثانية` : ''}${rt.lastExit ? ` | آخر خروج: ${rt.lastExit}` : ''} | إعادات سابقة: ${rt.restartCount || 0}`);
    return {ok:true,message:'جارٍ إيقاف القناة؛ لن يعاد فتح المصدر قبل خروج FFmpeg',channelId};
  } catch(e) {
    logLine(`فشل إيقاف «${label}» (${channelId})${context}: ${e.message}`);
    return {ok:false,message:e.message,channelId};
  }
}
function restartChannel(channelId) {
  const rt=streams.get(channelId);
  if (!rt?.proc) return startChannel(channelId);
  const proc=rt.proc;
  const begin=()=>setTimeout(()=>startChannel(channelId),250);
  proc.once('exit',begin);
  const stopped=stopChannel(channelId);
  if (!stopped.ok) return stopped;
  return {ok:true,message:'تم طلب إعادة التشغيل بعد إغلاق FFmpeg الحالي',channelId};
}
function stopStream(origin = '') {
  const context = origin ? ` — الطالب: ${origin}` : '';
  const running = data.channels.filter(c => streams.get(c.id)?.proc).length;
  logLine(`طلب إيقاف كل القنوات${context}: ${data.channels.length} قناة معرّفة، ${running} عملية FFmpeg قيد التشغيل`);
  const results = data.channels.map(c => stopChannel(c.id, origin));
  const signaled = results.filter(r => /جارٍ إيقاف/.test(r.message)).length;
  logLine(`اكتمل إرسال أوامر الإيقاف${context}: ${signaled} قناة أُرسل لها الإيقاف، ${results.length - signaled} كانت متوقفة أصلاً`);
  return {ok:true,message:'تم إرسال أوامر إيقاف جميع القنوات',results};
}

function listDevices(res) {
  execFile(
    ffmpegBin(),
    ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
    { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
    (err, stdout, stderr) => {
      const output = `${stderr || ''}\n${stdout || ''}`.trim();
      // FFmpeg DirectShow prints each device name followed by (video) or (audio).
      // De-duplicate names while preserving the order returned by the device driver.
      const video = [];
      const audio = [];
      const seenVideo = new Set();
      const seenAudio = new Set();
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/\]\s*\"([^\"]+)\"\s*\((video|audio)\)/i);
        if (!match) continue;
        const name = match[1].trim();
        const type = match[2].toLowerCase();
        const list = type === 'video' ? video : audio;
        const seen = type === 'video' ? seenVideo : seenAudio;
        if (name && !seen.has(name)) { seen.add(name); list.push(name); }
      }
      if (res) {
        send(res, 200, {
          ok: true,
          video: video.map(name => ({ value: name, label: name })),
          audio: audio.map(name => ({ value: name, label: name })),
          devices: { video, audio },
          output: output || (err ? err.message : 'لم تظهر أجهزة'),
          note: err && !output ? `تعذر تشغيل فحص FFmpeg: ${err.message}` : (video.length || audio.length ? 'قوائم الفيديو والصوت مستخرجة من أجهزة DirectShow التي يعرضها FFmpeg.' : 'لم يعرض FFmpeg أي جهاز DirectShow متصل.')
        });
      } else {
        console.log(output || (err ? err.message : 'لم تظهر أجهزة'));
      }
    }
  );
}

function parseCaptureCapabilities(output) {
  const videoSizes = new Set();
  const frameRates = new Set();
  const pixelFormats = new Set();
  // FFmpeg DirectShow lists mode options on stderr, often in forms such as:
  // pixel_format=mjpeg min s=640x480 fps=30 max s=1280x720 fps=30
  for (const line of String(output || '').split(/\r?\n/)) {
    for (const match of line.matchAll(/(?:min\s+s=|max\s+s=|s=)(\d{2,5})x(\d{2,5})/gi)) {
      const width = Number(match[1]), height = Number(match[2]);
      if (width >= 160 && height >= 120 && width <= 8192 && height <= 4320) videoSizes.add(`${width}x${height}`);
    }
    for (const match of line.matchAll(/fps\s*=\s*(\d{1,3}(?:\.\d+)?)/gi)) {
      const fps = Number(match[1]); if (fps >= 1 && fps <= 240) frameRates.add(String(Number(fps.toFixed(2))));
    }
    for (const match of line.matchAll(/(?:pixel_format|vcodec)=([a-zA-Z0-9_]+)/gi)) pixelFormats.add(match[1].toLowerCase());
  }
  // Some FFmpeg builds render modes as e.g. 1280x720 @ 30 fps.
  for (const match of String(output || '').matchAll(/(\d{2,5})x(\d{2,5})\s*(?:@|,)?\s*(\d{1,3}(?:\.\d+)?)\s*fps/gi)) {
    const w=Number(match[1]), h=Number(match[2]), fps=Number(match[3]);
    if (w >= 160 && h >= 120 && w <= 8192 && h <= 4320) videoSizes.add(`${w}x${h}`);
    if (fps >= 1 && fps <= 240) frameRates.add(String(Number(fps.toFixed(2))));
  }
  const sizeRank = value => { const [w,h]=value.split('x').map(Number); return {value, pixels:w*h, width:w, height:h}; };
  const ranked = [...videoSizes].map(sizeRank).sort((a,b) => {
    const aPreferred = a.width <= 1280 && a.height <= 720 ? 1 : 0;
    const bPreferred = b.width <= 1280 && b.height <= 720 ? 1 : 0;
    return bPreferred-aPreferred || b.pixels-a.pixels;
  });
  const fpsValues = [...frameRates].map(Number).sort((a,b)=>a-b);
  const recommendedSize = ranked[0]?.value || '1280x720';
  const recommendedFps = fpsValues.filter(x=>x<=30).sort((a,b)=>b-a)[0] || fpsValues[0] || 30;
  const preferredFormats = ['mjpeg','yuyv422','uyvy422','nv12','yuv420p'];
  const recommendedFormat = preferredFormats.find(x=>pixelFormats.has(x)) || [...pixelFormats][0] || '';
  const modes=[];
  for(const line of String(output||'').split(/\r?\n/)){
    const fmt=(line.match(/(?:pixel_format|vcodec)=([a-zA-Z0-9_]+)/i)||[])[1]?.toLowerCase()||'';
    const sizes=[...line.matchAll(/(?:min\s+s=|max\s+s=|s=)(\d{2,5})x(\d{2,5})/gi)].map(m=>`${m[1]}x${m[2]}`);
    const rates=[...line.matchAll(/fps\s*=\s*(\d{1,3}(?:\.\d+)?)/gi)].map(m=>String(Number(Number(m[1]).toFixed(2))));
    for(const size of new Set(sizes)) for(const rate of new Set(rates)) modes.push({pixelFormat:fmt||recommendedFormat,videoSize:size,fps:Number(rate)});
  }
  const uniqueModes=[...new Map(modes.map(m=>[`${m.pixelFormat}|${m.videoSize}|${m.fps}`,m])).values()];
  return {
    videoSizes: [...videoSizes].sort((a,b)=>sizeRank(b).pixels-sizeRank(a).pixels),
    frameRates: fpsValues.map(String), pixelFormats: [...pixelFormats], modes: uniqueModes,
    recommended: { videoSize: recommendedSize, fps: recommendedFps, pixelFormat: recommendedFormat }
  };
}

function queryCaptureCapabilities(videoDevice, callback) {
  if (!videoDevice || String(videoDevice).length > 300 || /[\r\n\0]/.test(videoDevice)) {
    return callback(new Error('اسم جهاز الفيديو غير صالح'));
  }
  execFile(ffmpegBin(), ['-hide_banner','-f','dshow','-list_options','true','-i',`video=${videoDevice}`],
    { windowsHide: true, timeout: 20000, maxBuffer: 2*1024*1024 }, (err, stdout, stderr) => {
      const output = `${stderr || ''}\n${stdout || ''}`.trim();
      const capabilities = parseCaptureCapabilities(output);
      if (!capabilities.videoSizes.length) {
        const error = new Error(err && !output ? `تعذر تشغيل FFmpeg: ${err.message}` : 'لم يعرض FFmpeg أو تعريف الجهاز أوضاع فيديو قابلة للاستخراج');
        error.output = output;
        return callback(error);
      }
      callback(null, { capabilities, output });
    });
}

function testCapture(body, callback) {
  const videoDevice=String(body.videoDevice||'').trim(), audioDevice=String(body.audioDevice||'').trim();
  if(body.mode==='audio'){if(!audioDevice||audioDevice.length>300||/[\r\n\0]/.test(audioDevice))return callback(new Error('اختر جهاز صوت صالحاً'));const a=spawn(ffmpegBin(),['-hide_banner','-loglevel','error','-f','dshow','-i',`audio=${audioDevice}`,'-t','3','-f','null','-'],{cwd:ROOT,windowsHide:true,stdio:['ignore','ignore','pipe']});let out='';const timer=setTimeout(()=>{try{a.kill();}catch{}},10000);a.stderr.on('data',b=>out=(out+b.toString()).slice(-8000));a.on('error',e=>{clearTimeout(timer);callback(new Error(e.message));});a.on('close',code=>{clearTimeout(timer);code===0?callback(null,{ok:true,audio:true,output:'نجح اختبار الصوت لمدة 3 ثوانٍ.'}):callback(new Error(`فشل اختبار الصوت (exit ${code}). ${out.slice(-1800)}`));});return;}
  if(!videoDevice || videoDevice.length>300 || /[\r\n\0]/.test(videoDevice)) return callback(new Error('جهاز الفيديو غير صالح'));
  const size=String(body.videoSize||'1280x720'), fps=Number(body.fps)||30, pixel=String(body.pixelFormat||'mjpeg');
  if(!/^\d{2,5}x\d{2,5}$/.test(size)||fps<1||fps>60||!/^[a-z0-9_]{2,30}$/i.test(pixel)) return callback(new Error('إعدادات الالتقاط غير صالحة'));
  const input=audioDevice?`video=${videoDevice}:audio=${audioDevice}`:`video=${videoDevice}`;
  const args=['-hide_banner','-loglevel','error','-f','dshow','-rtbufsize','128M','-framerate',String(fps),'-video_size',size,'-pixel_format',pixel,'-i',input,'-t','3','-f','null','-'];
  const child=spawn(ffmpegBin(),args,{cwd:ROOT,windowsHide:true,stdio:['ignore','ignore','pipe']});
  let output='';const timer=setTimeout(()=>{try{child.kill();}catch{}},10000);
  child.stderr.on('data',b=>{output=(output+b.toString()).slice(-12000);});
  child.on('error',e=>{clearTimeout(timer);callback(new Error(`تعذر تشغيل FFmpeg: ${e.message}`));});
  child.on('close',code=>{clearTimeout(timer);if(code===0)callback(null,{ok:true,video:true,audio:!!audioDevice,output:'نجح اختبار الالتقاط لمدة 3 ثوانٍ.'});else callback(new Error(`فشل اختبار الالتقاط (exit ${code}). ${output.slice(-2500)}`));});
}

function assetType(file) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.m3u8': 'application/vnd.apple.mpegurl',
    '.ts': 'video/mp2t',
    '.m4s': 'video/iso.segment',
    '.mp4': 'video/mp4'
  };
  return types[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function serveStatic(req, res) {
  let pathname;

  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  let requested = pathname === '/' ? '/index.html' : pathname;
  if (requested === '/admin' || requested === '/admin/') {
    requested = '/admin.html';
  }
  const fullPath = path.resolve(WEB_DIR, `.${requested}`);

  if (!fullPath.startsWith(WEB_DIR + path.sep) && fullPath !== WEB_DIR) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  // صفحة اللوحة تُخدَم دائماً لأنها تعرض شاشة الدخول بنفسها؛ حماية البيانات تبقى
  // على كل مسارات /api/* (جلسة موقّعة فقط) ولا يكشف الملف أي بيانات.

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'Not found' : 'Internal Server Error');
      return;
    }

    res.writeHead(200, {
      'Content-Type': assetType(fullPath),
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

// الملفات المرفوعة (أغلفة القنوات والشعار) كانت تُخدم عبر Nginx فقط، فتظهر
// مكسورة عند فتح الخادم مباشرة على منفذ Node. نخدمها من Node أيضاً.
function serveUploads(req, res, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch {
    res.writeHead(400); res.end('Bad Request'); return;
  }
  const relative = decoded.replace(/^\/uploads\/?/, '');
  const fullPath = path.resolve(UPLOADS_DIR, relative);
  if (!fullPath.startsWith(UPLOADS_DIR + path.sep) && fullPath !== UPLOADS_DIR) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Cache-Control': 'no-store' });
      res.end(err.code === 'ENOENT' ? 'Not found' : 'Internal Server Error');
      return;
    }
    res.writeHead(200, {
      'Content-Type': assetType(fullPath),
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(data);
  });
}

function serveHls(req, res, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch {
    res.writeHead(400); res.end('Bad Request'); return;
  }
  const relative = decoded.replace(/^\/hls\/?/, '');
  const fullPath = path.resolve(HLS_DIR, relative);
  if (!fullPath.startsWith(HLS_DIR + path.sep) && fullPath !== HLS_DIR) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Cache-Control': 'no-store' });
      res.end(err.code === 'ENOENT' ? 'HLS file not found' : 'Internal Server Error');
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    const types = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.m4s': 'video/iso.segment', '.mp4': 'video/mp4' };
    res.writeHead(200, {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.m3u8' ? 'no-store, no-cache, must-revalidate' : 'public, max-age=60',
      'Access-Control-Allow-Origin': '*'
    });
    servedBytes += data.length;
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/api/network/interfaces') {
    if (!requireAdmin(req, res)) return;
    const interfaces = getNetworkInterfaces();
    return send(res, 200, { ok: true, port: Number(cfg.nginxPort) || 80, interfaces, message: interfaces.length ? 'تم اكتشاف عناوين IPv4 على واجهات الشبكة.' : 'لم يتم العثور على عنوان IPv4 قابل للوصول.' });
  }

  // Explicit admin-page routes; both Node direct access and Nginx proxy use these.
  if (req.method === 'GET' &&
      (url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname === '/admin.html')) {
    req.url = '/admin.html';
    return serveStatic(req, res);
  }

  if (req.method === 'GET' && url.pathname.startsWith('/hls/')) {
    return serveHls(req, res, url.pathname);
  }

  if (req.method === 'GET' && url.pathname.startsWith('/uploads/')) {
    return serveUploads(req, res, url.pathname);
  }

  // Public API used by viewer.js. Public endpoints expose no filesystem paths.
  if (url.pathname === '/api/public/settings' && req.method === 'GET') {
    const {siteName,siteNameLatin,logo,ticker,tickerEnabled,phone,theme,playerMaxBufferLength,playerBackBufferLength,playerLiveSyncDuration,capLevelToPlayerSize,cpuSaverDefault}=data.settings;
    return send(res, 200, { ok: true, settings: {siteName,siteNameLatin,logo:publicAsset(logo),ticker,tickerEnabled,phone,theme,playerMaxBufferLength,playerBackBufferLength,playerLiveSyncDuration,capLevelToPlayerSize,cpuSaverDefault} });
  }
  if (url.pathname === '/api/public/channels' && req.method === 'GET') {
    return send(res, 200, { ok: true, channels: data.channels.filter(c => c.enabled !== false).sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0)).map(publicChannel) });
  }
  if (url.pathname === '/api/public/channel-health' && req.method === 'GET') {
    const id = url.searchParams.get('id');
    const channel = data.channels.find(c => c.id === id);
    if (!channel) return apiError(res, 404, 'القناة غير موجودة');
    const c = publicChannel(channel);
    return send(res, 200, { ok: true, id: c.id, live: c.live, state: c.state, status: c.status, lastError: c.lastError });
  }
  if (url.pathname === '/api/public/watch' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return apiError(res, 400, e.message); }
    const channel = data.channels.find(c => c.id === body.id && c.enabled !== false);
    if (!channel) return apiError(res, 404, 'القناة غير موجودة أو معطلة');
    if (!data.settings.autoStartOnDemand) return send(res, 200, { ok: true, started: false, reason: 'disabled', message: 'التشغيل عند الطلب غير مفعّل' });
    const result = startChannel(channel.id);
    return send(res, result.ok ? 200 : 503, { ...result, started: !!result.ok });
  }
  if (url.pathname === '/api/public/heartbeat' && req.method === 'POST') {
    let body; try { body = await readBody(req); } catch (e) { return apiError(res, 400, e.message); }
    const id = String(body.viewerId || '');
    const channelId = String(body.channelId || activeChannel()?.id || '');
    if (!safeId(id)) return apiError(res, 400, 'معرّف المشاهد غير صالح');
    if (!data.channels.some(c => c.id === channelId && c.enabled !== false)) return apiError(res, 404, 'القناة غير موجودة');
    if (!viewerSessions.has(id)) totalViewerCount++;
    viewerSessions.set(id, { channelId, lastSeen: Date.now() });
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/public/leave' && req.method === 'POST') {
    let body; try { body = await readBody(req); } catch (e) { return apiError(res, 400, e.message); }
    if (body.viewerId) viewerSessions.delete(String(body.viewerId));
    return send(res, 200, { ok: true });
  }
  // تسجيل الدخول داخل اللوحة: يتحقق من نفس حساب config.json ثم يفتح جلسة بكوكي HttpOnly.
  if (url.pathname === '/api/me' && req.method === 'GET') {
    return send(res, 200, { ok: true, authed: isAdminAuthorized(req), user: adminAccount().user });
  }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (loginBlocked(ip)) return apiError(res, 429, 'محاولات دخول كثيرة؛ انتظر 10 دقائق ثم أعد المحاولة');
    let body;
    try { body = await readBody(req); } catch (e) { return apiError(res, 400, e.message); }
    const user = String(body.user || '').trim();
    const pass = String(body.pass || '');
    if (!user || !pass) return apiError(res, 400, 'اسم المستخدم وكلمة المرور مطلوبان');
    if (!sameSecret(user, adminAccount().user) || !isAdminPassword(pass)) {
      noteLoginFailure(ip);
      logLine(`فشل تسجيل دخول للوحة التحكم: ${clientInfo(req)}`);
      return apiError(res, 401, 'اسم المستخدم أو كلمة المرور غير صحيحة');
    }
    loginFailures.delete(ip);
    setAdminSession(req, res);
    logLine(`دخول ناجح للوحة التحكم: ${clientInfo(req)}`);
    return send(res, 200, { ok: true, user: adminAccount().user });
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    clearAdminSession(res);
    return send(res, 200, { ok: true, message: 'تم تسجيل الخروج' });
  }

  const adminApiPath = url.pathname === '/api/channels' || url.pathname.startsWith('/api/channels/') || url.pathname === '/api/sources' || url.pathname.startsWith('/api/sources/') || url.pathname === '/api/settings' || url.pathname === '/api/stats' || url.pathname.startsWith('/api/devices') || url.pathname === '/api/start' || url.pathname === '/api/stop' || url.pathname === '/api/logs' || url.pathname.startsWith('/api/logs/') || url.pathname.startsWith('/api/backup') || url.pathname === '/api/upload' || url.pathname === '/api/metrics' || url.pathname.startsWith('/api/settings/');
  if (url.pathname === '/api/status' && req.method === 'GET') {
    // Status is intentionally public for the viewer page; it contains no credentials or filesystem paths.
  } else if (adminApiPath && !requireAdmin(req, res)) {
    if (url.pathname === '/api/stop' || url.pathname === '/api/start') logLine(`رفض ${url.pathname} (401) لعدم وجود مصادقة: ${clientInfo(req)}`);
    return;
  }
  // Admin/local management API: channel/source CRUD and settings persistence.
  if (url.pathname === '/api/channels' && req.method === 'GET') return send(res, 200, { ok: true, channels: data.channels.map(publicChannel) });
  if (url.pathname === '/api/sources' && req.method === 'GET') return send(res, 200, { ok: true, sources: data.sources.map(s => ({ ...s, url: s.streamUrl || '' })) });
  if (url.pathname === '/api/settings' && req.method === 'GET') return send(res, 200, { ok: true, settings: data.settings });
  if (url.pathname === '/api/settings' && req.method === 'PUT') {
    let body; try { body = await readBody(req); } catch (e) { return apiError(res, 400, e.message); }
    const textKeys = ['siteName','siteNameLatin','phone','ticker','logo','ffmpegPath','ffprobePath','nginxPath','streamUserAgent','logoImage','logoPosition'];
    for (const key of textKeys) if (Object.prototype.hasOwnProperty.call(body,key)) {
      const value = String(body[key] ?? '');
      if (value.length > (key === 'ticker' ? 500 : (['ffmpegPath','ffprobePath','nginxPath'].includes(key) ? 1000 : 300))) return apiError(res,400,`قيمة ${key} أطول من المسموح`);
      data.settings[key] = value;
    }
    const boolKeys = ['tickerEnabled','autoStartOnDemand','capLevelToPlayerSize','cpuSaverDefault','x264QualityMode','autoRestartCrashed','idleStopEnabled','hideCosmeticLogs'];
    for (const key of boolKeys) if (Object.prototype.hasOwnProperty.call(body,key)) data.settings[key] = !!body[key];
    const numberRanges = {
      playerMaxBufferLength:[5,120], playerBackBufferLength:[0,120], playerLiveSyncDuration:[1,30],
      outputWidth:[160,3840], outputHeight:[120,2160], outputFps:[1,60], gopSeconds:[1,10],
      startupQueueDelayMs:[0,120000], startupConcurrency:[1,20], x264Threads:[1,64], hlsTime:[1,10], hlsListSize:[3,30], hlsDeleteThreshold:[1,100], port:[1024,65535], nginxPort:[1,65535],
      maxRestarts:[0,100], restartBackoffMs:[1000,120000], idleStopMinutes:[1,1440],
      sourceFailStopMinutes:[1,10000], blockedStopMinutes:[1,10000], logoSizePct:[2,40], logoOpacityPct:[0,100]
    };
    for (const [key,[min,max]] of Object.entries(numberRanges)) if (Object.prototype.hasOwnProperty.call(body,key)) {
      const n = Number(body[key]);
      if (!Number.isFinite(n) || n < min || n > max) return apiError(res,400,`قيمة ${key} يجب أن تكون بين ${min} و${max}`);
      data.settings[key] = n;
    }
    if (Object.prototype.hasOwnProperty.call(body,'x264Preset')) {
      const allowedPresets = ['ultrafast','superfast','veryfast','faster','fast','medium','slow'];
      if (!allowedPresets.includes(String(body.x264Preset))) return apiError(res,400,'Preset غير صالح');
      data.settings.x264Preset = String(body.x264Preset);
    }
    if (Object.prototype.hasOwnProperty.call(body,'logoPosition')) {
      if (!['top-right','top-left','bottom-right','bottom-left'].includes(String(body.logoPosition))) return apiError(res,400,'موضع الشعار غير صالح');
      data.settings.logoPosition = String(body.logoPosition);
    }
    if (Object.prototype.hasOwnProperty.call(body,'theme')) {
      const allowedThemes = ['default','worldcup'];
      if (!allowedThemes.includes(String(body.theme))) return apiError(res,400,'الثيم غير صالح');
      data.settings.theme = String(body.theme);
    }
    Object.assign(cfg, {
      ffmpegPath:data.settings.ffmpegPath||cfg.ffmpegPath, ffprobePath:data.settings.ffprobePath||cfg.ffprobePath, nginxPath:data.settings.nginxPath||cfg.nginxPath,
      port:data.settings.port||cfg.port, nginxPort:data.settings.nginxPort||cfg.nginxPort,
      outputWidth:data.settings.outputWidth, outputHeight:data.settings.outputHeight, outputFps:data.settings.outputFps,
      gopSeconds:data.settings.gopSeconds, startupQueueDelayMs:data.settings.startupQueueDelayMs,
      preset:data.settings.x264Preset, threads:data.settings.x264Threads, hlsTime:data.settings.hlsTime,
      hlsListSize:data.settings.hlsListSize, autoRestart:data.settings.autoRestartCrashed,
      maxRestarts:data.settings.maxRestarts, restartDelayMs:data.settings.restartBackoffMs
    });
    writeData(data); syncNginxPorts(); return send(res, 200, { ok: true, settings: data.settings, message: 'تم حفظ الإعدادات. تغييرات المنافذ تتطلب إعادة تشغيل Node.js وNginx، وتغييرات الترميز تتطلب إعادة تشغيل القنوات.' });
  }
  // تغيير كلمة مرور اللوحة: يتحقق من الحالية ثم يحفظ hash جديداً ويعيد فتح جلسة للمستخدم الحالي.
  if (url.pathname === '/api/settings/password' && req.method === 'POST') {
    const ip = clientIp(req);
    if (loginBlocked(ip)) return apiError(res, 429, 'محاولات كثيرة؛ انتظر 10 دقائق ثم أعد المحاولة');
    let body; try { body = await readBody(req); } catch (e) { return apiError(res, 400, e.message); }
    const current = String(body.current || '');
    const next = String(body.next || '');
    if (!current || !next) return apiError(res, 400, 'كلمة المرور الحالية والجديدة مطلوبتان');
    if (next.length < 6) return apiError(res, 400, 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل');
    if (!isAdminPassword(current)) {
      noteLoginFailure(ip);
      logLine(`فشل تغيير كلمة المرور (كلمة حالية خاطئة): ${clientInfo(req)}`);
      // 403 لا 401: 401 في الواجهة يعني «انتهت الجلسة» فيُخرج المستخدم للدخول.
      return apiError(res, 403, 'كلمة المرور الحالية غير صحيحة');
    }
    if (next === current) return apiError(res, 400, 'كلمة المرور الجديدة يجب أن تختلف عن الحالية');
    try { setAdminPassword(next); }
    catch (e) { return apiError(res, 500, `تعذر حفظ كلمة المرور: ${e.message}`); }
    loginFailures.delete(ip);
    setAdminSession(req, res);
    logLine(`تم تغيير كلمة مرور لوحة التحكم: ${clientInfo(req)}`);
    return send(res, 200, { ok: true, message: 'تم تغيير كلمة المرور' });
  }
  if (url.pathname === '/api/channels' && req.method === 'POST') {
    let body; try { body = await readBody(req); } catch (e) { return apiError(res, 400, e.message); }
    if (!String(body.name || '').trim()) return apiError(res, 400, 'اسم القناة مطلوب');
    if (body.sourceId && !data.sources.some(x => x.id === body.sourceId)) return apiError(res, 400, 'مصدر البث غير موجود');
    const channelId = 'ch_' + require('crypto').randomBytes(5).toString('hex');
    const chanId = String(body.chanId || '').trim();
    if (chanId && (!/^[a-zA-Z0-9_-]{1,40}$/.test(chanId) || data.channels.some(c => c.chanId === chanId))) return apiError(res, 400, 'معرّف القناة يجب أن يكون بالإنجليزية وفريداً');
    const sortValue = body.sort !== undefined ? body.sort : body.sortOrder;
    const channel = { id: channelId, chanId: chanId || channelId, name: String(body.name).trim().slice(0,100), category: String(body.category || 'عام').slice(0,80), sourceId: body.sourceId || data.sources[0]?.id || '', cover: String(body.cover || '').slice(0,500), enabled: body.enabled !== false, quality: String(body.quality || '360p'), fps: body.fps ? Number(body.fps) : '', bitrate: String(body.bitrate||''), autoStart: !!body.autoStart, alwaysOn: !!body.alwaysOn, logoEnabled: !!body.logoEnabled, sortOrder: Number.isFinite(Number(sortValue)) ? Number(sortValue) : data.channels.length, url: `/hls/${channelId}/index.m3u8` };
    data.channels.push(channel); writeData(data); return send(res, 201, { ok: true, channel: publicChannel(channel) });
  }
  const channelMatch = url.pathname.match(/^\/api\/channels\/([a-zA-Z0-9_-]+)$/);
  if (channelMatch && req.method === 'PUT') {
    let body; try { body = await readBody(req); } catch (e) { return apiError(res, 400, e.message); }
    const channel = data.channels.find(c => c.id === channelMatch[1]);
    if (!channel) return apiError(res, 404, 'القناة غير موجودة');
    if (body.sourceId && !data.sources.some(x => x.id === body.sourceId)) return apiError(res, 400, 'مصدر البث غير موجود');
    if (Object.prototype.hasOwnProperty.call(body,'quality') && !['source','copy','240p','360p','480p','720p'].includes(String(body.quality))) return apiError(res,400,'جودة القناة غير صالحة');
    if (Object.prototype.hasOwnProperty.call(body,'fps') && body.fps !== '' && (!Number.isFinite(Number(body.fps)) || Number(body.fps)<1 || Number(body.fps)>60)) return apiError(res,400,'FPS يجب أن يكون بين 1 و60');
    if (Object.prototype.hasOwnProperty.call(body,'bitrate') && body.bitrate && !/^\d{2,5}k$/i.test(String(body.bitrate))) return apiError(res,400,'صيغة Bitrate غير صالحة؛ مثال 1500k');
    if (Object.prototype.hasOwnProperty.call(body,'chanId')) {
      const chanId = String(body.chanId || '').trim();
      if (chanId && (!/^[a-zA-Z0-9_-]{1,40}$/.test(chanId) || data.channels.some(c => c.chanId === chanId && c.id !== channel.id))) return apiError(res, 400, 'معرّف القناة يجب أن يكون بالإنجليزية وفريداً');
      channel.chanId = chanId || channel.id;
    }
    for (const key of ['name','category','sourceId','cover','enabled','quality','fps','bitrate','autoStart','alwaysOn','logoEnabled']) if (Object.prototype.hasOwnProperty.call(body,key)) channel[key] = body[key];
    if (Object.prototype.hasOwnProperty.call(body,'sort')) channel.sortOrder = Number(body.sort) || 0;
    else if (Object.prototype.hasOwnProperty.call(body,'sortOrder')) channel.sortOrder = Number(body.sortOrder) || 0;
    channel.url = `/hls/${channel.id}/index.m3u8`;
    writeData(data); return send(res, 200, { ok: true, channel: publicChannel(channel) });
  }
  if (channelMatch && req.method === 'PATCH') {
    let body; try { body = await readBody(req); } catch (e) { return apiError(res, 400, e.message); }
    const channel = data.channels.find(c => c.id === channelMatch[1]);
    if (!channel) return apiError(res, 404, 'القناة غير موجودة');
    if (Object.prototype.hasOwnProperty.call(body,'enabled')) {
      channel.enabled = !!body.enabled;
      if (!channel.enabled) stopChannel(channel.id);
    }
    writeData(data); return send(res, 200, { ok: true, channel: publicChannel(channel) });
  }
  if (channelMatch && req.method === 'DELETE') {
    const index = data.channels.findIndex(c => c.id === channelMatch[1]);
    if (index < 0) return apiError(res, 404, 'القناة غير موجودة');
    
    stopChannel(channelMatch[1]); data.channels.splice(index,1); writeData(data); return send(res, 200, { ok: true, message: 'تم حذف القناة' });
  }
  if (url.pathname === '/api/sources' && req.method === 'POST') {
    let body; try { body = await readBody(req); } catch (e) { return apiError(res, 400, e.message); }
    const type = normalizeSourceType(body.type);
    if (!type) return apiError(res, 400, 'نوع المصدر غير مدعوم');
    if (!String(body.name || '').trim()) return apiError(res, 400, 'اسم المصدر مطلوب');
    const source = { id: 'src_' + require('crypto').randomBytes(5).toString('hex'), name: String(body.name).trim().slice(0,100), type, enabled: body.enabled !== false };
    const invalid = applySourceFields(source, body);
    if (invalid) return apiError(res, 400, invalid);
    data.sources.push(source);
    writeData(data);
    return send(res, 201, { ok: true, source, message: 'تم حفظ المصدر. أضف قناة مرتبطة به من صفحة القنوات.' });
  }
  if (url.pathname === '/api/sources/test' && req.method === 'POST') {
    let body; try { body = await readBody(req); } catch (e) { return apiError(res, 400, e.message); }
    const target = String(body.url || body.streamUrl || '').trim();
    if (!target) return apiError(res, 400, 'أدخل رابط المصدر أولاً');
    if (!/^https?:\/\//i.test(target)) return apiError(res, 400, 'اختبار الرابط يدعم HTTP وHTTPS فقط');
    try {
      const result = await probeStreamUrl(target);
      return send(res, 200, { ok: result.status >= 200 && result.status < 400, ...result });
    } catch (err) {
      return send(res, 200, { ok: false, kind: 'error', message: err.message });
    }
  }
  const sourceMatch = url.pathname.match(/^\/api\/sources\/([a-zA-Z0-9_-]+)$/);
  if (sourceMatch && req.method === 'PUT') {
    let body; try { body = await readBody(req); } catch (e) { return apiError(res, 400, e.message); }
    const source = data.sources.find(x => x.id === sourceMatch[1]);
    if (!source) return apiError(res, 404, 'مصدر البث غير موجود');
    const nextType = Object.prototype.hasOwnProperty.call(body, 'type') ? normalizeSourceType(body.type) : normalizeSourceType(source.type);
    if (!nextType) return apiError(res, 400, 'نوع المصدر غير مدعوم');
    const linked = data.channels.filter(c => c.sourceId === source.id);
    const wasRunning = linked.filter(c => channelRuntime(c.id)?.proc).map(c => c.id);
    wasRunning.forEach(stopChannel);
    const previousType = source.type;
    source.type = nextType;
    if (previousType !== nextType) { delete source.streamUrl; delete source.path; delete source.videoDevice; }
    const invalid = applySourceFields(source, body);
    if (invalid) { source.type = previousType; return apiError(res, 400, invalid); }
    writeData(data);
    wasRunning.forEach(id => {
      const rt = streams.get(id);
      if (rt?.proc) { const proc = rt.proc; proc.once('exit', () => setTimeout(() => startChannel(id), 250)); }
      else setTimeout(() => startChannel(id), 250);
    });
    return send(res, 200, { ok: true, source, restartedChannels: wasRunning, message: 'تم حفظ المصدر؛ ستُعاد القنوات التي كانت تعمل بعد إغلاق عمليات FFmpeg السابقة.' });
  }
  if (sourceMatch && req.method === 'DELETE') {
    const source = data.sources.find(x => x.id === sourceMatch[1]);
    if (!source) return apiError(res, 404, 'مصدر البث غير موجود');
    if (data.channels.some(c => c.sourceId === source.id)) return apiError(res, 409, 'لا يمكن حذف مصدر مرتبط بقناة');
    data.sources = data.sources.filter(x => x.id !== source.id); writeData(data); return send(res, 200, { ok: true, message: 'تم حذف المصدر' });
  }
  if (url.pathname === '/api/stats' && req.method === 'GET') {
    const now = Date.now();
    for (const [id, session] of viewerSessions) if (now - session.lastSeen > 45000) viewerSessions.delete(id);
    const channels = data.channels.map(publicChannel);
    const viewers = channels.reduce((sum,c)=>sum+(c.viewers||0),0);
    let hlsBytes = 0;
    try { for (const dir of fs.readdirSync(HLS_DIR,{withFileTypes:true})) if(dir.isDirectory()) for(const name of fs.readdirSync(path.join(HLS_DIR,dir.name))) if(/\.(ts|m3u8|m4s|mp4)$/i.test(name)){try{hlsBytes+=fs.statSync(path.join(HLS_DIR,dir.name,name)).size;}catch{}} } catch {}
    return send(res, 200, { ok: true, stats: { channels: { total: channels.length, running: channels.filter(c => c.live).length, error: channels.filter(c => c.status === 'error').length }, viewers, totalViewers: viewers, cpuPercent, memoryMb: Math.round(process.memoryUsage().rss/1048576), platform: process.platform, node: process.version, uptimeSeconds: Math.floor(process.uptime()), genBps: 0, outBps: 0, hlsBytes, servedBytes, devices: { total: data.sources.length, present: data.sources.filter(x => x.enabled !== false).length, video: data.sources.filter(x => x.enabled !== false).length, audio: data.sources.filter(x => x.enabled !== false && x.audioDevice).length }, nginx: null }, channels });
  }
  if (url.pathname.startsWith('/api/')) {
    // Continue to legacy routes below; unknown routes get a consistent JSON response.
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    return send(res, 200, getStatus(url.searchParams.get('channelId') || undefined));
  }

  if (req.method === 'GET' && url.pathname === '/api/devices') {
    return listDevices(res);
  }
  if (req.method === 'POST' && url.pathname === '/api/devices/test-audio') {let body;try{body=await readBody(req);}catch(e){return apiError(res,400,e.message);}return testCapture({...body,mode:'audio'},(err,result)=>err?apiError(res,422,err.message):send(res,200,{ok:true,result}));}
  if (req.method === 'POST' && url.pathname === '/api/devices/test') {
    let body;try{body=await readBody(req);}catch(e){return apiError(res,400,e.message);}
    return testCapture(body,(err,result)=>err?apiError(res,422,err.message):send(res,200,{ok:true,result}));
  }
  if (req.method === 'GET' && url.pathname === '/api/devices/capabilities') {
    const videoDevice = url.searchParams.get('videoDevice') || '';
    return queryCaptureCapabilities(videoDevice, (err, result) => {
      if (err) return send(res, 422, { ok: false, error: err.message, output: err.output || '' });
      return send(res, 200, { ok: true, capabilities: result.capabilities, note: 'القدرات مستخرجة من مخرجات FFmpeg DirectShow. قد تختلف الخيارات الفعلية حسب تعريف القطعة.' });
    });
  }

  const channelAction = url.pathname.match(/^\/api\/channels\/([a-zA-Z0-9_-]+)\/(start|stop|restart)$/);
  if (channelAction && req.method === 'POST') {
    const [,id,action]=channelAction;
    if(action==='stop') return send(res,200,stopChannel(id,clientInfo(req)));
    if(action==='restart')return send(res,202,restartChannel(id));
    logLine(`طلب تشغيل القناة ${id}: ${clientInfo(req)}`);
    return send(res,200,startChannel(id));
  }
  if (req.method === 'POST' && url.pathname === '/api/start') {
    logLine(`طلب تشغيل القنوات التلقائية: ${clientInfo(req)}`);
    const started=data.channels.filter(c=>c.enabled!==false && c.autoStart).map(c=>startChannel(c.id));
    return send(res,200,{ok:true,message:'تم إرسال أوامر تشغيل القنوات المحددة للتشغيل التلقائي',results:started});
  }
  if (req.method === 'POST' && url.pathname === '/api/stop') return send(res,200,stopStream(clientInfo(req)));

  if (req.method === 'GET' && url.pathname === '/api/logs') {
    return send(res, 200, { logs: ffmpegLog });
  }

  if (req.method === 'GET' && url.pathname === '/api/devices/options') {
    const device = url.searchParams.get('device') || '';
    return queryCaptureCapabilities(device, (err, result) => {
      if (err) return send(res, 422, { ok: false, error: err.message });
      return send(res, 200, { ok: true, sizes: result.capabilities.videoSizes, fps: result.capabilities.frameRates, pixelFormats: result.capabilities.pixelFormats });
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/devices/recommend') {
    const device = url.searchParams.get('device') || '';
    return queryCaptureCapabilities(device, (err, result) => {
      if (err) return send(res, 422, { ok: false, error: err.message });
      const caps = result.capabilities;
      const recommended = caps.recommended || {};
      return send(res, 200, {
        ok: true,
        videoSize: recommended.videoSize || '1280x720',
        fps: recommended.fps || 30,
        pixelFormat: recommended.pixelFormat || '',
        vcodec: (caps.pixelFormats || []).includes('mjpeg') ? 'mjpeg' : '',
        detected: { pixelFormats: caps.pixelFormats || [], codecs: (caps.pixelFormats || []).filter(x => ['mjpeg', 'h264'].includes(x)) }
      });
    });
  }
  const logMatch = url.pathname.match(/^\/api\/logs\/([a-zA-Z0-9_-]+)(\/(?:clear|download))?$/);
  if (logMatch && data.channels.some(c => c.id === logMatch[1])) {
    const channelId = logMatch[1];
    const content = channelLogs.get(channelId) || '';
    if (logMatch[2] === '/clear' && req.method === 'POST') {
      channelLogs.delete(channelId);
      return send(res, 200, { ok: true, message: 'تم تصفير السجل' });
    }
    if (logMatch[2] === '/download') {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${channelId}.log"`,
        'Cache-Control': 'no-store'
      });
      return res.end(content || '');
    }
    return send(res, 200, { ok: true, log: content });
  }
  if (req.method === 'GET' && url.pathname === '/api/metrics') {
    const channels = data.channels.map(publicChannel);
    let hlsBytesTotal = 0;
    try {
      for (const dir of fs.readdirSync(HLS_DIR, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        for (const name of fs.readdirSync(path.join(HLS_DIR, dir.name))) {
          if (!/\.(ts|m3u8|m4s|mp4)$/i.test(name)) continue;
          try { hlsBytesTotal += fs.statSync(path.join(HLS_DIR, dir.name, name)).size; } catch {}
        }
      }
    } catch {}
    return send(res, 200, {
      ok: true,
      cpuCount: os.cpus().length, cpuLoad: os.loadavg()[0] || 0,
      uptimeSec: Math.floor(process.uptime()), memoryMB: Math.round(process.memoryUsage().rss / 1048576),
      currentViewers: channels.reduce((sum, c) => sum + (c.viewers || 0), 0),
      watchedChannels: channels.filter(c => c.viewers > 0).length,
      totalViewers: totalViewerCount,
      runningChannels: channels.filter(c => c.status === 'running').length,
      totalChannels: channels.length,
      hlsBytesTotal, egressBytesTotal: servedBytes,
      ingestBandwidthBps: 0, egressBandwidthBps: egressBps, internetBandwidthBps: 0
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/settings/regenerate-nginx') {
    const written = [], notes = [];
    if (syncNginxPorts()) {
      written.push(path.join(ROOT, 'nginx', 'conf', 'nginx.conf'));
      notes.push('أعد تشغيل Nginx لتطبيق المنافذ الجديدة.');
    } else {
      notes.push('لم يُعثر على nginx/conf/nginx.conf داخل الحزمة؛ حدّث منافذ Nginx يدوياً.');
    }
    return send(res, 200, { ok: true, nginxPort: Number(data.settings.nginxPort) || 80, port: Number(data.settings.port) || 3001, written, notes });
  }
  if (req.method === 'POST' && url.pathname === '/api/upload') {
    const raw = await readRawBody(req).catch(() => null);
    if (!raw) return apiError(res, 400, 'تعذر قراءة الملف المرفوع');
    const part = parseMultipart(raw, req.headers['content-type']).find(x => x.filename && x.data.length);
    if (!part) return apiError(res, 400, 'لم يتم اختيار ملف');
    const name = safeUploadName(part.filename);
    fs.writeFileSync(path.join(UPLOADS_DIR, name), part.data);
    return send(res, 200, { ok: true, path: `srv/uploads/${name}`, url: `/uploads/${name}` });
  }
  if (req.method === 'GET' && url.pathname === '/api/backup/download') {
    const payload = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), settings: data.settings, sources: data.sources, channels: data.channels }, null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="prince-live-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      'Cache-Control': 'no-store'
    });
    return res.end(payload);
  }
  if (req.method === 'POST' && url.pathname === '/api/backup/restore') {
    const raw = await readRawBody(req).catch(() => null);
    if (!raw) return apiError(res, 400, 'تعذر قراءة ملف النسخة الاحتياطية');
    const part = parseMultipart(raw, req.headers['content-type']).find(x => x.filename);
    let parsed = null;
    try {
      parsed = JSON.parse(String(part ? part.data.toString('utf8') : raw.toString('utf8')).replace(/^\uFEFF/, ''));
    } catch {
      return apiError(res, 400, 'ملف النسخة الاحتياطية غير صالح');
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.settings || typeof parsed.settings !== 'object') {
      return apiError(res, 400, 'ملف النسخة لا يحتوي إعدادات صالحة');
    }
    data.settings = { ...defaultData().settings, ...parsed.settings };
    writeData(data); syncNginxPorts();
    return send(res, 200, { ok: true, message: 'تم استرجاع الإعدادات. أعد تشغيل النظام لتطبيق تغييرات المنافذ.' });
  }
  if (req.method === 'GET' && url.pathname === '/api/update/status') {
    return send(res, 200, { ok: true, available: false, currentVersion: '8.0.0', latestVersion: '8.0.0' });
  }

  if (url.pathname.startsWith('/api/')) {
    return send(res, 404, { error: 'Not found' });
  }

  return serveStatic(req, res);
});

// المنفذ يأتي من settings.port في data.json (مصدر وحيد يتغيّر من اللوحة)،
// ويبقى متغير البيئة PORT أعلى أولوية للتشغيل في حاوية أو خلف وكيل.
const LISTEN_PORT = Number(process.env.PORT || data.settings.port) || 3001;
const LISTEN_HOST = process.env.HOST || cfg.host || '127.0.0.1';

server.on('error', err => {
  if (err.code === 'EADDRINUSE') logLine(`تعذر بدء الخادم: المنفذ ${LISTEN_PORT} مستخدم بالفعل. أغلق النسخة الأخرى من الخادم أو غيّر المنفذ من إعدادات اللوحة.`);
  else if (err.code === 'EACCES') logLine(`تعذر بدء الخادم: لا توجد صلاحية للاستماع على المنفذ ${LISTEN_PORT} أو العنوان ${LISTEN_HOST}.`);
  else logLine(`خطأ في خادم HTTP: ${err.message}`);
  process.exit(1);
});


setInterval(() => {
  const now=Date.now();
  for (const [id,session] of viewerSessions) if(now-session.lastSeen>45000)viewerSessions.delete(id);
  if(!data.settings.idleStopEnabled)return;
  const idleMs=Math.max(1,Number(data.settings.idleStopMinutes)||2)*60000;
  for(const channel of data.channels){
    if(channel.alwaysOn || !channelRuntime(channel.id)?.proc)continue;
    const viewers=[...viewerSessions.values()].some(v=>v.channelId===channel.id && now-v.lastSeen<=45000);
    const rt=channelRuntime(channel.id);
    if(viewers){rt.noViewerSince=null;continue;}
    if(!rt.noViewerSince)rt.noViewerSince=now;
    if(now-rt.noViewerSince>=idleMs){logLine(`إيقاف القناة ${channel.name} بسبب الخمول وعدم وجود مشاهدين`);stopChannel(channel.id);}
  }
},5000).unref();

setInterval(() => {
  const current = os.cpus().map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a,b) => a+b, 0) }));
  let idleDelta = 0, totalDelta = 0;
  current.forEach((c, i) => { const prev = previousCpu[i]; if (prev) { idleDelta += c.idle - prev.idle; totalDelta += c.total - prev.total; } });
  cpuPercent = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0;
  previousCpu = current;
}, 2000).unref();

setInterval(() => {
  const now = Date.now();
  const elapsed = Math.max(1, (now - lastServedSample.at) / 1000);
  egressBps = Math.max(0, Math.round((servedBytes - lastServedSample.bytes) / elapsed));
  lastServedSample = { bytes: servedBytes, at: now };
  probeNginxPort();
}, 3000).unref();
probeNginxPort();

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  logLine(`الخادم يعمل على http://${LISTEN_HOST}:${LISTEN_PORT} (منفذ Nginx: ${Number(data.settings.nginxPort) || 80})`);
  for (const item of getNetworkInterfaces()) logLine(`رابط المشاهدة: ${item.url} | الواجهة: ${item.name}`);
  if (process.argv.includes('--devices')) listDevices();
  const bootChannels=data.channels.filter(c=>c.enabled!==false && (c.autoStart||c.alwaysOn));
  // كل دورة تُشغّل startupConcurrency قناة معاً: 1 = تسلسلي كما كان، وأكثر = دفعات متزامنة بفاصل ثانية بين الدفعات.
  const bootConcurrency=Math.max(1,Number(data.settings.startupConcurrency)||1);
  bootChannels.forEach((c,i)=>setTimeout(()=>startChannel(c.id),Math.max(0,Number(data.settings.startupQueueDelayMs)||0)+Math.floor(i/bootConcurrency)*1000));
});

function shutdown() {
  stopStream();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
