'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const os = require('os');

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

// API model: persisted locally in data.json. This release runs one capture pipeline
// (one physical DirectShow input) and exposes it as a configurable channel.
const DATA_PATH = path.resolve(process.env.DATA_FILE || path.join(ROOT, 'data.json'));
function defaultData() {
  const sourceId = 'src_local_usb';
  return {
    settings: {
      siteName: cfg.siteName || 'البرنس لايف',
      siteNameLatin: cfg.siteNameLatin || 'BRINCE Live',
      phone: cfg.phone || '',
      ticker: cfg.ticker || 'أهلاً بكم في البرنس لايف — البث المباشر المحلي',
      tickerEnabled: cfg.tickerEnabled !== false,
      logo: cfg.logo || 'logo.png',
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
      x264Preset: cfg.preset || 'veryfast',
      x264Threads: Number(cfg.threads) || 2,
      hlsTime: Number(cfg.hlsTime) || 2,
      hlsListSize: Number(cfg.hlsListSize) || 6,
      hlsDeleteThreshold: Number(cfg.hlsDeleteThreshold) || 4,
      port: Number(cfg.port)||3001, nginxPort: Number(cfg.nginxPort)||80,
      autoRestartCrashed: cfg.autoRestart !== false,
      maxRestarts: Number(cfg.maxRestarts) || 20,
      restartBackoffMs: Number(cfg.restartDelayMs) || 5000,
      idleStopEnabled: !!cfg.idleStopEnabled,
      idleStopMinutes: Number(cfg.idleStopMinutes) || 2,
    },
    sources: [{ id: sourceId, name: 'مصدر USB المحلي', type: 'usb', videoDevice: cfg.videoDevice || 'USB Video', audioDevice: cfg.audioDevice || '', videoSize: cfg.videoSize || '1280x720', fps: Number(cfg.captureFps) || 30, pixelFormat: cfg.inputPixelFormat || 'mjpeg', enabled: true }],
    channels: [{ id: 'ch_local', name: 'مباريات', category: 'رياضة', sourceId, cover: '', enabled: true, quality: `${Number(cfg.outputHeight)||360}p`, fps: Number(cfg.outputFps)||20, bitrate: cfg.videoBitrate || '500k', autoStart: false, url: '/hls/index.m3u8' }]
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
data.settings = { ...defaultData().settings, ...data.settings };
Object.assign(cfg, {
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
function publicChannel(channel) {
  const source = sourceForChannel(channel);
  const runtime = channelRuntime(channel.id);
  let playlistExists = false, playlistAgeMs = null;
  try { const st = fs.statSync(playlistPath(channel)); playlistExists = st.isFile(); playlistAgeMs = Date.now() - st.mtimeMs; } catch {}
  const live = !!(channel.enabled && runtime?.proc && playlistExists && playlistAgeMs < 15000);
  const viewers = [...viewerSessions.values()].filter(v => v.channelId === channel.id && Date.now()-v.lastSeen <= 45000).length;
  return { ...channel, url: `/hls/${channel.id}/index.m3u8`, device: source?.videoDevice || '', sourceName: source?.name || '', live,
    status: live ? 'running' : (!channel.enabled ? 'disabled' : (runtime?.proc ? 'starting' : (runtime?.lastExit ? 'error' : 'stopped'))),
    state: live ? 'running' : 'stopped', pid: runtime?.proc?.pid || null, viewers, restarts: runtime?.restartCount || 0,
    lastError: runtime?.lastExit || '' };
}

function readBody(req, maxBytes=1024*1024) {
  return new Promise((resolve, reject) => {
    let raw = ''; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > maxBytes) { reject(new Error('حجم الطلب كبير')); req.destroy(); return; } raw += chunk; });
    req.on('end', () => { if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON غير صالح')); } });
    req.on('error', reject);
  });
}
function apiError(res, code, message) { return send(res, code, { ok: false, error: message, message }); }
function safeId(value) { return /^[a-zA-Z0-9_-]{1,80}$/.test(String(value || '')); }
function getNetworkInterfaces() {
  const result = [];
  const all = os.networkInterfaces();
  for (const [name, addresses] of Object.entries(all)) {
    for (const item of (addresses || [])) {
      if (item.family !== 'IPv4' || item.internal || !item.address || item.address.startsWith('169.254.')) continue;
      result.push({ name, address: item.address, netmask: item.netmask || '', cidr: item.cidr || '', url: `http://${item.address}/`, adminUrl: `http://${item.address}/admin` });
    }
  }
  return result.sort((a, b) => {
    const rank = x => /wi-?fi|wireless/i.test(x.name) ? 0 : /ethernet/i.test(x.name) ? 1 : 2;
    return rank(a) - rank(b) || a.name.localeCompare(b.name) || a.address.localeCompare(b.address);
  });
}
function isAdminAuthorized(req) {
  const expectedUser = String(cfg.adminUsername || 'admin');
  const expectedPassword = String(cfg.adminPassword || '');
  const header = String(req.headers.authorization || '');
  if (!expectedPassword || !header.startsWith('Basic ')) return false;
  let decoded = '';
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const split = decoded.indexOf(':');
  if (split < 0) return false;
  const user = decoded.slice(0, split), password = decoded.slice(split + 1);
  const a = Buffer.from(`${expectedUser}:${expectedPassword}`);
  const b = Buffer.from(`${user}:${password}`);
  return a.length === b.length && require('crypto').timingSafeEqual(a, b);
}
function requireAdmin(req, res) {
  if (isAdminAuthorized(req)) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm=\"Prince Live Admin\", charset=\"UTF-8\"', 'Cache-Control': 'no-store' });
  res.end('Authentication required');
  return false;
}

fs.mkdirSync(HLS_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

function safeText(value) {
  return String(value ?? '').replace(/[\r\n]/g, ' ').slice(0, 1000);
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
  if (!channel) return { siteName: data.settings.siteName || cfg.siteName || 'البرنس لايف', running: false, playlistExists: false, channels: data.channels.map(publicChannel) };
  const source = sourceForChannel(channel), runtime = channelRuntime(channel.id);
  let playlistExists = false, playlistAgeMs = null;
  try { const st = fs.statSync(playlistPath(channel)); playlistExists = st.isFile(); playlistAgeMs = Date.now() - st.mtimeMs; } catch {}
  return { siteName: data.settings.siteName || cfg.siteName || 'البرنس لايف', ticker: data.settings.ticker || cfg.ticker || '',
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
    text=text.replace(/(proxy_pass\s+http:\/\/127\.0\.0\.1:)\d+(\s*;)/,`$1${Number(data.settings.port)||3001}$2`);
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

function buildArgs(channel, forceTranscode = false) {
  const source = sourceForChannel(channel);
  if (!channel || channel.enabled === false) throw new Error('القناة غير موجودة أو معطلة');
  if (!source || source.enabled === false) throw new Error('مصدر البث غير موجود أو معطل');
  const settings = data.settings;
  const [srcW, srcH] = String(source.videoSize || cfg.videoSize || '1280x720').split('x').map(Number);
  const outputHeight = channel.quality === 'source' ? (srcH || 720) : Number(String(channel.quality || '').replace(/p$/i,'')) || 360;
  const derivedWidth=Math.max(160,Math.round((srcW||1280)*outputHeight/(srcH||720)/2)*2);
  const configuredWidth=Number(settings.outputWidth)||640;
  const outputWidth=channel.quality==='source'?(srcW||1280):(outputHeight===(Number(settings.outputHeight)||360)?configuredWidth:derivedWidth);
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
  } else {
    const inputSpec = audioDevice ? `video=${source.videoDevice}:audio=${audioDevice}` : `video=${source.videoDevice}`;
    args.push('-f','dshow','-rtbufsize','256M','-framerate',String(Number(source.fps)||30),'-video_size',String(source.videoSize||'1280x720'));
    if (source.pixelFormat) args.push('-pixel_format',String(source.pixelFormat));
    args.push('-i',inputSpec);
  }
  // Conservative HLS-safe remux: only network inputs can request source-copy; USB capture is always encoded.
  if (channel.quality === 'source' && !isNetwork) throw new Error('نسخ المصدر دون إعادة ترميز غير متاح لهذا النوع من التقاط USB؛ اختر 240p أو 360p أو 480p أو 720p.');
  if (channel.quality === 'source' && isNetwork && !forceTranscode) {
    args.push('-map','0:v:0','-map','0:a:0?','-c:v','copy','-c:a','aac','-b:a',cfg.audioBitrate||'96k');
  } else {
    args.push('-map','0:v:0','-vf',`scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=decrease,pad=${outputWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2,fps=${outputFps}`,
      '-c:v','libx264','-preset',settings.x264Preset||'veryfast','-pix_fmt','yuv420p','-threads',String(Number(settings.x264Threads)||2),
      '-r',String(outputFps),'-g',String(gop),'-keyint_min',String(gop),'-sc_threshold','0');
    if(settings.x264QualityMode===true) args.push('-crf','23');
    else args.push('-b:v',videoBitrate,'-maxrate',videoBitrate,'-bufsize','1000k');
    if (isNetwork || audioDevice) args.push('-map','0:a:0?','-af','aresample=async=1:first_pts=0','-c:a','aac','-b:a',cfg.audioBitrate||'96k','-ar',String(Number(cfg.audioSampleRate)||44100),'-ac',String(Number(cfg.audioChannels)||2));
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
  proc.stderr.on('data',b=>{const m=b.toString().trim();if(m)logLine(`[${channel.name}] FFmpeg: ${m}`);});
  proc.on('error',e=>{runtime.lastExit=e.message;runtime.proc=null;logLine(`[${channel.name}] تعذر تشغيل FFmpeg: ${e.message}`);scheduleChannelRestart(channelId);});
  proc.on('exit',(code,signal)=>{
    runtime.lastExit=`code=${code}; signal=${signal||''}`;
    runtime.proc=null;
    logLine(`[${channel.name}] انتهى FFmpeg: ${runtime.lastExit}`);
    const currentSource=sourceForChannel(channel);
    const networkSource=currentSource && ['http-hls','http','hls','network','rtsp'].includes(String(currentSource.type||'').toLowerCase());
    if(code!==0 && channel.quality==='source' && networkSource && !runtime.forceTranscode && !runtime.stopping){
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
function stopChannel(channelId) {
  const rt=streams.get(channelId); if(!rt)return {ok:true,message:'القناة متوقفة بالفعل',channelId};
  rt.stopping=true;clearTimeout(rt.restartTimer);rt.restartTimer=null;
  if(!rt.proc)return {ok:true,message:'القناة متوقفة بالفعل',channelId};
  const proc=rt.proc;
  try{proc.kill();logLine(`تم إرسال أمر إيقاف القناة ${channelId}`);return {ok:true,message:'جارٍ إيقاف القناة؛ لن يعاد فتح المصدر قبل خروج FFmpeg',channelId};}
  catch(e){return {ok:false,message:e.message,channelId};}
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
function startStream() { const channel=activeChannel(); return channel?startChannel(channel.id):{ok:false,message:'لا توجد قنوات'}; }
function stopStream() { let results=data.channels.map(c=>stopChannel(c.id));return {ok:true,message:'تم إرسال أوامر إيقاف جميع القنوات',results}; }

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
          devices: { video, audio },
          output: output || (err ? err.message : 'لم تظهر أجهزة'),
          note: err && !output ? `تعذر تشغيل فحص FFmpeg: ${err.message}` : 'قوائم الفيديو والصوت مستخرجة من أجهزة DirectShow التي يعرضها FFmpeg.'
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

function testNetworkCapture(body, callback) {
  let streamUrl;try{streamUrl=validateNetworkStreamUrl(body.streamUrl);}catch(e){return callback(e);}
  const args=['-hide_banner','-loglevel','error'];
  if(/^rtsp:/i.test(streamUrl))args.push('-rtsp_transport','tcp');
  else args.push('-rw_timeout','10000000');
  args.push('-i',streamUrl,'-t','3','-f','null','-');
  const child=spawn(ffmpegBin(),args,{cwd:ROOT,windowsHide:true,stdio:['ignore','ignore','pipe']});
  let output='';const timer=setTimeout(()=>{try{child.kill();}catch{}},12000);
  child.stderr.on('data',b=>{output=(output+b.toString()).slice(-12000);});
  child.on('error',e=>{clearTimeout(timer);callback(new Error(`تعذر تشغيل FFmpeg: ${e.message}`));});
  child.on('close',code=>{clearTimeout(timer);if(code===0)callback(null,{ok:true,output:'نجح اختبار المصدر الشبكي لمدة 3 ثوانٍ.'});else callback(new Error(`فشل اختبار المصدر الشبكي (exit ${code}). ${output.slice(-2500)}`));});
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
    if (!requireAdmin(req, res)) return;
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
    const {siteName,siteNameLatin,logo,ticker,tickerEnabled,phone,playerMaxBufferLength,playerBackBufferLength,playerLiveSyncDuration,capLevelToPlayerSize,cpuSaverDefault}=data.settings;
    return send(res, 200, { ok: true, settings: {siteName,siteNameLatin,logo,ticker,tickerEnabled,phone,playerMaxBufferLength,playerBackBufferLength,playerLiveSyncDuration,capLevelToPlayerSize,cpuSaverDefault} });
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
    viewerSessions.set(id, { channelId, lastSeen: Date.now() });
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/public/leave' && req.method === 'POST') {
    let body; try { body = await readBody(req); } catch (e) { return apiError(res, 400, e.message); }
    if (body.viewerId) viewerSessions.delete(String(body.viewerId));
    return send(res, 200, { ok: true });
  }
  const adminApiPath = url.pathname === '/api/channels' || url.pathname.startsWith('/api/channels/') || url.pathname === '/api/sources' || url.pathname.startsWith('/api/sources/') || url.pathname === '/api/settings' || url.pathname === '/api/stats' || url.pathname.startsWith('/api/devices') || url.pathname === '/api/start' || url.pathname === '/api/stop' || url.pathname === '/api/logs';
  if (url.pathname === '/api/status' && req.method === 'GET') {
    // Status is intentionally public for the viewer page; it contains no credentials or filesystem paths.
  } else if (adminApiPath && !requireAdmin(req, res)) return;
  // Admin/local management API: channel/source CRUD and settings persistence.
  if (url.pathname === '/api/channels' && req.method === 'GET') return send(res, 200, { ok: true, channels: data.channels.map(publicChannel) });
  if (url.pathname === '/api/sources' && req.method === 'GET') return send(res, 200, { ok: true, sources: data.sources });
  if (url.pathname === '/api/settings' && req.method === 'GET') return send(res, 200, { ok: true, settings: data.settings });
  if (url.pathname === '/api/settings' && req.method === 'PUT') {
    let body; try { body = await readBody(req); } catch (e) { return apiError(res, 400, e.message); }
    const textKeys = ['siteName','siteNameLatin','phone','ticker','logo','ffmpegPath','ffprobePath','nginxPath'];
    for (const key of textKeys) if (Object.prototype.hasOwnProperty.call(body,key)) {
      const value = String(body[key] ?? '');
      if (value.length > (key === 'ticker' ? 500 : (['ffmpegPath','ffprobePath','nginxPath'].includes(key) ? 1000 : 300))) return apiError(res,400,`قيمة ${key} أطول من المسموح`);
      data.settings[key] = value;
    }
    const boolKeys = ['tickerEnabled','autoStartOnDemand','capLevelToPlayerSize','cpuSaverDefault','x264QualityMode','autoRestartCrashed','idleStopEnabled'];
    for (const key of boolKeys) if (Object.prototype.hasOwnProperty.call(body,key)) data.settings[key] = !!body[key];
    const numberRanges = {
      playerMaxBufferLength:[5,120], playerBackBufferLength:[0,120], playerLiveSyncDuration:[1,30],
      outputWidth:[160,3840], outputHeight:[120,2160], outputFps:[1,60], gopSeconds:[1,10],
      startupQueueDelayMs:[0,120000], x264Threads:[1,64], hlsTime:[1,10], hlsListSize:[3,30], hlsDeleteThreshold:[1,100], port:[1024,65535], nginxPort:[1,65535],
      maxRestarts:[0,100], restartBackoffMs:[1000,120000], idleStopMinutes:[1,1440]
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
  if (url.pathname === '/api/channels' && req.method === 'POST') {
    let body; try { body = await readBody(req); } catch (e) { return apiError(res, 400, e.message); }
    if (!String(body.name || '').trim()) return apiError(res, 400, 'اسم القناة مطلوب');
    if (body.sourceId && !data.sources.some(x => x.id === body.sourceId)) return apiError(res, 400, 'مصدر البث غير موجود');
    const channelId = 'ch_' + require('crypto').randomBytes(5).toString('hex');
    const channel = { id: channelId, name: String(body.name).trim().slice(0,100), category: String(body.category || 'عام').slice(0,80), sourceId: body.sourceId || data.sources[0]?.id || '', cover: String(body.cover || '').slice(0,500), enabled: body.enabled !== false, quality: String(body.quality || '360p'), fps: Number(body.fps)||20, bitrate: String(body.bitrate||'500k'), autoStart: !!body.autoStart, alwaysOn: !!body.alwaysOn, sortOrder: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : data.channels.length, url: `/hls/${channelId}/index.m3u8` };
    data.channels.push(channel); writeData(data); return send(res, 201, { ok: true, channel: publicChannel(channel) });
  }
  const channelMatch = url.pathname.match(/^\/api\/channels\/([a-zA-Z0-9_-]+)$/);
  if (channelMatch && req.method === 'PUT') {
    let body; try { body = await readBody(req); } catch (e) { return apiError(res, 400, e.message); }
    const channel = data.channels.find(c => c.id === channelMatch[1]);
    if (!channel) return apiError(res, 404, 'القناة غير موجودة');
    if (body.sourceId && !data.sources.some(x => x.id === body.sourceId)) return apiError(res, 400, 'مصدر البث غير موجود');
    if (Object.prototype.hasOwnProperty.call(body,'quality') && !['source','240p','360p','480p','720p'].includes(String(body.quality))) return apiError(res,400,'جودة القناة غير صالحة');
    if (Object.prototype.hasOwnProperty.call(body,'fps') && body.fps !== '' && (!Number.isFinite(Number(body.fps)) || Number(body.fps)<1 || Number(body.fps)>60)) return apiError(res,400,'FPS يجب أن يكون بين 1 و60');
    if (Object.prototype.hasOwnProperty.call(body,'bitrate') && body.bitrate && !/^\d{2,5}k$/i.test(String(body.bitrate))) return apiError(res,400,'صيغة Bitrate غير صالحة؛ مثال 1500k');
    for (const key of ['name','category','sourceId','cover','enabled','quality','fps','bitrate','autoStart','alwaysOn','sortOrder']) if (Object.prototype.hasOwnProperty.call(body,key)) channel[key] = body[key];
    channel.url = `/hls/${channel.sourceId}/index.m3u8`;
    writeData(data); return send(res, 200, { ok: true, channel: publicChannel(channel) });
  }
  if (channelMatch && req.method === 'DELETE') {
    const index = data.channels.findIndex(c => c.id === channelMatch[1]);
    if (index < 0) return apiError(res, 404, 'القناة غير موجودة');
    
    stopChannel(channelMatch[1]); data.channels.splice(index,1); writeData(data); return send(res, 200, { ok: true, message: 'تم حذف القناة' });
  }
  if (url.pathname === '/api/sources' && req.method === 'POST') {
    let body; try { body = await readBody(req); } catch (e) { return apiError(res, 400, e.message); }
    const type = ['http-hls','rtsp','usb'].includes(String(body.type || 'usb')) ? String(body.type || 'usb') : '';
    if (!type) return apiError(res, 400, 'نوع المصدر غير مدعوم');
    if (!String(body.name || '').trim()) return apiError(res, 400, 'اسم المصدر مطلوب');
    let streamUrl = '';
    if (type === 'http-hls' || type === 'rtsp') { try { streamUrl = validateNetworkStreamUrl(body.streamUrl); } catch (e) { return apiError(res, 400, e.message); } }
    else if (!String(body.videoDevice || '').trim()) return apiError(res, 400, 'جهاز الفيديو مطلوب لمصدر USB');
    const source = { id: 'src_' + require('crypto').randomBytes(5).toString('hex'), name: String(body.name).trim().slice(0,100), type, streamUrl, videoDevice: String(body.videoDevice||'').slice(0,300), audioDevice: String(body.audioDevice||'').slice(0,300), videoSize: String(body.videoSize||'1280x720'), fps: Number(body.fps)||30, pixelFormat: String(body.pixelFormat||'mjpeg'), enabled: body.enabled !== false };
    data.sources.push(source);
    const channelId = 'ch_' + require('crypto').randomBytes(5).toString('hex');
    const channel = {
      id: channelId,
      name: source.name, category: 'عام', sourceId: source.id, cover: '',
      enabled: true, quality: '360p', fps: '', bitrate: '',
      autoStart: false, alwaysOn: false, sortOrder: data.channels.length,
      url: `/hls/${channelId}/index.m3u8`
    };
    data.channels.push(channel);
    writeData(data);
    return send(res, 201, { ok: true, source, channel: publicChannel(channel), message: 'تمت إضافة المصدر وإنشاء قناة مرتبطة به تلقائياً' });
  }
  if (url.pathname === '/api/sources/test' && req.method === 'POST') {
    let body;try{body=await readBody(req);}catch(e){return apiError(res,400,e.message);}
    return testNetworkCapture(body,(err,result)=>err?apiError(res,422,err.message):send(res,200,{ok:true,result}));
  }
  const sourceMatch = url.pathname.match(/^\/api\/sources\/([a-zA-Z0-9_-]+)$/);
  if (sourceMatch && req.method === 'PUT') {
    let body; try { body = await readBody(req); } catch (e) { return apiError(res, 400, e.message); }
    const source = data.sources.find(x => x.id === sourceMatch[1]);
    if (!source) return apiError(res, 404, 'مصدر البث غير موجود');
    const nextType=Object.prototype.hasOwnProperty.call(body,'type')?String(body.type):String(source.type||'usb');
    if(!['usb','http-hls','rtsp'].includes(nextType))return apiError(res,400,'نوع المصدر غير مدعوم');
    const nextVideo=Object.prototype.hasOwnProperty.call(body,'videoDevice')?String(body.videoDevice||''):String(source.videoDevice||'');
    const nextUrl=Object.prototype.hasOwnProperty.call(body,'streamUrl')?String(body.streamUrl||''):String(source.streamUrl||'');
    if(nextType==='usb'&&!nextVideo.trim())return apiError(res,400,'جهاز الفيديو مطلوب لمصدر USB');
    let validatedUrl='';
    if(nextType==='http-hls'||nextType==='rtsp'){try{validatedUrl=validateNetworkStreamUrl(nextUrl);}catch(e){return apiError(res,400,e.message);}}
    const linked=data.channels.filter(c=>c.sourceId===source.id);
    const wasRunning=linked.filter(c=>channelRuntime(c.id)?.proc).map(c=>c.id);
    wasRunning.forEach(stopChannel);
    source.type=nextType;
    if(nextType==='http-hls'||nextType==='rtsp')source.streamUrl=validatedUrl;
    for(const key of ['name','videoDevice','audioDevice','videoSize','fps','pixelFormat','enabled'])if(Object.prototype.hasOwnProperty.call(body,key))source[key]=body[key];
    writeData(data);
    wasRunning.forEach(id=>{
      const rt=streams.get(id);
      if(rt?.proc){const proc=rt.proc;proc.once('exit',()=>setTimeout(()=>startChannel(id),250));}
      else setTimeout(()=>startChannel(id),250);
    });
    return send(res,200,{ok:true,source,restartedChannels:wasRunning,message:'تم حفظ المصدر؛ ستُعاد القنوات التي كانت تعمل بعد إغلاق عمليات FFmpeg السابقة.'});
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
    if(action==='stop') return send(res,200,stopChannel(id));
    if(action==='restart')return send(res,202,restartChannel(id));
    return send(res,200,startChannel(id));
  }
  if (req.method === 'POST' && url.pathname === '/api/start') {
    const started=data.channels.filter(c=>c.enabled!==false && c.autoStart).map(c=>startChannel(c.id));
    return send(res,200,{ok:true,message:'تم إرسال أوامر تشغيل القنوات المحددة للتشغيل التلقائي',results:started});
  }
  if (req.method === 'POST' && url.pathname === '/api/stop') return send(res,200,stopStream());

  if (req.method === 'GET' && url.pathname === '/api/logs') {
    return send(res, 200, { logs: ffmpegLog });
  }

  if (url.pathname.startsWith('/api/')) {
    return send(res, 404, { error: 'Not found' });
  }

  return serveStatic(req, res);
});

// يمكن تجاوز المنفذ والعنوان بمتغيري البيئة PORT وHOST (يفيد التشغيل في حاوية
// أو خلف وكيل)، وتبقى القيم الافتراضية من config.json كما هي على Windows.
const LISTEN_PORT = Number(process.env.PORT || cfg.port) || 3001;
const LISTEN_HOST = process.env.HOST || cfg.host || '127.0.0.1';

server.on('error', err => {
  if (err.code === 'EADDRINUSE') logLine(`تعذر بدء الخادم: المنفذ ${LISTEN_PORT} مستخدم بالفعل. أغلق النسخة الأخرى من الخادم أو غيّر المنفذ من config.json.`);
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

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  logLine(`الخادم يعمل على http://${LISTEN_HOST}:${LISTEN_PORT} (منفذ Nginx: ${Number(data.settings.nginxPort) || 80})`);
  for (const item of getNetworkInterfaces()) logLine(`رابط المشاهدة: ${item.url} | الواجهة: ${item.name}`);
  if (process.argv.includes('--devices')) listDevices();
  const bootChannels=data.channels.filter(c=>c.enabled!==false && (c.autoStart||c.alwaysOn));
  bootChannels.forEach((c,i)=>setTimeout(()=>startChannel(c.id),Math.max(0,Number(data.settings.startupQueueDelayMs)||0)+i*1000));
});

function shutdown() {
  stopStream();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
