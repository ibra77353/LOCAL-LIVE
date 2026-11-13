'use strict';
// محرك الالتقاط على Windows — DirectShow.
//
// هذا الملف ناتج نقل حرفي لمنطق كان داخل server.js: أوامر تعداد الأجهزة،
// تحليل مخرجات FFmpeg، قدرات الجهاز، بناء وسائط الإدخال، ووسائط اختبار الالتقاط.
// لا تغيير في أي نص أمر أو رسالة خطأ أو ترتيب وسائط — السلوك مطابق للأصل،
// وقد تحقّق ذلك بمقارنة لقطة وسائط FFmpeg قبل النقل وبعده.

const { clampNumber } = require('../shared/clamp');
const { buildCapabilities } = require('./capabilities');

const CODEC_NAMES = ['mjpeg', 'rawvideo', 'h264'];
// mjpeg اسم codec لا pixel format: يُمرَّر بـ -vcodec، وبقية القيم تذهب إلى -pixel_format.
const isCodecName = (value) => CODEC_NAMES.includes(String(value || '').toLowerCase());

// ---------------------------------------------------------------- تعداد الأجهزة
function deviceListArgs() {
  return ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'];
}

// FFmpeg DirectShow يطبع اسم كل جهاز متبوعاً بـ (video) أو (audio).
// نُزيل التكرار مع الحفاظ على ترتيب التعريف.
function parseDeviceList(output) {
  const video = [];
  const audio = [];
  const seenVideo = new Set();
  const seenAudio = new Set();
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/\]\s*"([^"]+)"\s*\((video|audio)\)/i);
    if (!match) continue;
    const name = match[1].trim();
    const type = match[2].toLowerCase();
    const list = type === 'video' ? video : audio;
    const seen = type === 'video' ? seenVideo : seenAudio;
    if (name && !seen.has(name)) { seen.add(name); list.push(name); }
  }
  return { video, audio };
}

function describeDevices(devices, err, output) {
  const video = devices.video || [];
  const audio = devices.audio || [];
  if (err && !output) return `تعذر تشغيل فحص FFmpeg: ${err.message}`;
  return video.length || audio.length
    ? 'قوائم الفيديو والصوت مستخرجة من أجهزة DirectShow التي يعرضها FFmpeg.'
    : 'لم يعرض FFmpeg أي جهاز DirectShow متصل.';
}

// ---------------------------------------------------------------- قدرات الجهاز
function capabilitiesArgs(videoDevice) {
  return ['-hide_banner', '-f', 'dshow', '-list_options', 'true', '-i', `video=${videoDevice}`];
}

function parseCapabilities(output) {
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
    const w = Number(match[1]), h = Number(match[2]), fps = Number(match[3]);
    if (w >= 160 && h >= 120 && w <= 8192 && h <= 4320) videoSizes.add(`${w}x${h}`);
    if (fps >= 1 && fps <= 240) frameRates.add(String(Number(fps.toFixed(2))));
  }
  // الأوضاع تُبنى بعد معرفة الصيغة الموصى بها، ثم تُجمَّع التوصية في capabilities.js
  // حتى يبقى المخرج مطابقاً لما كان في server.js.
  const recommendedFormat = ['mjpeg', 'yuyv422', 'uyvy422', 'nv12', 'yuv420p'].find(x => pixelFormats.has(x)) || [...pixelFormats][0] || '';
  const modes = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const fmt = (line.match(/(?:pixel_format|vcodec)=([a-zA-Z0-9_]+)/i) || [])[1]?.toLowerCase() || '';
    const sizes = [...line.matchAll(/(?:min\s+s=|max\s+s=|s=)(\d{2,5})x(\d{2,5})/gi)].map(m => `${m[1]}x${m[2]}`);
    const rates = [...line.matchAll(/fps\s*=\s*(\d{1,3}(?:\.\d+)?)/gi)].map(m => String(Number(Number(m[1]).toFixed(2))));
    for (const size of new Set(sizes)) for (const rate of new Set(rates)) modes.push({ pixelFormat: fmt || recommendedFormat, videoSize: size, fps: Number(rate) });
  }
  return buildCapabilities({ videoSizes, frameRates, pixelFormats, modes });
}

function capabilitiesNote() {
  return 'القدرات مستخرجة من مخرجات FFmpeg DirectShow. قد تختلف الخيارات الفعلية حسب تعريف القطعة.';
}

