'use strict';
// محرك الالتقاط على Linux — Video4Linux2 للفيديو وALSA للصوت.
//
// يوفّر الواجهة نفسها التي يوفّرها محرك DirectShow، فلا يعرف server.js أي محرك يعمل:
//   deviceListArgs() / parseDeviceList(output) / describeDevices(...)
//   discover()  — تعداد حقيقي من /dev و/sys و/proc دون تشغيل FFmpeg
//   capabilitiesArgs(device) / parseCapabilities(output) / capabilitiesNote()
//   inputPlan(source) — وسائط إدخال الفيديو، وإدخال ALSA منفصل عند وجود جهاز صوت
//   testVideoArgs(body) / testAudioArgs(device)
//
// الفرق الجوهري عن DirectShow: إدخال v4l2 لا يحمل صوتاً، فتأتي كل بطاقة صوت من
// إدخال FFmpeg ثانٍ (`-f alsa -i plughw:N`). لذلك يُعيد inputPlan فهرس إدخال
// الصوت (`audioInputIndex`) لتضبط server.js خرائط `-map` بدقة.
//
// المسارات تُتحقق قبل تمريرها إلى FFmpeg: /dev/video* أو رابط تحت /dev/v4l/...

const fs = require('fs');
const path = require('path');
const { clampNumber } = require('../shared/clamp');
const { buildCapabilities } = require('./capabilities');

const DEVICE_PATH = /^\/dev\/[A-Za-z0-9._/-]{1,140}$/;
const ALSA_NAME = /^(?:default|(?:plug)?hw:\d+(?:,\d+)?)$/;
const FORMAT_NAME = /^[a-z0-9_]{2,30}$/;

// ---------------------------------------------------------------- تحقق المسارات
// يقبل: /dev/video0، /dev/v4l/by-id/...، أو اختصاراً "0" و"video2".
function normalizeVideoDevice(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 300 || /[\r\n\0]/.test(raw)) return '';
  if (raw.startsWith('/dev/')) return DEVICE_PATH.test(raw) && !raw.includes('..') ? raw : '';
  const short = raw.match(/^(?:video)?(\d{1,3})$/i);
  return short ? `/dev/video${Number(short[1])}` : '';
}

// يقبل: default، plughw:1، hw:1,0، أو رقم بطاقة "1" (يعني plughw:1).
function normalizeAudioDevice(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 120 || /[\r\n\0]/.test(raw)) return '';
  if (ALSA_NAME.test(raw)) return raw;
  const short = raw.match(/^(?:card)?(\d{1,3})$/i);
  return short ? `plughw:${Number(short[1])}` : '';
}

// ---------------------------------------------------------------- تعداد الأجهزة
// v4l2 لا يوفّر أمر تعداد في FFmpeg: نقرأ عقد الجهاز من النظام نفسه.
// كل جهاز فيزيائي يظهر عادة بعقدتين (index=0 للفيديو وindex>0 للأوصاف)، فنُبقي index=0.
function parseVideoDevices(entries) {
  const seen = new Set();
  const rows = [];
  for (const entry of entries || []) {
    const value = String(entry?.value || '').trim();
    if (!value || seen.has(value)) continue;
    const index = Number(entry?.index);
    if (Number.isFinite(index) && index > 0) continue;
    seen.add(value);
    rows.push({ value, label: String(entry?.label || '').trim() || value });
  }
  return rows.sort((a, b) => a.value.localeCompare(b.value, undefined, { numeric: true }));
}

function readTextSafe(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function scanVideoDevices(options = {}) {
  const devRoot = options.devRoot || '/dev';
  const sysRoot = options.sysRoot || '/sys/class/video4linux';
  const readdir = options.readdir || (dir => fs.readdirSync(dir));
  const readText = options.readText || readTextSafe;
  let names = [];
  try { names = readdir(devRoot) || []; } catch { return []; }
  const entries = [];
  for (const name of names) {
    if (!/^video\d+$/.test(String(name))) continue;
    entries.push({
      value: path.posix.join(devRoot, String(name)),
      label: readText(path.posix.join(sysRoot, String(name), 'name')),
      index: readText(path.posix.join(sysRoot, String(name), 'index')),
    });
  }
  return parseVideoDevices(entries);
}

// /proc/asound/cards:
//  0 [Device         ]: USB-Audio - USB Audio Device
//                       Generic USB Audio Device at usb-0000:00:14.0-1, full speed
function parseAlsaCards(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    // الفاصل بين المعرّف والاسم هو " - " بمسافات، وقد يحتوي اسم المعرّف نفسه شرطة (USB-Audio).
    const match = line.match(/^\s*(\d{1,3})\s+\[([^\]]*)\]:\s*(.+?)\s+-\s+(.*)$/);
    if (!match) continue;
    const card = Number(match[1]);
    const id = match[2].trim();
    const name = match[4].trim() || id;
    if (!Number.isFinite(card)) continue;
    rows.push({ value: `plughw:${card}`, label: `${name} (ALSA)` });
  }
  return rows;
}

