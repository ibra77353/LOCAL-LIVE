'use strict';
// اختبارات وحدة لطبقة الالتقاط (lib/capture).
// تغطي ما لا يمكن ممارسته عبر HTTP على Linux: أوامر DirectShow وتحليل مخرجاته،
// ووسائط التقاط الشاشة على Windows (gdigrab) مقابل Linux (x11grab)،
//
// التشغيل: node --test tests/capture/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const capture = require('../../lib/capture');
const dshow = require('../../lib/capture/dshow');

const ROOT = path.resolve(__dirname, '..', '..');

// هذا الملف يوثّق محرك Windows (DirectShow). الاختبارات تعمل على Linux، لذلك
// نمرّر 'win32' صراحةً لكل استدعاء حتى لا يتأثر ناتجها بالمحرك الافتراضي للمنصة.
const winCapture = {
  deviceListArgs: () => capture.deviceListArgs('win32'),
  parseDeviceList: (output) => capture.parseDeviceList(output, 'win32'),
  describeDevices: (devices, err, output) => capture.describeDevices(devices, err, output, 'win32'),
  capabilitiesArgs: (device) => capture.capabilitiesArgs(device, 'win32'),
  parseCapabilities: (output) => capture.parseCapabilities(output, 'win32'),
  usbInputArgs: (source) => capture.usbInputArgs(source, 'win32'),
  testVideoArgs: (body) => capture.testVideoArgs(body, 'win32'),
  testAudioArgs: (device) => capture.testAudioArgs(device, 'win32'),
};

// ---------------------------------------------------------------- تسجيل المحركات
test('المحرك المسجّل لويندوز هو DirectShow، ولينكس هو V4L2', () => {
  assert.equal(capture.engineFor('win32').name, 'dshow');
  assert.equal(capture.engineFor('linux').name, 'v4l2');
  assert.deepEqual(capture.registeredEngines(), ['win32', 'linux']);
});

test('اختيار المحرك تلقائي حسب النظام وWindows يبقى DirectShow', () => {
  assert.equal(capture.engineName('win32'), 'dshow');
  assert.equal(capture.engineLabel('win32'), 'DirectShow (Windows)');
  assert.equal(capture.engineName('linux'), 'v4l2');
  assert.equal(capture.engineLabel('linux'), 'V4L2 + ALSA (Linux)');
});

test('نطاق الدعم ثلاثة أنظمة ولكل بيئة محركها الصحيح', () => {
  const targets = capture.supportedTargets();
  assert.deepEqual(targets.map(t => t.target), ['Windows 10/11', 'Ubuntu / Debian', 'Docker Linux']);
  assert.deepEqual(targets.map(t => t.engine), ['dshow', 'v4l2', 'v4l2']);
  // Ubuntu/Debian وDocker Linux يشتركان في منصة linux ومحرك v4l2 نفسه.
  assert.equal(targets[1].platform, 'linux');
  assert.equal(targets[2].platform, 'linux');
  assert.equal(capture.engineFor(targets[2].platform).name, 'v4l2');
});

test('الأنظمة غير المدعومة لا تُعامل كمحرك V4L2', () => {
  for (const platform of ['darwin', 'freebsd', 'openbsd', 'aix', 'sunos']) {
    assert.equal(capture.isSupported(platform), false);
    assert.throws(() => capture.engineFor(platform), /غير مدعوم/);
    // لوحة الحالة تبقى قابلة للقراءة بدل رفع خطأ.
    assert.equal(capture.engineName(platform), 'unsupported');
    assert.equal(capture.engineLabel(platform), 'نظام غير مدعوم');
    assert.throws(() => capture.usbInputArgs({ videoDevice: 'x' }, platform), /غير مدعوم/);
    assert.throws(() => capture.screenInputArgs({ fps: 15 }, platform), /غير مدعوم/);
  }
  assert.equal(capture.isSupported('win32'), true);
  assert.equal(capture.isSupported('linux'), true);
});

