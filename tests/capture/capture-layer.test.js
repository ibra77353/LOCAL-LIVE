'use strict';
// اختبارات وحدة لطبقة الالتقاط (lib/capture).
// تغطي ما لا يمكن ممارسته عبر HTTP على Linux: أوامر DirectShow وتحليل مخرجاته،
// ووسائط التقاط الشاشة على Windows (gdigrab) مقابل الأنظمة الأخرى (x11grab).
//
// التشغيل: node --test tests/capture/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const capture = require('../../lib/capture');
const dshow = require('../../lib/capture/dshow');

const ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------- تسجيل المحركات
test('المحرك المسجّل لويندوز هو DirectShow', () => {
  assert.equal(capture.engineFor('win32').name, 'dshow');
  assert.deepEqual(capture.registeredEngines(), ['win32']);
});

test('الأنظمة غير المسجّلة تعود إلى DirectShow (نفس سلوك ما قبل الاستخراج)', () => {
  // المرحلة الأولى لا تضيف محرك Linux؛ العودة إلى dshow تُبقي السلوك مطابقاً
  // للأصل على Linux: نفس الوسائط ونفس خطأ FFmpeg.
  assert.equal(capture.engineFor('linux').name, 'dshow');
  assert.equal(capture.engineFor('darwin').name, 'dshow');
  assert.equal(capture.engineName('linux'), 'dshow');
});

// ---------------------------------------------------------------- تعداد الأجهزة
test('أمر تعداد الأجهزة مطابق للأصل حرفياً', () => {
  assert.deepEqual(capture.deviceListArgs(), ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
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
  const devices = capture.parseDeviceList(output);
  assert.deepEqual(devices.video, ['USB Video', 'Webcam HD']);
  assert.deepEqual(devices.audio, ['Digital Audio Interface (2- USB Digital Audio)', 'Microphone (USB Audio)']);
});

test('رسائل تعداد الأجهزة الثلاث تبقى كما هي في واجهة الـAPI', () => {
  const withDevices = { video: ['USB Video'], audio: [] };
  assert.equal(
    capture.describeDevices(withDevices, null, 'x'),
    'قوائم الفيديو والصوت مستخرجة من أجهزة DirectShow التي يعرضها FFmpeg.'
  );
  assert.equal(capture.describeDevices({ video: [], audio: [] }, null, 'x'), 'لم يعرض FFmpeg أي جهاز DirectShow متصل.');
  assert.equal(
    capture.describeDevices({ video: [], audio: [] }, new Error('boom'), ''),
    'تعذر تشغيل فحص FFmpeg: boom'
  );
});

// ---------------------------------------------------------------- قدرات الجهاز
test('أمر استخراج القدرات مطابق للأصل', () => {
  assert.deepEqual(
    capture.capabilitiesArgs('USB Video'),
    ['-hide_banner', '-f', 'dshow', '-list_options', 'true', '-i', 'video=USB Video']
  );
});

test('تحليل قدرات الجهاز يستخرج الدقات ومعدلات الإطارات والتوصية', () => {
  const output = [
    '[dshow @ 000001]   pixel_format=mjpeg  min s=640x480 fps=30 max s=1920x1080 fps=30',
    '[dshow @ 000001]   pixel_format=yuyv422  min s=640x480 fps=30 max s=1280x720 fps=30',
    '[dshow @ 000001]   pixel_format=nv12  min s=320x240 fps=15 max s=640x480 fps=30',
  ].join('\n');
  const caps = capture.parseCapabilities(output);

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
  const caps = capture.parseCapabilities('dummy: Immediate exit requested');
  assert.deepEqual(caps.videoSizes, []);
  assert.equal(caps.recommended.videoSize, '1280x720');
});

// ---------------------------------------------------------------- وسائط الإدخال
test('وسائط USB كاملة تطابق أمراً مرجعياً منسوخاً من الإصدار السابق', () => {
  const args = capture.usbInputArgs({
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
  const args = capture.usbInputArgs({ videoDevice: 'USB Video', videoSize: '1920x1080', fps: 60, captureSafeMode: true });
  assert.deepEqual(args, ['-f', 'dshow', '-rtbufsize', '256M', '-i', 'video=USB Video']);
});

test('pixelFormat الحقيقي يمرَّر بـ -pixel_format، وmjpeg يمرَّر بـ -vcodec', () => {
  const pixel = capture.usbInputArgs({ videoDevice: 'USB Video', videoSize: '640x480', fps: 15, pixelFormat: 'yuyv422' });
  assert.deepEqual(pixel.slice(0, 10), [
    '-f', 'dshow', '-rtbufsize', '256M',
    '-framerate', '15', '-video_size', '640x480',
    '-pixel_format', 'yuyv422',
  ]);

  const codec = capture.usbInputArgs({ videoDevice: 'USB Video', pixelFormat: 'mjpeg' });
  assert.ok(codec.includes('-vcodec'));
  assert.equal(codec[codec.indexOf('-vcodec') + 1], 'mjpeg');
  assert.equal(codec.includes('-pixel_format'), false);
});

test('القيم التالفة في data.json لا تصل إلى FFmpeg', () => {
  const args = capture.usbInputArgs({
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
  const emptyFps = capture.usbInputArgs({ videoDevice: 'USB Video', fps: '' });
  assert.equal(emptyFps[emptyFps.indexOf('-framerate') + 1], '1');
});

// ---------------------------------------------------------------- اختبار الالتقاط
test('وسائط اختبار التقاط الصوت والفيديو مطابقة للأصل', () => {
  assert.deepEqual(capture.testAudioArgs('USB Audio'), [
    '-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-i', 'audio=USB Audio', '-t', '3', '-f', 'null', '-',
  ]);
  assert.deepEqual(capture.testVideoArgs({ videoDevice: 'USB Video', audioDevice: 'USB Audio', videoSize: '1280x720', fps: 30, pixelFormat: 'mjpeg' }), [
    '-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-rtbufsize', '128M',
    '-framerate', '30', '-video_size', '1280x720',
    '-vcodec', 'mjpeg',
    '-i', 'video=USB Video:audio=USB Audio', '-t', '3', '-f', 'null', '-',
  ]);
});

test('اختبار الالتقاط يرفض المدخلات غير الصالحة بنفس رسائل الأصل', () => {
  assert.throws(() => capture.testAudioArgs(''), /اختر جهاز صوت صالحاً/);
  assert.throws(() => capture.testAudioArgs('a\nb'), /اختر جهاز صوت صالحاً/);
  assert.throws(() => capture.testVideoArgs({}), /جهاز الفيديو غير صالح/);
  assert.throws(() => capture.testVideoArgs({ videoDevice: 'USB Video', videoSize: 'big' }), /إعدادات الالتقاط غير صالحة/);
  assert.throws(() => capture.testVideoArgs({ videoDevice: 'USB Video', fps: 120 }), /إعدادات الالتقاط غير صالحة/);
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
