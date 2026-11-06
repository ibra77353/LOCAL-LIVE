'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
// طبقة الالتقاط الموحّدة: الخادم لا يتعامل مع DirectShow مباشرة.
const capture = require('./lib/capture');
const { clampNumber } = require('./lib/shared/clamp');

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
// الخادم من مجلد آخر. نحل الاسم إلى الملف المرفق إن وُجد ثم نترك PATH كبديل،
// وتُجرَّب اللاحقة .exe لأن الإصدار مخصص لويندوز فقط.
function resolveTool(toolName) {
  const value = String(toolName || '').trim();
  if (!value || path.isAbsolute(value)) return value;
  const names = [value, `${value}.exe`];
  for (const name of names) {
    const candidate = path.join(ROOT, name);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return value;
}
function ffmpegBin() { return resolveTool(cfg.ffmpegPath); }
function ffprobeBin() { return resolveTool(data.settings.ffprobePath || cfg.ffprobePath); }

// أبعاد ملف مصدر محلي عبر FFprobe (المسار المضبوط في الإعدادات)، حتى تُحسب أبعاد
// الخرج من نسبة الملف الحقيقية بدل الافتراض 1280x720 الذي يشوّه الدقة عند اختيار
// جودة مسمّاة تختلف عن أبعاد الملف.
function probeFileDimensions(filePath) {
  return new Promise(resolve => {
    if (!filePath || !fs.existsSync(filePath)) return resolve('');
    const args = ['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json', filePath];
    execFile(ffprobeBin(), args, { windowsHide: true, timeout: 8000, maxBuffer: 256 * 1024 }, (err, stdout) => {
      if (err) return resolve('');
      try {
        const stream = (JSON.parse(stdout).streams || [])[0] || {};
        const width = Number(stream.width), height = Number(stream.height);
        if (width > 0 && height > 0) return resolve(`${width}x${height}`);
      } catch {}
      resolve('');
    });
  });
}

const streams = new Map(); // channelId -> independent FFmpeg runtime
let ffmpegLog = '';
let servedBytes = 0;
// إجمالي كل ما خدّمه Nginx (مقاطع البث وصفحات اللوحة معاً) مقروءاً من سجلاته،
// ويشمل ما هو موجود في السجلات قبل الإقلاع أيضاً.
let nginxServedBytes = 0;
const channelServedBytes = new Map(); // channelId -> بايتات /hls المخدومة لتلك القناة
// معدّل البت الفعلي لكل قناة لمقارنته بالمضبوط في إعداداتها. المقاطع تُكتب كل
// ثانيتين بينما العيّنة كل ثلاث، فحساب المعدّل من عيّنة واحدة يتذبذب (مقطع أو
// مقطعان في النافذة)؛ لذلك يُحسب على نافذة 12 ثانية من إجمالي البايتات المولَّدة.
const channelGenBytes = new Map(); // channelId -> إجمالي بايتات مقاطعها المولَّدة
const channelGenSnapshot = new Map(); // channelId -> { bytes, at } بداية النافذة الحالية
const channelOutputBps = new Map(); // channelId -> بايت/ثانية على نافذة القياس
let ingestBps = 0;
let lastHlsFiles = new Map(); // مسار مقطع -> آخر حجم معروف (لحساب معدل التوليد)
// باندويث الإنترنت: مجموع البايتات المستقبَلة على واجهات الشبكة الفعلية.
// null تعني أن النظام لا يوفّر عدّادات شبكة مقروءة (تظهر «—» في اللوحة).
let internetBps = null;
let internetRxTotal = null, internetRxAt = 0;
let internetProbeBusy = false;
// سجلات Nginx: على ويندوز تُخدَم مقاطع HLS من القرص مباشرةً فلا يراها Node،
// لذلك نحتسب بايتات /hls من سجلّ الوصول كي تعمل مقاييس البيانات.
const NGINX_LOG_DIR = path.resolve(process.env.NGINX_LOG_DIR || path.join(ROOT, 'nginx', 'logs'));
const nginxLogOffsets = new Map();
let nginxLogActive = false;
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
// وضع الترميز الوحيد هو Bitrate: لكل قناة معدّل بت محدّد (أو تلقائي حسب دقة الخرج).
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
// حقول دقة عامة ألغيت (الدقة تُضبط لكل قناة)؛ تُحذف بقاياها من data.json القديم.
let prunedSettingsFields = false;
for (const key of ['outputWidth','outputHeight','outputFps','gopSeconds']) {
  if (Object.prototype.hasOwnProperty.call(data.settings, key)) { delete data.settings[key]; prunedSettingsFields = true; }
}
if (prunedSettingsFields) writeData(data);
Object.assign(cfg, {
  ffmpegPath: data.settings.ffmpegPath ?? cfg.ffmpegPath,
  ffprobePath: data.settings.ffprobePath ?? cfg.ffprobePath,
  port:data.settings.port ?? cfg.port, nginxPort:data.settings.nginxPort ?? cfg.nginxPort,
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
// أحجام مقاطع HLS الحالية. تُستخدم لعرض حجم المولَّد في اللوحة وحساب معدل
// التوليد (باندويث الإدخال) من نمو كل مقطع بين عينتين.
function hlsFileSizes() {
  const sizes = new Map();
  let total = 0;
  try {
    for (const dir of fs.readdirSync(HLS_DIR, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const name of fs.readdirSync(path.join(HLS_DIR, dir.name))) {
        if (!/\.(ts|m3u8|m4s|mp4)$/i.test(name)) continue;
        const file = path.join(HLS_DIR, dir.name, name);
        try { const size = fs.statSync(file).size; sizes.set(file, size); total += size; } catch {}
      }
    }
  } catch {}
  return { total, sizes };
}
// يقرأ ما أُضيف إلى سجلات Nginx منذ آخر قراءة ويضيف بايتات /hls إلى عدّادات
// القنوات والإجمالي. عند وجود سجلّ Nginx يتوقف Node عن العدّ بنفسه (وإلا تكرّرت
// البايتات) لأن كل المقاطع تمرّ عبر Nginx في هذه الحالة.
// أول قراءة للسجل تقرأ ما هو موجود بالكامل (بحد أقصى آخر 32MB) حتى يظهر إجمالي
// البيانات التاريخي، ثم تتابع الإضافات فقط. تُحسب كل استجابة ناجحة 200/206 في
// إجمالي Nginx، ومقاطع /hls أيضاً في باندويث الخروج وعدّادات القنوات.
const NGINX_LOG_TAIL_BYTES = 32 * 1024 * 1024;
const NGINX_LOG_CHUNK = 1024 * 1024;
function countNginxLogLine(line) {
  const match = line.match(/"\w+ ([^"\s]+) [^"]*" (\d{3}) (\d+)/);
  if (!match) return;
  const status = Number(match[2]);
  if (status !== 200 && status !== 206) return;
  const bytes = Number(match[3]) || 0;
  if (!bytes) return;
  nginxServedBytes += bytes;
  const parts = match[1].split('/');
  if (parts[1] !== 'hls') return; // صفحات وواجهات API لا تدخل في باندويث المشاهدين
  servedBytes += bytes;
  const channelId = parts[2];
  if (channelId && data.channels.some(c => c.id === channelId)) {
    channelServedBytes.set(channelId, (channelServedBytes.get(channelId) || 0) + bytes);
  }
}
function readNginxLogs() {
  for (const name of ['stream.log', 'access.log']) {
    const file = path.join(NGINX_LOG_DIR, name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile()) continue;
    nginxLogActive = true;
    const known = nginxLogOffsets.get(file);
    let position = known == null ? Math.max(0, stat.size - NGINX_LOG_TAIL_BYTES) : known;
    // عند بدء القراءة من وسط سجل كبير يكون السطر الأول مبتوراً فنهمله.
    let skipPartialLine = known == null && position > 0;
    if (stat.size < position) { position = 0; skipPartialLine = false; } // تدوير/تفريغ السجل
    if (stat.size === position) continue;
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { continue; }
    const buffer = Buffer.alloc(NGINX_LOG_CHUNK);
    let pending = Buffer.alloc(0);
    let end = position;
    try {
      while (position < stat.size) {
        const read = fs.readSync(fd, buffer, 0, Math.min(NGINX_LOG_CHUNK, stat.size - position), position);
        if (!read) break;
        position += read;
        pending = Buffer.concat([pending, buffer.subarray(0, read)]);
        let nl;
        while ((nl = pending.indexOf(10)) >= 0) {
          const line = pending.toString('utf8', 0, nl);
          pending = pending.subarray(nl + 1);
          end = position - pending.length; // نهاية آخر سطر مكتمل
          if (skipPartialLine) { skipPartialLine = false; continue; }
          countNginxLogLine(line);
        }
      }
    } catch { /* تبقى القراءة التالية من آخر سطر مكتمل */ } finally { try { fs.closeSync(fd); } catch {} }
    nginxLogOffsets.set(file, end);
  }
}
// بايتات الشبكة الواردة على مستوى النظام من netstat -e (ويندوز).
// التعذّر يعيد null فتظهر القيمة «—».
function readSystemRx(cb) {
  execFile('netstat', ['-e'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (err, stdout) => {
    if (err || !stdout) return cb(null, null);
    // أول سطر رقمي بعد الترويسة هو سطر Bytes (تسميته مترجمة على ويندوز).
    const row = stdout.match(/^\s*[^\d\s][^\d]*?(\d+)\s+(\d+)\s*$/m);
    return cb(null, row ? Number(row[1]) : null);
  });
}
function playlistPath(channel) { return path.join(channelHlsDir(channel), 'index.m3u8'); }
// هل توجد قائمة تشغيل حديثة؟ نفس شرط «live» في publicChannel، ويُستخدم لتصفير
// مؤقّتات أعطال المصدر بعد نجاح التشغيل.
function channelIsLive(channel) {
  try { const st = fs.statSync(playlistPath(channel)); return st.isFile() && Date.now() - st.mtimeMs < 15000; } catch { return false; }
}
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
  // الإيقاف اليدوي والخروج الناجح ليسا خطأ: سبب الإنهاء الحقيقي هو ما يحدد الحالة.
  const exit = runtime?.lastExit || null;
  const exitBenign = !!exit && typeof exit === 'object' && (exit.reason === 'إيقاف يدوي' || exit.code === 0);
  // الخطأ يُعرض فقط ما دامت القناة متوقفة فعلاً؛ بعد نجاح إعادة التشغيل وظهور
  // قائمة تشغيل حديثة يُمحى الخطأ القديم تلقائياً حتى لا يبدو البث معطلاً.
  const lastErrorText = exit && !exitBenign && !live ? formatLastExit(exit) : '';
  return { ...channel, chanId: channel.chanId || channel.id, sort: Number(channel.sortOrder) || 0,
    url: `/hls/${channel.id}/index.m3u8`, cover: publicAsset(channel.cover),
    device: source?.videoDevice || '', sourceName: source?.name || '', live,
    status: live ? 'running' : (!channel.enabled ? 'stopped' : (runtime?.proc ? 'starting' : (exit && !exitBenign ? 'error' : 'stopped'))),
    state: live ? 'running' : 'stopped', pid: runtime?.proc?.pid || null, viewers, restarts: runtime?.restartCount || 0,
    lastErrorText,
    lastError: lastErrorText ? { text: lastErrorText, severity: /exit|error|فشل|تعذر/i.test(lastErrorText) ? 'high' : 'low' } : null,
    lastErrors: lastErrorText ? [lastErrorText] : [], bytesOut: channelServedBytes.get(channel.id) || 0,
    outputBps: runtime?.proc ? (channelOutputBps.get(channel.id) || 0) : 0 };
}

function readBody(req, maxBytes=1024*1024) {
  return new Promise((resolve, reject) => {
    let raw = ''; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > maxBytes) { reject(new Error('حجم الطلب كبير')); req.destroy(); return; } raw += chunk; });
    req.on('end', () => { if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON غير صالح')); } });
    req.on('error', reject);
  });
}
// الحقول الوحيدة المسموح بها عند إنشاء القناة أو تحديثها. أي خاصية أخرى في جسم
// الطلب (مثل الدقة أو CRF أو GOP) تُرفض صراحةً بدل تجاهلها بصمت.
const CHANNEL_WRITE_FIELDS = ['name','chanId','sourceId','category','sort','sortOrder','cover','enabled','quality','bitrate','fps','autoStart','alwaysOn'];
// مسار PATCH مخصّص لتبديل التفعيل فقط، فلا يقبل أي حقل آخر.
const CHANNEL_PATCH_FIELDS = ['enabled'];
// حقول المصدر المعتمدة (اتحاد الحقول المشتركة والحقول الخاصة بكل نوع).
const SOURCE_WRITE_FIELDS = ['name','type','videoDevice','videoDeviceLabel','audioDevice','videoSize','fps','pixelFormat','vcodec','captureSafeMode','enabled','url','streamUrl','path'];
// حقول الإعدادات المعتمدة = النصوص + المفاتيح المنطقية + النطاقات الرقمية + x264Preset والثيم.
const SETTINGS_WRITE_FIELDS = [
  'siteName','siteNameLatin','phone','ticker','logo','ffmpegPath','ffprobePath','nginxPath','streamUserAgent',
  'tickerEnabled','autoStartOnDemand','capLevelToPlayerSize','cpuSaverDefault','autoRestartCrashed','idleStopEnabled','hideCosmeticLogs',
  'playerMaxBufferLength','playerBackBufferLength','playerLiveSyncDuration',
  'startupQueueDelayMs','startupConcurrency','x264Threads','hlsTime','hlsListSize','hlsDeleteThreshold','port','nginxPort',
  'maxRestarts','restartBackoffMs','idleStopMinutes','sourceFailStopMinutes','blockedStopMinutes',
  'x264Preset','theme'
];
// يعيد أول خاصية في جسم الطلب غير موجودة في القائمة المسموحة، أو null.
function unexpectedField(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  return Object.keys(body).find(key => !fields.includes(key)) || null;
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
// ملف معرّف العملية: يكتبه الخادم عند الإقلاع ليستطيع scripts\stop.bat التأكد من
// أن العملية التي يوقفها هي خادم PrinceLive نفسه، لا عملية Node.js لبرنامج آخر.
const PID_FILE = path.join(RUN_DIR, 'server.pid');
const CONTROL_TOKEN = crypto.randomBytes(24).toString('hex');
// عدّاد جلسات محفوظ في run/session.epoch: يزداد عند تسجيل الخروج فتُبطل كل الرموز
// الصادرة قبل ذلك فوراً بدل أن تبقى صالحة حتى انتهاء مدة الـ12 ساعة.
const SESSION_EPOCH_FILE = path.join(RUN_DIR, 'session.epoch');
function readSessionEpoch() {
  try { return Math.max(0, Number(fs.readFileSync(SESSION_EPOCH_FILE, 'utf8').trim()) || 0); } catch { return 0; }
}
let sessionEpoch = readSessionEpoch();
function bumpSessionEpoch() {
  sessionEpoch++;
  try { fs.mkdirSync(RUN_DIR, { recursive: true }); fs.writeFileSync(SESSION_EPOCH_FILE, String(sessionEpoch)); }
  catch (err) { logLine(`تعذر حفظ عدّاد الجلسات: ${err.message}`); }
}
function sessionKey() {
  const account = adminAccount();
  return crypto.createHash('sha256').update(`prince-live-session:${account.user}:${account.hash}:${account.salt}`).digest();
}
function issueSessionToken() {
  const exp = String(Date.now() + ADMIN_SESSION_TTL_MS);
  const payload = `${exp}.${sessionEpoch}`;
  return `${payload}.${crypto.createHmac('sha256', sessionKey()).update(payload).digest('hex')}`;
}
function isValidSessionToken(token) {
  const [exp, epoch, mac] = String(token || '').split('.');
  if (!exp || !epoch || !mac || !Number.isFinite(Number(exp)) || Number(exp) < Date.now()) return false;
  if (Number(epoch) !== sessionEpoch) return false;
  return sameSecret(mac, crypto.createHmac('sha256', sessionKey()).update(`${exp}.${epoch}`).digest('hex'));
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
try {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
} catch (err) {
  console.error(`تعذر كتابة ${PID_FILE}: ${err.message}`);
}
// يُحذف ملف العملية عند الخروج الطبيعي فقط، وحين يكون ما فيه معرّفنا الحالي.
function removePidFile() {
  try {
    if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_FILE);
  } catch {}
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
// ردّ مزوّد IPTV بحظر الوصول (403/451): يُستخدم لعدّ «حظر المصدر» بمؤقّت مستقل
// عن أعطال الشبكة العادية (blockedStopMinutes مقابل sourceFailStopMinutes).
const BLOCKED_SOURCE_RE = /Server returned (?:403|451)|403 Forbidden|451 Unavailable|HTTP error 403/i;
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

// ذاكرة النظام الحقيقية من عدّادات نظام التشغيل (وليس ذاكرة عملية Node فقط).
function systemMemory() {
  const memTotalBytes = os.totalmem();
  const memFreeBytes = os.freemem();
  const memUsedBytes = Math.max(0, memTotalBytes - memFreeBytes);
  return {
    memTotalBytes, memUsedBytes, memFreeBytes,
    memPercent: memTotalBytes > 0 ? Math.round((memUsedBytes / memTotalBytes) * 100) : 0
  };
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
    cpuCount: os.cpus().length, cpuPercent,
    ...systemMemory(),
    license: { valid: true, plan: 'محلي' },
    messages: []
  };
  if (!channel) return { ...base, ticker: data.settings.ticker || cfg.ticker || '', running: false, playlistExists: false, channels: data.channels.map(publicChannel) };
  const source = sourceForChannel(channel), runtime = channelRuntime(channel.id);
  let playlistExists = false, playlistAgeMs = null;
  try { const st = fs.statSync(playlistPath(channel)); playlistExists = st.isFile(); playlistAgeMs = Date.now() - st.mtimeMs; } catch {}
  return { ...base, ticker: data.settings.ticker || cfg.ticker || '',
    running: !!runtime?.proc, pid: runtime?.proc?.pid || null, startedAt: runtime?.startedAt || null,
    restartCount: runtime?.restartCount || 0, lastExit: runtime?.lastExit || null, exitHistory: runtime?.exits || [], playlistExists, playlistAgeMs,
    streamUrl: `/hls/${channel.id}/index.m3u8`, sourceType: source?.type || '', videoDevice: source?.videoDevice || '', audioDevice: source?.audioDevice || '',
    audioEnabled: !!source?.audioDevice, videoBitrate: channel.bitrate || '',
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

// مسار ملف Nginx يأتي من settings.nginxPath ويُستخدم فعلياً في أوامر الاختبار
// والتشغيل والإيقاف. المسار النسبي يُبحث عنه في جذر المشروع ثم داخل مجلد nginx،
// والمسار غير الموجود يُعاد كما هو لتظهر رسالة واضحة بالمسار المتوقع.
function nginxPrefix() { return path.join(ROOT, 'nginx') + path.sep; }
function nginxExecutable() {
  const raw = String(data.settings.nginxPath || cfg.nginxPath || '').trim();
  if (!raw) return '';
  if (path.isAbsolute(raw)) return raw;
  for (const candidate of [path.join(ROOT, raw), path.join(ROOT, 'nginx', raw)]) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return path.join(ROOT, raw);
}
function nginxBinaryExists() {
  const bin = nginxExecutable();
  try { return !!bin && fs.statSync(bin).isFile(); } catch { return false; }
}
// ينفّذ nginx.exe من المسار المحفوظ مع بادئة مجلد nginx وملف الإعداد نفسه الذي
// تستخدمه السكربتات (nginx -p <root>/nginx/ -c conf/nginx.conf ...).
function runNginxCommand(extraArgs) {
  return new Promise(resolve => {
    const bin = nginxExecutable();
    if (!bin) return resolve({ ok:false, binary:'', output:'', message:'مسار Nginx غير محدد؛ اضبط «مسار Nginx» في الإعدادات.' });
    if (!nginxBinaryExists()) return resolve({ ok:false, binary:bin, output:'', message:`ملف Nginx غير موجود في المسار «${bin}»؛ صحّح «مسار Nginx» في الإعدادات.` });
    const args = ['-p', nginxPrefix(), '-c', 'conf/nginx.conf', ...extraArgs];
    execFile(bin, args, { cwd: ROOT, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.trim();
      if (!err) return resolve({ ok:true, binary:bin, output, message:'تم تنفيذ أمر Nginx بنجاح.' });
      const reason = ['ENOEXEC','EACCES','EPERM'].includes(err.code)
        ? `تعذر تنفيذ ملف Nginx «${bin}» (${err.code}); تأكد من وجود nginx\\nginx.exe في مجلد المشروع.`
        : (output || err.message);
      resolve({ ok:false, binary:bin, output, message:reason });
    });
  });
}
async function nginxAction(action) {
  if (action === 'test') return runNginxCommand(['-t']);
  if (action === 'reload') return runNginxCommand(['-s','reload']);
  if (action === 'stop') return runNginxCommand(['-s','quit']);
  if (action === 'start') return runNginxCommand([]);
  if (action === 'restart') {
    // لا يعتمد على "nginx -s quit" وحده: مهلة صغيرة تتيح للعملية القديمة تحرير
    // المنفذ قبل تشغيل النسخة الجديدة، ثم يُبلَّغ بنتيجة التشغيل الفعلية.
    const stopped = await runNginxCommand(['-s','quit']);
    await new Promise(r => setTimeout(r, 1500));
    const started = await runNginxCommand([]);
    return { ok: started.ok, binary: started.binary, output: [stopped.output, started.output].filter(Boolean).join('\n'),
      message: started.ok ? 'تمت إعادة تشغيل Nginx.' : started.message };
  }
  return { ok:false, binary: nginxExecutable(), output:'', message:'أمر غير معروف؛ استخدم test أو start أو stop أو reload أو restart.' };
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

// ---- تنقية معايير FFmpeg قبل تمريرها ----
// قيم libx264 المقبولة (نفس قائمة واجهة الإعدادات) ونطاق عدد الخيوط.
const X264_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'];
const encoderWarningsLogged = new Set();
// clampNumber مُستوردة من lib/shared/clamp.js: تطبيق واحد مشترك مع طبقة الالتقاط.
// يقبل صور البِتريت التي يفهمها FFmpeg مثل 500k أو 2000K أو 2M؛ غير ذلك يعيد الافتراضي.
function normalizeVideoBitrate(value, fallback) {
  const text = String(value || '').trim();
  return /^\d{2,6}[kKmM]?$/.test(text) ? text : fallback;
}
// يحوّل بِتريت نصياً (500k أو 2M أو 2000) إلى كيلوبت/ثانية لاشتقاق bufsize؛ 0 لقيمة غير صالحة.
function bitrateKbps(value) {
  const text = String(value || '').trim().toLowerCase();
  const num = Number(text.replace(/[km]$/, ''));
  if (!Number.isFinite(num) || num <= 0) return 0;
  return /m$/.test(text) ? num * 1000 : Math.round(num);
}
// يضمن أن preset وعدد الخيوط صالحان حتى لو عُدّلت data.json يدوياً.
function resolveEncoderSettings(settings) {
  const warnings = [];
  const presetRaw = String(settings.x264Preset || '').trim().toLowerCase();
  const preset = X264_PRESETS.includes(presetRaw) ? presetRaw : 'veryfast';
  if (presetRaw && preset !== presetRaw) warnings.push(`preset «${presetRaw}» غير مدعوم في libx264؛ سيُستخدم veryfast`);
  const threadsRaw = Math.round(Number(settings.x264Threads));
  const threads = clampNumber(settings.x264Threads, 1, 64, 2);
  if (Number.isFinite(threadsRaw) && threadsRaw !== threads) warnings.push(`x264Threads=${threadsRaw} خارج النطاق 1..64؛ سيُستخدم ${threads}`);
  // التحذير مرة واحدة لكل قيمة، حتى لا يتكرر مع كل إعادة تشغيل.
  const fresh = warnings.filter(w => !encoderWarningsLogged.has(w));
  if (fresh.length) { fresh.forEach(w => encoderWarningsLogged.add(w)); logLine(`تنبيه إعدادات FFmpeg: ${fresh.join(' | ')}`); }
  return { preset, threads };
}
// يميّز أخطاء معايير الترميز (تتكرر مع كل إعادة تشغيل) عن الأعطال العابرة.
function isEncoderParamError(text) {
  return /Error setting option|Unable to parse option value|Unknown encoder|Unknown decoder|Error initializing output stream|Invalid value .* for option|not a valid pixel format|Unrecognized option/i.test(String(text || ''));
}
// رسالة عربية قابلة للتنفيذ بدل خطأ FFmpeg الخام.
function describeEncoderParamError(text) {
  const t = String(text || '');
  if (/Unable to parse option value .* as pixel format|not a valid pixel format/i.test(t)) return 'صيغة البكسل المطلوبة غير صالحة؛ اختر صيغة يدعمها الجهاز (yuyv422 أو mjpeg) من نافذة المصدر.';
  if (/Unknown encoder/i.test(t)) return 'مُرمِّز libx264 غير متوفر في نسخة FFmpeg المستخدمة.';
  if (/Error setting option (?:framerate|video_size)|Could not set video options/i.test(t)) return 'الدقة أو معدل الإطارات غير مدعومين من الجهاز؛ استخدم «ضبط تلقائي» أو فعّل الوضع الآمن للالتقاط.';
  if (/preset/i.test(t)) return 'قيمة preset غير مقبولة؛ اختر إحدى قيم ultrafast…slow من الإعدادات.';
  return 'فشل FFmpeg بسبب خيار غير صالح؛ راجع آخر سطر في سجل القناة.';
}

// أبعاد الخرج ومعدّل الإطارات والهدف المحسوب للبِتريت من إعدادات القناة والمصدر.
// يُستخدم في buildArgs للتشفير وفي سجل استقرار البث، فيبقى الهدف واحداً في الاثنين.
function channelOutputPlan(channel, source) {
  const [srcW, srcH] = String(source.videoSize || cfg.videoSize || '1280x720').split('x').map(Number);
  // الجودة إما نسخ المصدر، أو مقاس مسمّى (240p..720p) يُحسب عرضه من نسبة المصدر،
  // أو «تلقائي» (auto/فارغ) = 360p. الدقة تُضبط لكل قناة فقط؛ لا إعداد عام للأبعاد.
  const qualityValue = String(channel.quality || '').trim().toLowerCase();
  const presetHeight = /^\d{3,4}p$/.test(qualityValue) ? Number(qualityValue.replace(/p$/,'')) : 0;
  const outputHeight = isCopyQuality(qualityValue) ? (srcH || 720) : (presetHeight || 360);
  // yuv420p يرفض الأبعاد الفردية، فالعرض يُشتق من نسبة المصدر ويُجبَر على الزوجية.
  const outputWidth = isCopyQuality(qualityValue) ? (srcW || 1280)
    : Math.max(160, Math.round(((srcW || 1280) * outputHeight) / (srcH || 720) / 2) * 2);
  const outputFps = clampNumber(Number(channel.fps), 1, 60, 20);
  const tierBitrate = outputHeight >= 720 ? '2000k' : outputHeight >= 480 ? '1000k' : '500k';
  // البِتريت يُضبط لكل قناة؛ وفارغه يعني قيمة تلقائية حسب دقة الخرج.
  const videoBitrate = normalizeVideoBitrate(channel.bitrate, tierBitrate);
  return { outputWidth, outputHeight, outputFps, videoBitrate };
}

// سطر سجل استقرار البِتريت: المعدّل الفعلي للخرج مقابل الهدف المحسوب على
// نافذة القياس (12 ثانية). يظهر في سجل الخادم وفي سجل القناة معاً.
function logBitrateWindow(channel, source, bytesPerSecond, seconds) {
  const targetKbps = bitrateKbps(channelOutputPlan(channel, source).videoBitrate);
  if (!targetKbps) return;
  const actualKbps = Math.round((bytesPerSecond * 8) / 1000);
  const deviation = Math.round(((actualKbps - targetKbps) / targetKbps) * 100);
  const verdict = Math.abs(deviation) <= 10 ? 'مستقر ضمن الهدف' : (deviation > 0 ? 'أعلى من الهدف' : 'أقل من الهدف');
  const line = `استقرار البِتريت «${channel.name}»: الفعلي ${actualKbps}k مقابل الهدف ${targetKbps}k `
    + `(${deviation > 0 ? '+' : ''}${deviation}%، ${verdict}) على نافذة ${Math.round(seconds)} ثانية`;
  logLine(line);
  appendChannelLog(channel.id, line);
}

function buildArgs(channel, forceTranscode = false) {
  const source = sourceForChannel(channel);
  if (!channel || channel.enabled === false) throw new Error('القناة غير موجودة أو معطلة');
  if (!source || source.enabled === false) throw new Error('مصدر البث غير موجود أو معطل');
  const settings = data.settings;
  const { outputWidth, outputHeight, outputFps, videoBitrate } = channelOutputPlan(channel, source);
  if (String(channel.bitrate || '').trim() && videoBitrate !== String(channel.bitrate).trim()) {
    logLine(`تنبيه إعدادات FFmpeg: بِتريت القناة «${channel.name}» غير صالح (${channel.bitrate})؛ سيُستخدم ${videoBitrate}`);
  }
  const hlsTime = clampNumber(settings.hlsTime, 1, 10, 2);
  // إطار مفتاحي واحد عند بداية كل مقطع HLS، فيبدأ كل مقطع من keyframe.
  const gop = Math.max(1, Math.round(outputFps * hlsTime));
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
    // التقاط الشاشة (gdigrab) يأتي من طبقة الالتقاط.
    args.push(...capture.screenInputArgs(source));
  } else {
    // وسائط جهاز الالتقاط (DirectShow) تأتي من طبقة الالتقاط.
    args.push(...capture.captureInputArgs(source));
  }
  // DirectShow يحمل الصوت مع الفيديو في الإدخال الأول نفسه.
  const audioMap = '0:a:0?';
  // Conservative HLS-safe remux: only network inputs can request source-copy; USB capture is always encoded.
  if (isCopyQuality(channel.quality) && !isNetwork && sourceType !== 'file' && sourceType !== 'screen') throw new Error('نسخ المصدر دون إعادة ترميز غير متاح لهذا النوع من التقاط USB؛ اختر 240p أو 288p أو 320p أو 360p أو 432p أو 480p أو 720p.');
  if (isCopyQuality(channel.quality) && isNetwork && !forceTranscode) {
    args.push('-map','0:v:0','-map',audioMap,'-c:v','copy','-c:a','aac','-b:a',cfg.audioBitrate||'96k');
  } else {
    const encoder = resolveEncoderSettings(settings);
    // بلا pad: القياس وحده إلى الدقة المختارة يدوياً لقناة، فلا أشرطة سوداء حول الصورة.
    args.push('-map','0:v:0','-vf',`scale=${outputWidth}:${outputHeight},fps=${outputFps}`,
      '-c:v','libx264','-preset',encoder.preset,'-pix_fmt','yuv420p','-threads',String(encoder.threads),
      '-r',String(outputFps),'-g',String(gop),'-keyint_min',String(gop),'-sc_threshold','0');
    // وضع Bitrate = سقف صارم: مخزن VBV يساوي ثانية واحدة بمعدّل القناة (لا ضعفه)
    // فلا يقفز الخرج فوق القيمة المختارة بين المقاطع. لا نستخدم nal-hrd=cbr لأن
    // حشو CBR يرفع المشاهد الهادئة إلى المعدّل كاملاً بدل توفير البيانات.
    const cap = bitrateKbps(videoBitrate);
    args.push('-b:v',videoBitrate,'-maxrate',videoBitrate,'-bufsize',`${cap || 2000}k`);
    if (isNetwork || audioDevice || sourceType === 'file') args.push('-map',audioMap,'-af','aresample=async=1:first_pts=0','-c:a','aac','-b:a',cfg.audioBitrate||'96k','-ar',String(Number(cfg.audioSampleRate)||44100),'-ac',String(Number(cfg.audioChannels)||2));
    else args.push('-an');
  }
  const dir = channelHlsDir(channel); fs.mkdirSync(dir,{recursive:true});
  args.push('-f','hls','-hls_time',String(hlsTime),'-hls_list_size',String(Number(settings.hlsListSize)||6),'-hls_delete_threshold',String(Number(settings.hlsDeleteThreshold)||4),
    '-hls_flags','delete_segments+append_list+omit_endlist+independent_segments+program_date_time','-hls_segment_filename',path.join(dir,'seg_%05d.ts'),path.join(dir,'index.m3u8'));
  return args;
}
// سجل خروج FFmpeg: يحفظ رمز الخروج والإشارة والسبب الحقيقي، مع آخر 5 محاولات
// حتى لا تضيع معلومات المحاولة السابقة عند إعادة التشغيل التلقائي.
function recordExit(runtime, info) {
  runtime.lastExit = {
    at: new Date().toISOString(),
    code: Number.isInteger(info.code) ? info.code : null,
    signal: info.signal || null,
    reason: info.reason,
    cause: info.cause || null
  };
  runtime.exits = [...(runtime.exits || []), runtime.lastExit].slice(-5);
  return runtime.lastExit;
}
function formatLastExit(exit) {
  if (!exit) return '';
  if (typeof exit === 'string') return exit;
  const parts = [`code=${exit.code === null ? 'n/a' : exit.code}`, `signal=${exit.signal || 'none'}`, `reason=${exit.reason}`];
  if (exit.cause) parts.push(`cause=${exit.cause}`);
  return parts.join('; ');
}
function startChannel(channelId, manual = false) {
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
  const runtime={proc:null,restartCount:old?.restartCount||0,restartTimer:null,stopping:false,startedAt:null,lastExit:old?.lastExit||null,exits:Array.isArray(old?.exits)?old.exits:[],sourceId:source.id,forceTranscode:!!old?.forceTranscode,lastStderr:'',paramError:false,
    // مؤقّتات التعافي: أول فشل للمصدر وأول ردّ حظر من المزوّد. تُصفَّر عند التشغيل
    // اليدوي وعند نجاح البث، ويقارنها مؤقّت الخادم بحدود sourceFailStopMinutes
    // وblockedStopMinutes لإيقاف القناة بدل حلقة إعادة تشغيل لا تنتهي.
    failSince: manual || old?.failedStop ? null : (old?.failSince || null),
    blockedSince: manual || old?.failedStop ? null : (old?.blockedSince || null),
    failedStop: !!old?.failedStop && !manual};
  streams.set(channelId,runtime); clearTimeout(runtime.restartTimer); clearChannelHls(channel);
  let args; try { args=buildArgs(channel,runtime.forceTranscode); } catch(e) { recordExit(runtime,{reason:'فشل بناء أمر FFmpeg',cause:e.message}); return {ok:false,message:e.message}; }
  const safeArgs=args.map((a,i)=> i>0 && args[i-1]==='-i' && /^(https?|rtsp):/i.test(a) ? '[network-url-hidden]' : a);
  logLine(`بدء القناة ${channel.name} (${channel.id}) من المصدر ${source.name}. FFmpeg args: ${safeArgs.join(' ')}`);
  try { runtime.proc=spawn(ffmpegBin(),args,{cwd:ROOT,windowsHide:true,stdio:['ignore','ignore','pipe']}); }
  catch(e) { recordExit(runtime,{reason:'تعذر تشغيل FFmpeg',cause:e.message}); return {ok:false,message:e.message}; }
  const proc=runtime.proc; runtime.startedAt=new Date().toISOString();
  proc.stderr.on('data',b=>{
    runtime.lastStderr=(runtime.lastStderr+b.toString()).slice(-4000);
    // ردّ حظر من مزوّد IPTV (403/451): يُسجَّل أول وقت له فقط، ويوقفه
    // blockedStopMinutes من مؤقّت الخادم.
    if (!runtime.blockedSince && BLOCKED_SOURCE_RE.test(b.toString())) runtime.blockedSince = Date.now();
    let m=b.toString().trim(); if(!m) return;
    if(data.settings.hideCosmeticLogs===true){ m=filterCosmeticFfmpegLines(m); if(!m) return; }
    logLine(`[${channel.name}] FFmpeg: ${m}`);appendChannelLog(channelId,`FFmpeg: ${m}`);
  });
  proc.on('error',e=>{recordExit(runtime,{reason:'تعذر تشغيل FFmpeg',cause:e.message});runtime.proc=null;logLine(`[${channel.name}] تعذر تشغيل FFmpeg: ${e.message}`);scheduleChannelRestart(channelId);});
  proc.on('exit',(code,signal)=>{
    const exitReason = runtime.stopping ? 'إيقاف يدوي' : (code === 0 ? 'انتهى بنجاح' : 'خروج غير متوقع');
    recordExit(runtime,{code,signal,reason:exitReason});
    runtime.proc=null;
    if (code !== 0 && !runtime.stopping && !runtime.failSince) runtime.failSince = Date.now();
    logLine(`[${channel.name}] انتهى FFmpeg: ${formatLastExit(runtime.lastExit)} — ${runtime.stopping ? 'إيقاف مطلوب يدوياً' : 'خروج غير متوقع'}${runtime.forceTranscode ? ' | نسخ قسري بعد فشل' : ''}`);
    // بعد الإيقاف لا تُترك مقاطع/قوائم HLS قديمة على القرص، وإلا بقي المشاهدون
    // يستطيعون تشغيل بث متوقف أو محتوى قديم من الملفات المتبقية.
    if (runtime.stopping) clearChannelHls(channel);
    // خطأ إعداد (preset/دقة/صيغة/مُرمِّز) يتكرر مع كل محاولة، فلا فائدة من حلقة إعادة التشغيل.
    if (code !== 0 && !runtime.stopping && !runtime.paramError && isEncoderParamError(runtime.lastStderr)) {
      runtime.paramError = true;
      runtime.lastExit.cause = describeEncoderParamError(runtime.lastStderr);
      logLine(`[${channel.name}] خطأ في معايير الترميز/الالتقاط — أُوقفت إعادة المحاولة التلقائية: ${runtime.lastExit.cause}`);
      appendChannelLog(channelId, `خطأ معايير الترميز: ${runtime.lastExit.cause}`);
    }
    const currentSource=sourceForChannel(channel);
    const networkSource=currentSource && ['http-hls','http','hls','network','rtsp'].includes(String(currentSource.type||'').toLowerCase());
    if(code!==0 && isCopyQuality(channel.quality) && networkSource && !runtime.forceTranscode && !runtime.stopping){
      runtime.forceTranscode=true;
      logLine(`[${channel.name}] فشل نسخ المصدر؛ ستتم إعادة المحاولة بإعادة الترميز لضمان توافق HLS.`);
    }
    if(streams.get(channelId)===runtime && !runtime.stopping && !runtime.paramError)scheduleChannelRestart(channelId);
  });
  return {ok:true,message:`تم إرسال أمر تشغيل القناة ${channel.name}`,channelId,pid:proc.pid};
}
function scheduleChannelRestart(channelId) {
  const rt=streams.get(channelId), channel=data.channels.find(c=>c.id===channelId);
  if(!rt||!channel||rt.stopping||rt.failedStop||!data.settings.autoRestartCrashed||rt.restartCount>=Number(data.settings.maxRestarts||20))return;
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
  if (!rt) {
    logLine(`إيقاف «${label}» (${channelId})${context}: لا توجد عملية تشغيل مسجّلة، القناة متوقفة أصلاً`);
    if (channel) clearChannelHls(channel);
    return {ok:true,message:'القناة متوقفة بالفعل',channelId};
  }
  rt.stopping=true;clearTimeout(rt.restartTimer);rt.restartTimer=null;
  if (!rt.proc) {
    logLine(`إيقاف «${label}» (${channelId})${context}: لا توجد عملية FFmpeg نشطة | آخر خروج: ${formatLastExit(rt.lastExit) || 'لا يوجد'}`);
    if (channel) clearChannelHls(channel);
    return {ok:true,message:'القناة متوقفة بالفعل',channelId};
  }
  const proc=rt.proc;
  const uptimeSec = rt.startedAt ? Math.round((Date.now() - new Date(rt.startedAt).getTime()) / 1000) : null;
  try {
    proc.kill();
    logLine(`إيقاف «${label}» (${channelId})${context}: أُرسلت إشارة الإيقاف إلى FFmpeg pid=${proc.pid}${uptimeSec !== null ? ` بعد تشغيل ${uptimeSec} ثانية` : ''}${rt.lastExit ? ` | آخر خروج: ${formatLastExit(rt.lastExit)}` : ''} | إعادات سابقة: ${rt.restartCount || 0}`);
    return {ok:true,message:'جارٍ إيقاف القناة؛ لن يعاد فتح المصدر قبل خروج FFmpeg',channelId};
  } catch(e) {
    logLine(`فشل إيقاف «${label}» (${channelId})${context}: ${e.message}`);
    return {ok:false,message:e.message,channelId};
  }
}
function restartChannel(channelId) {
  const rt=streams.get(channelId);
  if (!rt?.proc) return startChannel(channelId, true);
  // إعادة تشغيل قيد التنفيذ: لا تُسجَّل مستمعات خروج إضافية، وإلا بدأت نسختان من
  // FFmpeg عند حفظ إعدادات متتابع بسرعة. النسخة القادمة تقرأ أحدث إعدادات من data.
  if (rt.restartPending) return {ok:true,message:'إعادة التشغيل قيد التنفيذ (ستُطبَّق أحدث إعدادات)',channelId};
  rt.restartPending=true;
  const proc=rt.proc;
  const begin=()=>setTimeout(()=>startChannel(channelId, true),250);
  proc.once('exit',begin);
  const stopped=stopChannel(channelId);
  if (!stopped.ok) { rt.restartPending=false; return stopped; }
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

// تنفيذ أمر FFmpeg يمرّره محرك الالتقاط (DirectShow يحتاجه لتعداد الأجهزة).
function runFfmpegArgs(args) {
  return new Promise(resolve => {
    execFile(ffmpegBin(), args, { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => resolve({ err, output: `${stderr || ''}\n${stdout || ''}`.trim() }));
  });
}

function listDevices(res) {
  // التعداد وتحليل مخرجاته في طبقة الالتقاط؛ هنا تُبنى استجابة الـAPI فقط.
  // DirectShow يعدّد الأجهزة عبر FFmpeg.
  capture.discoverDevices(runFfmpegArgs).then(result => {
    if (!res) return console.log(result.output || 'لم تظهر أجهزة');
    return send(res, 200, {
      ok: true,
      video: result.video,
      audio: result.audio,
      devices: { video: result.video.map(v => v.value), audio: result.audio.map(a => a.value) },
      output: result.output || 'لم تظهر أجهزة',
      note: result.note,
      engine: capture.engineName()
    });
  }).catch(err => {
    if (!res) return console.log(err.message);
    return send(res, 200, {
      ok: true, video: [], audio: [], devices: { video: [], audio: [] },
      output: err.message, note: `تعذر فحص أجهزة الالتقاط: ${err.message}`, engine: capture.engineName()
    });
  });
}

function queryCaptureCapabilities(videoDevice, callback) {
  if (!videoDevice || String(videoDevice).length > 300 || /[\r\n\0]/.test(videoDevice)) {
    return callback(new Error('اسم جهاز الفيديو غير صالح'));
  }
  let capabilityArgs;
  try {
    capabilityArgs = capture.capabilitiesArgs(videoDevice);
  } catch (err) {
    return callback(err);
  }
  execFile(ffmpegBin(), capabilityArgs,
    { windowsHide: true, timeout: 20000, maxBuffer: 2*1024*1024 }, (err, stdout, stderr) => {
      const output = `${stderr || ''}\n${stdout || ''}`.trim();
      // تحليل قدرات الجهاز في محرك الالتقاط (DirectShow).
      const capabilities = capture.parseCapabilities(output);
      if (!capabilities.videoSizes.length) {
        const error = new Error(err && !output ? `تعذر تشغيل FFmpeg: ${err.message}` : 'لم يعرض FFmpeg أو تعريف الجهاز أوضاع فيديو قابلة للاستخراج');
        error.output = output;
        return callback(error);
      }
      callback(null, { capabilities, output });
    });
}

// اختبار الالتقاط: بناء الوسائط في طبقة الالتقاط، والتنفيذ (spawn/مهلة/جمع الخرج)
// يبقى هنا لأنه يحتاج مسار FFmpeg ومجلد المشروع.
function testCapture(body, callback) {
  const isAudio = body.mode === 'audio';
  let args;
  try {
    args = isAudio ? capture.testAudioArgs(body.audioDevice) : capture.testVideoArgs(body);
  } catch (err) {
    return callback(err);
  }
  const child = spawn(ffmpegBin(), args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let output = '';
  const timer = setTimeout(() => { try { child.kill(); } catch {} }, 10000);
  child.stderr.on('data', b => { output = (output + b.toString()).slice(isAudio ? -8000 : -12000); });
  child.on('error', e => {
    clearTimeout(timer);
    callback(new Error(isAudio ? e.message : `تعذر تشغيل FFmpeg: ${e.message}`));
  });
  child.on('close', code => {
    clearTimeout(timer);
    if (code === 0) {
      return callback(null, isAudio
        ? { ok: true, audio: true, output: 'نجح اختبار الصوت لمدة 3 ثوانٍ.' }
        : { ok: true, video: true, audio: !!String(body.audioDevice || '').trim(), output: 'نجح اختبار الالتقاط لمدة 3 ثوانٍ.' });
    }
    callback(new Error(isAudio
      ? `فشل اختبار الصوت (exit ${code}). ${output.slice(-1800)}`
      : `فشل اختبار الالتقاط (exit ${code}). ${output.slice(-2500)}`));
  });
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
  // لا تُخدم ملفات قناة متوقفة أو محذوفة: تمنع بقاء بث قديم متاحاً بعد الإيقاف.
  const ownerId = relative.split(/[\\/]/)[0];
  const owner = data.channels.find(c => c.id === ownerId);
  if (!owner || !streams.get(owner.id)?.proc) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('HLS stream is not available');
    return;
  }
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
    // عند وجود سجلّ Nginx تتكفّل قراءته بالعدّ (المقاطع تُخدَم من nginx مباشرةً).
    if (!nginxLogActive) {
      servedBytes += data.length;
      channelServedBytes.set(ownerId, (channelServedBytes.get(ownerId) || 0) + data.length);
    }
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
    const result = startChannel(channel.id, true);
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
    bumpSessionEpoch();
    clearAdminSession(res);
    return send(res, 200, { ok: true, message: 'تم تسجيل الخروج' });
  }

  const adminApiPath = url.pathname === '/api/channels' || url.pathname.startsWith('/api/channels/') || url.pathname === '/api/sources' || url.pathname.startsWith('/api/sources/') || url.pathname === '/api/settings' || url.pathname === '/api/stats' || url.pathname.startsWith('/api/devices') || url.pathname === '/api/start' || url.pathname === '/api/stop' || url.pathname === '/api/logs' || url.pathname.startsWith('/api/logs/') || url.pathname.startsWith('/api/backup') || url.pathname === '/api/upload' || url.pathname === '/api/metrics' || url.pathname.startsWith('/api/settings/') || url.pathname.startsWith('/api/nginx/');
  if (url.pathname === '/api/status' && req.method === 'GET') {
    // Status is intentionally public for the viewer page; it contains no credentials or filesystem paths.
  } else if (adminApiPath && !requireAdmin(req, res)) {
    if (url.pathname === '/api/stop' || url.pathname === '/api/start') logLine(`رفض ${url.pathname} (401) لعدم وجود مصادقة: ${clientInfo(req)}`);
    return;
  }
  // Admin/local management API: channel/source CRUD and settings persistence.
  if (url.pathname === '/api/channels' && req.method === 'GET') return send(res, 200, { ok: true, channels: data.channels.map(publicChannel) });
  if (url.pathname === '/api/sources' && req.method === 'GET') return send(res, 200, { ok: true, sources: data.sources.map(s => ({ ...s, url: s.streamUrl || '' })) });
  if (url.pathname === '/api/settings' && req.method === 'GET') {
    return send(res, 200, { ok: true, settings: data.settings, nginx: { binary: nginxExecutable(), binaryExists: nginxBinaryExists() } });
  }
  if (url.pathname === '/api/settings' && req.method === 'PUT') {
    let body; try { body = await readBody(req); } catch (e) { return apiError(res, 400, e.message); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError(res, 400, 'جسم الطلب غير صالح');
    const unexpectedSetting = unexpectedField(body, SETTINGS_WRITE_FIELDS);
    if (unexpectedSetting) return apiError(res, 400, `خاصية غير متوقعة في الإعدادات: ${unexpectedSetting}`);
    const previousPort = Number(data.settings.port), previousNginxPort = Number(data.settings.nginxPort);
    const textKeys = ['siteName','siteNameLatin','phone','ticker','logo','ffmpegPath','ffprobePath','nginxPath','streamUserAgent'];
    for (const key of textKeys) if (Object.prototype.hasOwnProperty.call(body,key)) {
      const value = String(body[key] ?? '');
      if (value.length > (key === 'ticker' ? 500 : (['ffmpegPath','ffprobePath','nginxPath'].includes(key) ? 1000 : 300))) return apiError(res,400,`قيمة ${key} أطول من المسموح`);
      data.settings[key] = value;
    }
    const boolKeys = ['tickerEnabled','autoStartOnDemand','capLevelToPlayerSize','cpuSaverDefault','autoRestartCrashed','idleStopEnabled','hideCosmeticLogs'];
    for (const key of boolKeys) if (Object.prototype.hasOwnProperty.call(body,key)) data.settings[key] = !!body[key];
    const numberRanges = {
      playerMaxBufferLength:[5,120], playerBackBufferLength:[0,120], playerLiveSyncDuration:[1,30],
      startupQueueDelayMs:[0,120000], startupConcurrency:[1,20], x264Threads:[1,64], hlsTime:[1,10], hlsListSize:[3,30], hlsDeleteThreshold:[1,100], port:[1024,65535], nginxPort:[1,65535],
      maxRestarts:[0,100], restartBackoffMs:[1000,120000], idleStopMinutes:[1,1440],
      sourceFailStopMinutes:[1,10000], blockedStopMinutes:[1,10000]
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
    if (Object.prototype.hasOwnProperty.call(body,'theme')) {
      const allowedThemes = ['default','worldcup'];
      if (!allowedThemes.includes(String(body.theme))) return apiError(res,400,'الثيم غير صالح');
      data.settings.theme = String(body.theme);
    }
    Object.assign(cfg, {
      ffmpegPath:data.settings.ffmpegPath||cfg.ffmpegPath, ffprobePath:data.settings.ffprobePath||cfg.ffprobePath, nginxPath:data.settings.nginxPath||cfg.nginxPath,
      port:data.settings.port||cfg.port, nginxPort:data.settings.nginxPort||cfg.nginxPort,
      startupQueueDelayMs:data.settings.startupQueueDelayMs,
      preset:data.settings.x264Preset, threads:data.settings.x264Threads, hlsTime:data.settings.hlsTime,
      hlsListSize:data.settings.hlsListSize, autoRestart:data.settings.autoRestartCrashed,
      maxRestarts:data.settings.maxRestarts, restartDelayMs:data.settings.restartBackoffMs
    });
    // المنفذ يُقرأ مرة واحدة عند الإقلاع، لذا تغييره يحتاج إعادة تشغيل؛ نُبلّغ اللوحة
    // لتظهر رسالة إعادة التشغيل بدل حفظ صامت لا أثر له.
    const restartRequired = Number(data.settings.port) !== previousPort;
    const nginxRestartRequired = Number(data.settings.nginxPort) !== previousNginxPort;
    writeData(data); syncNginxPorts(); return send(res, 200, { ok: true, settings: data.settings, restartRequired, nginxRestartRequired, message: 'تم حفظ الإعدادات. تغييرات المنافذ تتطلب إعادة تشغيل Node.js وNginx، وتغييرات الترميز تتطلب إعادة تشغيل القنوات.' });
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
    if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError(res, 400, 'جسم الطلب غير صالح');
    const unexpectedNew = unexpectedField(body, CHANNEL_WRITE_FIELDS);
    if (unexpectedNew) return apiError(res, 400, `خاصية غير متوقعة في إعدادات القناة: ${unexpectedNew}`);
    if (!String(body.name || '').trim()) return apiError(res, 400, 'اسم القناة مطلوب');
    if (body.sourceId && !data.sources.some(x => x.id === body.sourceId)) return apiError(res, 400, 'مصدر البث غير موجود');
    const channelId = 'ch_' + require('crypto').randomBytes(5).toString('hex');
    const chanId = String(body.chanId || '').trim();
    if (chanId && (!/^[a-zA-Z0-9_-]{1,40}$/.test(chanId) || data.channels.some(c => c.chanId === chanId))) return apiError(res, 400, 'معرّف القناة يجب أن يكون بالإنجليزية وفريداً');
    const sortValue = body.sort !== undefined ? body.sort : body.sortOrder;
    const channel = { id: channelId, chanId: chanId || channelId, name: String(body.name).trim().slice(0,100), category: String(body.category || 'عام').slice(0,80), sourceId: body.sourceId || data.sources[0]?.id || '', cover: String(body.cover || '').slice(0,500), enabled: body.enabled !== false, quality: String(body.quality || 'auto'), fps: body.fps ? Number(body.fps) : '', bitrate: String(body.bitrate||''), autoStart: !!body.autoStart, alwaysOn: !!body.alwaysOn, sortOrder: Number.isFinite(Number(sortValue)) ? Number(sortValue) : data.channels.length, url: `/hls/${channelId}/index.m3u8` };
    data.channels.push(channel); writeData(data); return send(res, 201, { ok: true, channel: publicChannel(channel) });
  }
  const channelMatch = url.pathname.match(/^\/api\/channels\/([a-zA-Z0-9_-]+)$/);
  if (channelMatch && req.method === 'PUT') {
    let body; try { body = await readBody(req); } catch (e) { return apiError(res, 400, e.message); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError(res, 400, 'جسم الطلب غير صالح');
    const unexpectedUpdate = unexpectedField(body, CHANNEL_WRITE_FIELDS);
    if (unexpectedUpdate) return apiError(res, 400, `خاصية غير متوقعة في إعدادات القناة: ${unexpectedUpdate}`);
    const channel = data.channels.find(c => c.id === channelMatch[1]);
    if (!channel) return apiError(res, 404, 'القناة غير موجودة');
    if (body.sourceId && !data.sources.some(x => x.id === body.sourceId)) return apiError(res, 400, 'مصدر البث غير موجود');
    if (Object.prototype.hasOwnProperty.call(body,'quality') && !['source','copy','auto','240p','288p','320p','360p','432p','480p','720p'].includes(String(body.quality))) return apiError(res,400,'جودة القناة غير صالحة');
    // null/'' يعني «استخدم الافتراضي 20» — نموذج القناة يرسل null عند إفراغ الحقل،
    // وكان يُرفض سابقاً فيتعذر حفظ القناة دون قيمة FPS.
    if (Object.prototype.hasOwnProperty.call(body,'fps') && body.fps !== '' && body.fps !== null && body.fps !== undefined && (!Number.isFinite(Number(body.fps)) || Number(body.fps)<1 || Number(body.fps)>60)) return apiError(res,400,'FPS يجب أن يكون بين 1 و60');
    if (Object.prototype.hasOwnProperty.call(body,'bitrate') && body.bitrate && !/^\d{2,5}k$/i.test(String(body.bitrate))) return apiError(res,400,'صيغة Bitrate غير صالحة؛ مثال 1500k');
    if (Object.prototype.hasOwnProperty.call(body,'chanId')) {
      const chanId = String(body.chanId || '').trim();
      if (chanId && (!/^[a-zA-Z0-9_-]{1,40}$/.test(chanId) || data.channels.some(c => c.chanId === chanId && c.id !== channel.id))) return apiError(res, 400, 'معرّف القناة يجب أن يكون بالإنجليزية وفريداً');
      channel.chanId = chanId || channel.id;
    }
    // إعدادات تؤثر في وسائط FFmpeg: تغييرها على قناة تعمل يحتاج إعادة تشغيل فورية.
    const encodingKeys = ['sourceId','quality','fps','bitrate'];
    const encodingBefore = {}; for (const key of encodingKeys) encodingBefore[key] = channel[key];
    for (const key of ['name','category','sourceId','cover','enabled','quality','fps','bitrate','autoStart','alwaysOn']) if (Object.prototype.hasOwnProperty.call(body,key)) channel[key] = body[key];
    if (channel.fps === null || channel.fps === undefined) channel.fps = '';
    if (Object.prototype.hasOwnProperty.call(body,'sort')) channel.sortOrder = Number(body.sort) || 0;
    else if (Object.prototype.hasOwnProperty.call(body,'sortOrder')) channel.sortOrder = Number(body.sortOrder) || 0;
    channel.url = `/hls/${channel.id}/index.m3u8`;
    const changedEncoding = encodingKeys.filter(key => String(encodingBefore[key] ?? '') !== String(channel[key] ?? ''));
    writeData(data);
    // إعادة التشغيل تلقائياً بدل مطالبة المستخدم بها: تُطبَّق القيم الجديدة فوراً
    // على قناة تعمل (وإلا بقيت تعمل بإعدادات الترميز القديمة حتى إعادة تشغيل يدوية).
    let restarted = false;
    if (changedEncoding.length && channel.enabled !== false && streams.get(channel.id)?.proc) {
      logLine(`تغيّرت إعدادات الترميز في «${channel.name}» (${changedEncoding.join(', ')})؛ إعادة تشغيل القناة تلقائياً`);
      restarted = restartChannel(channel.id).ok;
    }
    return send(res, 200, { ok: true, channel: publicChannel(channel), restarted, changedEncoding });
  }
  if (channelMatch && req.method === 'PATCH') {
    let body; try { body = await readBody(req); } catch (e) { return apiError(res, 400, e.message); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError(res, 400, 'جسم الطلب غير صالح');
    const unexpectedToggle = unexpectedField(body, CHANNEL_PATCH_FIELDS);
    if (unexpectedToggle) return apiError(res, 400, `خاصية غير متوقعة في إعدادات القناة: ${unexpectedToggle}`);
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
    if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError(res, 400, 'جسم الطلب غير صالح');
    const unexpectedSource = unexpectedField(body, SOURCE_WRITE_FIELDS);
    if (unexpectedSource) return apiError(res, 400, `خاصية غير متوقعة في إعدادات المصدر: ${unexpectedSource}`);
    const type = normalizeSourceType(body.type);
    if (!type) return apiError(res, 400, 'نوع المصدر غير مدعوم');
    if (!String(body.name || '').trim()) return apiError(res, 400, 'اسم المصدر مطلوب');
    const source = { id: 'src_' + require('crypto').randomBytes(5).toString('hex'), name: String(body.name).trim().slice(0,100), type, enabled: body.enabled !== false };
    const invalid = applySourceFields(source, body);
    if (invalid) return apiError(res, 400, invalid);
    // أبعاد الملف الحقيقية عبر FFprobe: تُستخدم في حساب أبعاد الخرج عند تشغيل القناة.
    if (source.type === 'file') {
      const dimensions = await probeFileDimensions(source.path);
      if (dimensions) source.videoSize = dimensions;
    }
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
    if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError(res, 400, 'جسم الطلب غير صالح');
    const unexpectedSource = unexpectedField(body, SOURCE_WRITE_FIELDS);
    if (unexpectedSource) return apiError(res, 400, `خاصية غير متوقعة في إعدادات المصدر: ${unexpectedSource}`);
    const source = data.sources.find(x => x.id === sourceMatch[1]);
    if (!source) return apiError(res, 404, 'مصدر البث غير موجود');
    const nextType = Object.prototype.hasOwnProperty.call(body, 'type') ? normalizeSourceType(body.type) : normalizeSourceType(source.type);
    if (!nextType) return apiError(res, 400, 'نوع المصدر غير مدعوم');
    const previousType = source.type;
    // التحقق قبل إيقاف القنوات المرتبطة: حفظ غير صالح أثناء التشغيل يجب أن يُرفض
    // دون قطع بث يعمل (كان الإيقاف يسبق التحقق فتتوقف القناة بلا إعادة تشغيل).
    const candidate = Object.assign({}, source, { type: nextType });
    if (previousType !== nextType) { delete candidate.streamUrl; delete candidate.path; delete candidate.videoDevice; }
    const invalid = applySourceFields(candidate, body);
    if (invalid) return apiError(res, 400, invalid);
    const linked = data.channels.filter(c => c.sourceId === source.id);
    const wasRunning = linked.filter(c => channelRuntime(c.id)?.proc).map(c => c.id);
    wasRunning.forEach(stopChannel);
    source.type = nextType;
    if (previousType !== nextType) { delete source.streamUrl; delete source.path; delete source.videoDevice; }
    applySourceFields(source, body);
    if (source.type === 'file') {
      const dimensions = await probeFileDimensions(source.path);
      if (dimensions) source.videoSize = dimensions;
    }
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
    const hlsBytes = hlsFileSizes().total;
    return send(res, 200, { ok: true, stats: { channels: { total: channels.length, running: channels.filter(c => c.live).length, error: channels.filter(c => c.status === 'error').length }, viewers, totalViewers: viewers, cpuPercent, memoryMb: Math.round(process.memoryUsage().rss/1048576), platform: process.platform, captureEngine: capture.engineName(), node: process.version, uptimeSeconds: Math.floor(process.uptime()), genBps: 0, outBps: 0, hlsBytes, servedBytes, devices: { total: data.sources.length, present: data.sources.filter(x => x.enabled !== false).length, video: data.sources.filter(x => x.enabled !== false).length, audio: data.sources.filter(x => x.enabled !== false && x.audioDevice).length }, nginx: null }, channels });
  }
  if (url.pathname.startsWith('/api/')) {
    // Continue to legacy routes below; unknown routes get a consistent JSON response.
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    return send(res, 200, { ok: true, ...getStatus(url.searchParams.get('channelId') || undefined) });
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
      return send(res, 200, { ok: true, capabilities: result.capabilities, note: capture.capabilitiesNote(), engine: capture.engineName() });
    });
  }

  const channelAction = url.pathname.match(/^\/api\/channels\/([a-zA-Z0-9_-]+)\/(start|stop|restart)$/);
  if (channelAction && req.method === 'POST') {
    const [,id,action]=channelAction;
    if(action==='stop') return send(res,200,stopChannel(id,clientInfo(req)));
    if(action==='restart')return send(res,202,restartChannel(id));
    logLine(`طلب تشغيل القناة ${id}: ${clientInfo(req)}`);
    return send(res,200,startChannel(id, true));
  }
  if (req.method === 'POST' && url.pathname === '/api/start') {
    logLine(`طلب تشغيل القنوات التلقائية: ${clientInfo(req)}`);
    const started=data.channels.filter(c=>c.enabled!==false && c.autoStart).map(c=>startChannel(c.id, true));
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
    const hlsBytesTotal = hlsFileSizes().total;
    return send(res, 200, {
      ok: true,
      cpuCount: os.cpus().length, cpuPercent, cpuLoad: os.loadavg()[0] || 0,
      uptimeSec: Math.floor(process.uptime()), memoryMB: Math.round(process.memoryUsage().rss / 1048576),
      ...systemMemory(),
      currentViewers: channels.reduce((sum, c) => sum + (c.viewers || 0), 0),
      watchedChannels: channels.filter(c => c.viewers > 0).length,
      totalViewers: totalViewerCount,
      runningChannels: channels.filter(c => c.status === 'running').length,
      totalChannels: channels.length,
      hlsBytesTotal, egressBytesTotal: servedBytes,
      // إجمالي حركة Nginx من السجلات + حصيلة عدّادات الشبكة منذ الإقلاع.
      nginxBytesTotal: nginxServedBytes, nginxLogActive,
      internetRxBytesTotal: internetRxTotal,
      ingestBandwidthBps: ingestBps, egressBandwidthBps: egressBps, internetBandwidthBps: internetBps
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
  // أوامر Nginx تُنفَّذ من المسار المحفوظ في settings.nginxPath، فيصبح هذا الحقل
  // فعّالاً بدل بقائه نصاً محفوظاً بلا أثر.
  if (req.method === 'POST' && url.pathname === '/api/nginx/action') {
    let body; try { body = await readBody(req); } catch (e) { return apiError(res, 400, e.message); }
    const action = String(body.action || 'test');
    const result = await nginxAction(action);
    logLine(`أمر Nginx «${action}»: ${result.ok ? 'نجح' : 'فشل'} — ${result.message}`);
    return send(res, result.ok ? 200 : 500, { ok: result.ok, action, binary: result.binary, output: result.output, message: result.message });
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
// نفس القاعدة موجودة في scripts/ports.js الذي تقرأه ملفات BAT، فأي قيمة غير
// صالحة في data.json أو PORT تُحوَّل إلى 3001 في الطرفين بدل اختلاف المنفذ.
function resolvePort(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}
const LISTEN_PORT = resolvePort(process.env.PORT || data.settings.port, 3001);
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
  // التعافي من أعطال المصدر: فشل متكرر أو حظر (403/451) يستمر حدّاً زمنياً يوقف
  // القناة بدل حلقة إعادة تشغيل لا تنتهي. تُصفَّر المؤقّتات بمجرد نجاح البث.
  for (const channel of data.channels) {
    const rt = channelRuntime(channel.id);
    if (!rt || rt.failedStop) continue;
    if (!rt.stopping && channelIsLive(channel)) { rt.failSince = null; rt.blockedSince = null; continue; }
    const failLimitMs = Math.max(1, Number(data.settings.sourceFailStopMinutes) || 3) * 60000;
    const blockLimitMs = Math.max(1, Number(data.settings.blockedStopMinutes) || 1000) * 60000;
    let reason = '';
    if (rt.blockedSince && now - rt.blockedSince >= blockLimitMs) {
      reason = `المصدر يحظر الاتصال (403) منذ ${Math.round((now - rt.blockedSince) / 60000)} دقيقة`;
    } else if (rt.failSince && now - rt.failSince >= failLimitMs) {
      reason = `المصدر يفشل منذ ${Math.round((now - rt.failSince) / 60000)} دقيقة`;
    }
    if (!reason) continue;
    rt.failedStop = true;
    clearTimeout(rt.restartTimer); rt.restartTimer = null;
    logLine(`إيقاف القناة ${channel.name}: ${reason} — الحدود من الإعدادات: فشل المصدر ${data.settings.sourceFailStopMinutes} دقيقة، حظر IPTV ${data.settings.blockedStopMinutes} دقيقة. أعد التشغيل يدوياً بعد إصلاح المصدر.`);
    appendChannelLog(channel.id, `إيقاف تلقائي: ${reason}`);
    stopChannel(channel.id, 'توقف تلقائي بعد استمرار العطل');
  }
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
  readNginxLogs();
  const elapsed = Math.max(1, (now - lastServedSample.at) / 1000);
  egressBps = Math.max(0, Math.round((servedBytes - lastServedSample.bytes) / elapsed));
  lastServedSample = { bytes: servedBytes, at: now };
  // netstat على ويندوز يستغرق وقتاً، فنمنع تداخل قراءتين.
  if (!internetProbeBusy) {
    internetProbeBusy = true;
    readSystemRx((err, rx) => {
      internetProbeBusy = false;
      if (err || rx == null) { internetBps = null; return; }
      const at = Date.now();
      if (internetRxTotal == null || rx < internetRxTotal) {
        internetRxTotal = rx; internetRxAt = at; internetBps = 0; return;
      }
      const seconds = Math.max(1, (at - internetRxAt) / 1000);
      internetBps = Math.max(0, Math.round((rx - internetRxTotal) / seconds));
      internetRxTotal = rx; internetRxAt = at;
    });
  }
  // باندويث الإدخال: نمو مقاطع HLS بين عينتين. يُحسب لكل ملف على حدة حتى لا
  // يُلغي حذف المقاطع القديمة (hlsDeleteThreshold) البايتات المولَّدة حديثاً.
  const hls = hlsFileSizes();
  let generated = 0;
  const generatedByChannel = new Map();
  if (lastHlsFiles.size) for (const [file, size] of hls.sizes) {
    const prev = lastHlsFiles.get(file) || 0;
    if (size > prev) {
      const delta = size - prev;
      generated += delta;
      // مجلد كل قناة يحمل معرّفها، فننسب بايتات مقاطعها إليها وحدها.
      const channelId = path.basename(path.dirname(file));
      generatedByChannel.set(channelId, (generatedByChannel.get(channelId) || 0) + delta);
    }
  }
  lastHlsFiles = hls.sizes;
  ingestBps = lastHlsFiles.size && generated ? Math.max(0, Math.round(generated / elapsed)) : 0;
  // معدّل البت الفعلي لكل قناة: تراكم البايتات + معدّل على نافذة 12 ثانية.
  for (const [channelId, bytes] of generatedByChannel) {
    channelGenBytes.set(channelId, (channelGenBytes.get(channelId) || 0) + bytes);
  }
  const sampleAt = Date.now();
  for (const [channelId, total] of channelGenBytes) {
    const snapshot = channelGenSnapshot.get(channelId);
    if (!snapshot) { channelGenSnapshot.set(channelId, { bytes: total, at: sampleAt }); continue; }
    const seconds = (sampleAt - snapshot.at) / 1000;
    if (seconds < 12) continue;
    const bps = Math.max(0, Math.round((total - snapshot.bytes) / seconds));
    channelOutputBps.set(channelId, bps);
    channelGenSnapshot.set(channelId, { bytes: total, at: sampleAt });
    // السجل للقنوات العاملة فقط: قناة متوقفة تُنتج صفراً فتظهر «أقل من الهدف» بلا معنى.
    const channel = data.channels.find(c => c.id === channelId);
    const source = channel ? sourceForChannel(channel) : null;
    if (channel && source && channelRuntime(channelId)?.proc) logBitrateWindow(channel, source, bps, seconds);
  }
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
  removePidFile();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);