// ---------------------------------------------------------------- تعداد الأجهزة
test('أمر تعداد الأجهزة مطابق للأصل حرفياً', () => {
  assert.deepEqual(winCapture.deviceListArgs(), ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
});

test('تحليل مخرج تعداد الأجهزة يفصل الفيديو عن الصوت ويزيل التكرار', () => {
  const output = [
    '[dshow @ 000001] "USB Video" (video)',
    '[dshow @ 000001]   Alternative name "@device_pnp_\\\\?\\usb#vid_1"',
    '[dshow @ 000001] "Digital Audio Interface (2- USB Digital Audio)" (audio)',
    '[dshow @ 000001] "USB Video" (video)',
    '[dshow @ 000001] "Webcam HD" (video)',
    '[dshow @ 000001] "Microphone (USB Audio)" (audio)',
    '[dshow @ 000001] Could not enumerate audio only (see option \'-list_options\').',
  ].join('\r\n');
  const devices = winCapture.parseDeviceList(output);
  assert.deepEqual(devices.video, ['USB Video', 'Webcam HD']);
  assert.deepEqual(devices.audio, ['Digital Audio Interface (2- USB Digital Audio)', 'Microphone (USB Audio)']);
});

test('رسائل تعداد الأجهزة الثلاث تبقى كما هي في واجهة الـAPI', () => {
  const withDevices = { video: ['USB Video'], audio: [] };
  assert.equal(
    winCapture.describeDevices(withDevices, null, 'x'),
    'قوائم الفيديو والصوت مستخرجة من أجهزة DirectShow التي يعرضها FFmpeg.'
  );
  assert.equal(winCapture.describeDevices({ video: [], audio: [] }, null, 'x'), 'لم يعرض FFmpeg أي جهاز DirectShow متصل.');
  assert.equal(
    winCapture.describeDevices({ video: [], audio: [] }, new Error('boom'), ''),
    'تعذر تشغيل فحص FFmpeg: boom'
  );
});

// ---------------------------------------------------------------- قدرات الجهاز
test('أمر استخراج القدرات مطابق للأصل', () => {
  assert.deepEqual(
    winCapture.capabilitiesArgs('USB Video'),
    ['-hide_banner', '-f', 'dshow', '-list_options', 'true', '-i', 'video=USB Video']
  );
});

test('تحليل قدرات الجهاز يستخرج الدقات ومعدلات الإطارات والتوصية', () => {
  const output = [
    '[dshow @ 000001]   pixel_format=mjpeg  min s=640x480 fps=30 max s=1920x1080 fps=30',
    '[dshow @ 000001]   pixel_format=yuyv422  min s=640x480 fps=30 max s=1280x720 fps=30',
    '[dshow @ 000001]   pixel_format=nv12  min s=320x240 fps=15 max s=640x480 fps=30',
  ].join('\n');
  const caps = winCapture.parseCapabilities(output);

  assert.deepEqual(caps.videoSizes, ['1920x1080', '1280x720', '640x480', '320x240']);
  assert.ok(caps.frameRates.includes('30'));
  assert.ok(caps.frameRates.includes('15'));
  assert.deepEqual(caps.pixelFormats.sort(), ['mjpeg', 'nv12', 'yuyv422']);
  // التوصية تفضّل ما لا يتجاوز 1280x720 ثم الأكبر مساحةً.
  assert.equal(caps.recommended.videoSize, '1280x720');
  assert.equal(caps.recommended.fps, 30);
  assert.equal(caps.recommended.pixelFormat, 'mjpeg');
  assert.ok(caps.modes.length >= 4);
});

test('تحليل القدرات يعيد قائمة فارغة عند مخرج لا يحتوي أوضاعاً', () => {
  const caps = winCapture.parseCapabilities('dummy: Immediate exit requested');
  assert.deepEqual(caps.videoSizes, []);
  assert.equal(caps.recommended.videoSize, '1280x720');
});

// ---------------------------------------------------------------- وسائط الإدخال
test('وسائط USB كاملة تطابق أمراً مرجعياً منسوخاً من الإصدار السابق', () => {
  const args = winCapture.usbInputArgs({
    videoDevice: 'USB Video Test Device',
    audioDevice: 'USB Audio Test Device',
    videoSize: '1280x720',
    fps: 30,
    vcodec: 'mjpeg',
  });
  assert.deepEqual(args, [
    '-f', 'dshow', '-rtbufsize', '256M',
    '-framerate', '30', '-video_size', '1280x720',
    '-vcodec', 'mjpeg',
    '-i', 'video=USB Video Test Device:audio=USB Audio Test Device',
  ]);
});

test('وضع الالتقاط الآمن لا يفرض الدقة ولا معدل الإطارات', () => {
  const args = winCapture.usbInputArgs({ videoDevice: 'USB Video', videoSize: '1920x1080', fps: 60, captureSafeMode: true });
  assert.deepEqual(args, ['-f', 'dshow', '-rtbufsize', '256M', '-i', 'video=USB Video']);
});

test('pixelFormat الحقيقي يمرَّر بـ -pixel_format، وmjpeg يمرَّر بـ -vcodec', () => {
  const pixel = winCapture.usbInputArgs({ videoDevice: 'USB Video', videoSize: '640x480', fps: 15, pixelFormat: 'yuyv422' });
  assert.deepEqual(pixel.slice(0, 10), [
    '-f', 'dshow', '-rtbufsize', '256M',
    '-framerate', '15', '-video_size', '640x480',
    '-pixel_format', 'yuyv422',
  ]);

  const codec = winCapture.usbInputArgs({ videoDevice: 'USB Video', pixelFormat: 'mjpeg' });
  assert.ok(codec.includes('-vcodec'));
  assert.equal(codec[codec.indexOf('-vcodec') + 1], 'mjpeg');
  assert.equal(codec.includes('-pixel_format'), false);
});

test('القيم التالفة في data.json لا تصل إلى FFmpeg', () => {
  const args = winCapture.usbInputArgs({
    videoDevice: 'USB Video',
    videoSize: 'not-a-size',
    pixelFormat: 'bad format!',
    vcodec: 'also bad!',
  });
  assert.ok(args.includes('-video_size'));
  assert.equal(args[args.indexOf('-video_size') + 1], '1280x720');
  assert.equal(args.includes('-pixel_format'), false);
  assert.equal(args.includes('-vcodec'), false);
  // fps الغائب يستخدم القيمة الاحتياطية 30، والنص الفارغ يُقيَّد إلى 1 — كما في clampNumber الأصلية.
  assert.equal(args[args.indexOf('-framerate') + 1], '30');
  const emptyFps = winCapture.usbInputArgs({ videoDevice: 'USB Video', fps: '' });
  assert.equal(emptyFps[emptyFps.indexOf('-framerate') + 1], '1');
});

// ---------------------------------------------------------------- اختبار الالتقاط
test('وسائط اختبار التقاط الصوت والفيديو مطابقة للأصل', () => {
  assert.deepEqual(winCapture.testAudioArgs('USB Audio'), [
    '-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-i', 'audio=USB Audio', '-t', '3', '-f', 'null', '-',
  ]);
  assert.deepEqual(winCapture.testVideoArgs({ videoDevice: 'USB Video', audioDevice: 'USB Audio', videoSize: '1280x720', fps: 30, pixelFormat: 'mjpeg' }), [
    '-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-rtbufsize', '128M',
    '-framerate', '30', '-video_size', '1280x720',
    '-vcodec', 'mjpeg',
    '-i', 'video=USB Video:audio=USB Audio', '-t', '3', '-f', 'null', '-',
  ]);
});

test('اختبار الالتقاط يرفض المدخلات غير الصالحة بنفس رسائل الأصل', () => {
  assert.throws(() => winCapture.testAudioArgs(''), /اختر جهاز صوت صالحاً/);
  assert.throws(() => winCapture.testAudioArgs('a\nb'), /اختر جهاز صوت صالحاً/);
  assert.throws(() => winCapture.testVideoArgs({}), /جهاز الفيديو غير صالح/);
  assert.throws(() => winCapture.testVideoArgs({ videoDevice: 'USB Video', videoSize: 'big' }), /إعدادات الالتقاط غير صالحة/);
  assert.throws(() => winCapture.testVideoArgs({ videoDevice: 'USB Video', fps: 120 }), /إعدادات الالتقاط غير صالحة/);
});

// ---------------------------------------------------------------- التقاط الشاشة
test('التقاط الشاشة على Windows يستخدم gdigrab بوسائط مطابقة للأصل', () => {
  assert.deepEqual(capture.screenInputArgs({ fps: 15 }, 'win32'), ['-f', 'gdigrab', '-framerate', '15', '-i', 'desktop']);
  assert.deepEqual(capture.screenInputArgs({}, 'win32'), ['-f', 'gdigrab', '-framerate', '15', '-i', 'desktop']);
});

test('التقاط الشاشة على Linux يستخدم x11grab مع DISPLAY', () => {
  const previous = process.env.DISPLAY;
  delete process.env.DISPLAY;
  try {
    assert.deepEqual(capture.screenInputArgs({ fps: 20 }, 'linux'), ['-f', 'x11grab', '-framerate', '20', '-i', ':0.0']);
    process.env.DISPLAY = ':5.1';
    assert.deepEqual(capture.screenInputArgs({ fps: 20 }, 'linux'), ['-f', 'x11grab', '-framerate', '20', '-i', ':5.1']);
  } finally {
    if (previous === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = previous;
  }
});

// ---------------------------------------------------------------- عزل الطبقة
test('server.js لا يبني أوامر dshow/gdigrab/x11grab بنفسه بعد الاستخراج', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  for (const literal of ["'dshow'", "'gdigrab'", "'x11grab'", '"-f", "dshow"']) {
    assert.equal(source.includes(literal), false, `ما زال server.js يحتوي ${literal}`);
  }
  assert.ok(source.includes("require('./lib/capture')"), 'server.js يجب أن يستورد طبقة الالتقاط');
});