function scanAudioDevices(options = {}) {
  const cardsFile = options.cardsFile || '/proc/asound/cards';
  const readText = options.readText || readTextSafe;
  return parseAlsaCards(readText(cardsFile));
}

function describeDevices(devices, err, output) {
  const video = devices?.video || [];
  const audio = devices?.audio || [];
  if (err && !output) return `تعذر فحص أجهزة الالتقاط: ${err.message}`;
  return video.length || audio.length
    ? 'قوائم الفيديو والصوت مستخرجة من أجهزة V4L2 (/dev/video*) وبطاقات ALSA في النظام.'
    : 'لم يُعثر على أي جهاز V4L2 (/dev/video*) أو بطاقة ALSA متاحة.';
}

// تعداد كامل يعيد الشكل الذي تتوقعه server.js: عناصر {value,label} ونص تشخيصي.
function discover(options = {}) {
  const video = scanVideoDevices(options);
  const audio = scanAudioDevices(options);
  const summary = [
    video.length ? `V4L2: ${video.map(v => v.value).join(', ')}` : '',
    audio.length ? `ALSA: ${audio.map(a => a.value).join(', ')}` : '',
  ].filter(Boolean).join('\n');
  return {
    video,
    audio,
    output: summary || 'لم تظهر أجهزة V4L2 أو بطاقات ALSA',
    note: describeDevices({ video, audio }, null, summary),
  };
}

function deviceListArgs() {
  // لا يوجد أمر FFmpeg لتعداد أجهزة v4l2؛ التعداد يتم عبر discover().
  return [];
}

function parseDeviceList() {
  return { video: [], audio: [] };
}

// ---------------------------------------------------------------- قدرات الجهاز
function capabilitiesArgs(videoDevice) {
  const device = normalizeVideoDevice(videoDevice);
  if (!device) throw new Error('اسم جهاز الفيديو غير صالح');
  return ['-hide_banner', '-f', 'v4l2', '-list_formats', 'all', '-i', device];
}

function capabilitiesNote() {
  return 'القدرات مستخرجة من قائمة صيغ V4L2 التي يعرضها FFmpeg. قد تختلف الخيارات الفعلية حسب التعريف.';
}

// مخرج `-list_formats all`:
// [video4linux2,v4l2 @ 0x55] Raw            :     yuyv422 :           YUYV 4:2:2 : 640x480 1280x720
// [video4linux2,v4l2 @ 0x55] Compressed     :       mjpeg :          Motion-JPEG : 640x480 1920x1080
function parseCapabilities(output) {
  const videoSizes = new Set();
  const frameRates = new Set();
  const pixelFormats = new Set();
  const modes = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    // بعد قوس FFmpeg: "Raw : yuyv422 : YUYV 4:2:2 : 640x480 1280x720"
    // الوصف نفسه قد يحتوي نقطتين، لذلك نقسم على أول حقلين فقط.
    const body = line.includes(']') ? line.slice(line.indexOf(']') + 1) : '';
    const parts = body.split(':');
    if (parts.length < 3 || !/^\s*(Raw|Compressed)\s*$/i.test(parts[0])) continue;
    const format = parts[1].trim().toLowerCase();
    if (FORMAT_NAME.test(format)) pixelFormats.add(format);
    for (const size of parts.slice(2).join(':').matchAll(/(\d{2,5})x(\d{2,5})/g)) {
      const width = Number(size[1]), height = Number(size[2]);
      if (width < 160 || height < 120 || width > 8192 || height > 4320) continue;
      const videoSize = `${width}x${height}`;
      videoSizes.add(videoSize);
      // قائمة صيغ v4l2 لا تذكر معدل الإطارات؛ يبقى الحقل فارغاً وتوصي الطبقة بـ30.
      modes.push({ pixelFormat: format, videoSize, fps: 0 });
    }
  }
  return buildCapabilities({ videoSizes, frameRates, pixelFormats, modes });
}