// ---------------------------------------------------------------- وسائط الإدخال
// وسائط إدخال جهاز USB/DirectShow داخل أمر FFmpeg الخاص بالقناة.
// لا تشمل وسائط المخرجات ولا HLS: تلك تبقى في buildArgs داخل server.js.
function usbInputArgs(source) {
  const audioDevice = source.audioDevice || '';
  const inputSpec = audioDevice ? `video=${source.videoDevice}:audio=${audioDevice}` : `video=${source.videoDevice}`;
  const args = ['-f', 'dshow', '-rtbufsize', '256M'];
  // الوضع الآمن: لا نفرض الدقة/الإطارات على الجهاز (يعالج خطأ "Could not set video options").
  // نتحقق من الصيغة قبل تمريرها حتى لا تصل قيمة تالفة من data.json إلى FFmpeg.
  const captureSize = String(source.videoSize || '').trim();
  const safeSize = /^\d{3,4}x\d{3,4}$/.test(captureSize) ? captureSize : '1280x720';
  // «افتراضي» في اللوحة يصل null أو فارغاً. تمريره إلى clampNumber كان يعطي 1
  // (لأن Number('') وNumber(null) يساويان 0)، فيُطلب من الجهاز الالتقاط بإطار
  // واحد في الثانية أو يرفض الإعداد برسالة "Could not set video options".
  // القيمة الافتراضية الصحيحة للالتقاط هي 30.
  const requestedFps = Number(source.fps);
  const captureFps = Number.isFinite(requestedFps) && requestedFps > 0 ? requestedFps : 30;
  if (!source.captureSafeMode) args.push('-framerate', String(clampNumber(captureFps, 1, 60, 30)), '-video_size', safeSize);
  const inputPixelFormat = String(source.pixelFormat || '').trim();
  const inputCodec = String(source.vcodec || '').trim();
  const pixelSpec = isCodecName(inputPixelFormat) ? '' : inputPixelFormat;
  const codecSpec = inputCodec || (isCodecName(inputPixelFormat) ? inputPixelFormat : '');
  if (/^[a-z0-9_]{2,30}$/i.test(pixelSpec)) args.push('-pixel_format', pixelSpec);
  if (/^[a-z0-9_]{2,30}$/i.test(codecSpec)) args.push('-vcodec', codecSpec);
  args.push('-i', inputSpec);
  return args;
}

// DirectShow يحمل الصوت داخل الإدخال نفسه (video=...:audio=...)، فلا إدخال ثانٍ.
function inputPlan(source) {
  return { args: usbInputArgs(source), audioInputIndex: null };
}

// ---------------------------------------------------------------- اختبار الالتقاط
// مخرج الاختبار MPEG-TS مُرمَّز بـaac بدل `-f null`: المشروع يحتاج mpegts
// وaac لتشغيل أي قناة، أما null muxer وwrapped_avframe فغير مضمونين في نسخ
// FFmpeg المقلّمة (نسخة المشروع المرفقة لا تضم null)، وكان الاختبار يفشل
// برسالة "Requested output format 'null' is not known" حتى مع جهاز سليم.
function testAudioArgs(audioDevice) {
  const value = String(audioDevice || '').trim();
  if (!value || value.length > 300 || /[\r\n\0]/.test(value)) throw new Error('اختر جهاز صوت صالحاً');
  return ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-rtbufsize', '128M', '-i', `audio=${value}`,
    '-t', '3', '-map', '0:a:0?', '-c:a', 'aac', '-f', 'mpegts', '-'];
}

function testVideoArgs(body, options = {}) {
  const videoDevice = String(body.videoDevice || '').trim();
  const audioDevice = String(body.audioDevice || '').trim();
  if (!videoDevice || videoDevice.length > 300 || /[\r\n\0]/.test(videoDevice)) throw new Error('جهاز الفيديو غير صالح');
  const size = String(body.videoSize || '1280x720'), fps = Number(body.fps) || 30;
  const formatRaw = String(body.pixelFormat || '').trim(), codecRaw = String(body.vcodec || '').trim();
  const pixel = isCodecName(formatRaw) ? '' : formatRaw, vcodec = codecRaw || (isCodecName(formatRaw) ? formatRaw : '');
  if (!/^\d{2,5}x\d{2,5}$/.test(size) || fps < 1 || fps > 60 || (pixel && !/^[a-z0-9_]{2,30}$/i.test(pixel)) || (vcodec && !/^[a-z0-9_]{2,30}$/i.test(vcodec))) throw new Error('إعدادات الالتقاط غير صالحة');
  const input = audioDevice ? `video=${videoDevice}:audio=${audioDevice}` : `video=${videoDevice}`;
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-rtbufsize', '128M'];
  // الوضع الآمن يُحترم هنا كما في وسائط القناة: الجهاز الذي يرفض فرض الدقة أو
  // معدل الإطارات كان اختباره يفشل دائماً رغم أن القناة تعمل بالوضع الآمن.
  if (!body.captureSafeMode) args.push('-framerate', String(fps), '-video_size', size);
  if (pixel) args.push('-pixel_format', pixel);
  if (vcodec) args.push('-vcodec', vcodec);
  // نفس مخرج الصوت: MPEG-TS بـlibx264/aac، وهي مكوّنات يشترطها البث أصلاً،
  // بدل `-f null` الذي يحتاج null muxer وwrapped_avframe غير المضمونين.
  // zerolatency: يمنع libx264 من حجز إطارات في المخزن، فيظهر البث في الاختبار
  // والمتابعة الفورية بأقل تأخير ممكن (نفس خيار أمر القناة في server.js).
  // وضع الجودة العام يعطّل zerolatency هنا أيضاً، كما في وسائط القناة في server.js.
  const tuneArgs = options.qualityMode ? [] : ['-tune', 'zerolatency'];
  args.push('-i', input, '-t', '3', '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'ultrafast', ...tuneArgs, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mpegts', '-');
  return args;
}

module.exports = {
  name: 'dshow',
  label: 'DirectShow (Windows)',
  deviceListArgs,
  parseDeviceList,
  describeDevices,
  capabilitiesArgs,
  capabilitiesNote,
  parseCapabilities,
  usbInputArgs,
  inputPlan,
  testAudioArgs,
  testVideoArgs,
  isCodecName,
};