// ---------------------------------------------------------------- وسائط الإدخال
function videoInputArgs(source = {}) {
  const device = normalizeVideoDevice(source.videoDevice);
  if (!device) throw new Error('جهاز الفيديو غير صالح لـ V4L2 (مثال: /dev/video0)');
  const args = ['-f', 'v4l2', '-rtbufsize', '256M'];
  const captureSize = String(source.videoSize || '').trim();
  const safeSize = /^\d{3,4}x\d{3,4}$/.test(captureSize) ? captureSize : '1280x720';
  if (!source.captureSafeMode) args.push('-framerate', String(clampNumber(source.fps, 1, 60, 30)), '-video_size', safeSize);
  // في v4l2 تُمرَّر صيغة الالتقاط بـ -input_format (mjpeg/h264/yuyv422...).
  const format = String(source.pixelFormat || source.vcodec || '').trim().toLowerCase();
  if (FORMAT_NAME.test(format)) args.push('-input_format', format);
  args.push('-i', device);
  return args;
}

// إدخال ALSA منفصل — يُعيد null عندما لا يوجد جهاز صوت مختار.
function audioInputArgs(source = {}) {
  const device = normalizeAudioDevice(source.audioDevice);
  if (!device) return null;
  return ['-thread_queue_size', '512', '-f', 'alsa', '-rtbufsize', '128M', '-i', device];
}

// خطة الإدخال: وسائط الفيديو + (اختيارياً) إدخال الصوت، مع فهرس إدخال الصوت.
function inputPlan(source = {}) {
  const args = videoInputArgs(source);
  const audio = audioInputArgs(source);
  if (!audio) return { args, audioInputIndex: null };
  return { args: args.concat(audio), audioInputIndex: 1 };
}

function usbInputArgs(source) {
  return inputPlan(source).args;
}

// ---------------------------------------------------------------- اختبار الالتقاط
function testAudioArgs(audioDevice) {
  const device = normalizeAudioDevice(audioDevice);
  if (!device) throw new Error('اختر جهاز صوت صالحاً');
  return ['-hide_banner', '-loglevel', 'error', '-f', 'alsa', '-rtbufsize', '128M', '-i', device, '-t', '3', '-f', 'null', '-'];
}

function testVideoArgs(body = {}) {
  const device = normalizeVideoDevice(body.videoDevice);
  if (!device) throw new Error('جهاز الفيديو غير صالح');
  const size = String(body.videoSize || '1280x720');
  const fps = Number(body.fps) || 30;
  const format = String(body.pixelFormat || body.vcodec || '').trim().toLowerCase();
  if (!/^\d{2,5}x\d{2,5}$/.test(size) || fps < 1 || fps > 60 || (format && !FORMAT_NAME.test(format))) {
    throw new Error('إعدادات الالتقاط غير صالحة');
  }
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'v4l2', '-rtbufsize', '128M'];
  if (!body.captureSafeMode) args.push('-framerate', String(fps), '-video_size', size);
  if (format) args.push('-input_format', format);
  args.push('-i', device);
  if (audioInputArgs(body)) {
    args.push(...audioInputArgs(body), '-map', '0:v:0', '-map', '1:a:0?');
  }
  args.push('-t', '3', '-f', 'null', '-');
  return args;
}

module.exports = {
  name: 'v4l2',
  label: 'V4L2 + ALSA (Linux)',
  deviceListArgs,
  parseDeviceList,
  discover,
  describeDevices,
  capabilitiesArgs,
  capabilitiesNote,
  parseCapabilities,
  normalizeVideoDevice,
  normalizeAudioDevice,
  parseVideoDevices,
  parseAlsaCards,
  scanVideoDevices,
  scanAudioDevices,
  videoInputArgs,
  audioInputArgs,
  inputPlan,
  usbInputArgs,
  testVideoArgs,
  testAudioArgs,
};
