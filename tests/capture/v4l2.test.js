'use strict';
// اختبارات محرك الالتقاط على Linux (V4L2 + ALSA) وواجهة طبقة الالتقاط الموحّدة.
//
// كل ما هنا يعمل بلا جهاز التقاط حقيقي: الوسائط المبنية، تحليل مخرجات FFmpeg
// الحقيقية، قراءة /proc/asound و/sys بمدخلات محقونة. الاختبار الفعلي على عتاد
// حقيقي يبقى على جهاز Linux مزوّد بكاميرا/بطاقة التقاط.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const capture = require('../../lib/capture');
const v4l2 = require('../../lib/capture/v4l2');

const ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------- تحقق المسارات
test('تطبيع مسار جهاز الفيديو يقبل المسار الكامل والاختصار ويرفض غير الصالح', () => {
  assert.equal(v4l2.normalizeVideoDevice('/dev/video0'), '/dev/video0');
  assert.equal(v4l2.normalizeVideoDevice('/dev/v4l/by-id/usb-Camera-video-index0'), '/dev/v4l/by-id/usb-Camera-video-index0');
  assert.equal(v4l2.normalizeVideoDevice('0'), '/dev/video0');
  assert.equal(v4l2.normalizeVideoDevice('video3'), '/dev/video3');
  assert.equal(v4l2.normalizeVideoDevice(''), '');
  assert.equal(v4l2.normalizeVideoDevice('/etc/passwd'), '');
  assert.equal(v4l2.normalizeVideoDevice('/dev/../etc/passwd'), '');
  assert.equal(v4l2.normalizeVideoDevice('a\nb'), '');
});

test('تطبيع جهاز الصوت ALSA يقبل default وplughw ورقم البطاقة', () => {
  assert.equal(v4l2.normalizeAudioDevice('default'), 'default');
  assert.equal(v4l2.normalizeAudioDevice('plughw:1'), 'plughw:1');
  assert.equal(v4l2.normalizeAudioDevice('hw:1,0'), 'hw:1,0');
  assert.equal(v4l2.normalizeAudioDevice('2'), 'plughw:2');
  assert.equal(v4l2.normalizeAudioDevice('card1'), 'plughw:1');
  assert.equal(v4l2.normalizeAudioDevice(''), '');
  assert.equal(v4l2.normalizeAudioDevice('hw:1; rm -rf /'), '');
});

// ---------------------------------------------------------------- تعداد الأجهزة
test('تعداد /dev يستبعد عقد الأوصاف (index>0) ويزيل التكرار ويرتّب رقمياً', () => {
  const rows = v4l2.parseVideoDevices([
    { value: '/dev/video10', label: 'Second Camera', index: '0' },
    { value: '/dev/video1', label: 'USB Camera', index: '1' },
    { value: '/dev/video2', label: 'USB Camera', index: '0' },
    { value: '/dev/video2', label: 'USB Camera', index: '0' },
  ]);
  assert.deepEqual(rows, [
    { value: '/dev/video2', label: 'USB Camera' },
    { value: '/dev/video10', label: 'Second Camera' },
  ]);
});

test('مسح /dev و/sys يعيد أسماء الأجهزة الحقيقية دون تشغيل FFmpeg', () => {
  const devices = ['video0', 'video1', 'video2', 'null', 'v4l'];
  const sys = {
    '/sys/class/video4linux/video0/name': 'USB Camera\n',
    '/sys/class/video4linux/video0/index': '0\n',
    '/sys/class/video4linux/video1/name': 'USB Camera\n',
    '/sys/class/video4linux/video1/index': '1\n',
    '/sys/class/video4linux/video2/name': 'HDMI Capture\n',
    '/sys/class/video4linux/video2/index': '0\n',
  };
  const rows = v4l2.scanVideoDevices({
    devRoot: '/dev',
    sysRoot: '/sys/class/video4linux',
    readdir: () => devices,
    readText: (file) => sys[file] || '',
  });
  assert.deepEqual(rows, [
    { value: '/dev/video0', label: 'USB Camera' },
    { value: '/dev/video2', label: 'HDMI Capture' },
  ]);
});

test('مسح /dev بلا أجهزة لا يرمي استثناء', () => {
  assert.deepEqual(v4l2.scanVideoDevices({ readdir: () => { throw new Error('ENOENT'); } }), []);
});

test('قراءة بطاقات ALSA من /proc/asound/cards', () => {
  const text = [
    ' 0 [Device         ]: USB-Audio - USB Audio Device',
    '                      Generic USB Audio Device at usb-0000:00:14.0-1, full speed',
    ' 1 [PCH            ]: HDA-Intel - HDA Intel PCH',
    '                      HDA Intel PCH at 0xdf120000 irq 137',
  ].join('\n');
  assert.deepEqual(v4l2.parseAlsaCards(text), [
    { value: 'plughw:0', label: 'USB Audio Device (ALSA)' },
    { value: 'plughw:1', label: 'HDA Intel PCH (ALSA)' },
  ]);
  assert.deepEqual(v4l2.parseAlsaCards('--- no soundcards ---'), []);
});

test('اكتشاف الأجهزة يعيد الشكل الذي تستهلكه server.js', () => {
  const result = v4l2.discover({
    readdir: () => ['video0'],
    readText: (file) => (file.endsWith('/name') ? 'USB Camera' : file.endsWith('/index') ? '0' : ''),
    cardsFile: '/proc/asound/cards',
  });
  assert.equal(result.video.length, 1);
  assert.deepEqual(result.video[0], { value: '/dev/video0', label: 'USB Camera' });
  assert.equal(typeof result.output, 'string');
  assert.match(result.note, /V4L2/);
});

test('رسائل تعداد الأجهزة العربية على Linux', () => {
  assert.match(v4l2.describeDevices({ video: [{ value: '/dev/video0' }], audio: [] }, null, 'x'), /V4L2/);
  assert.match(v4l2.describeDevices({ video: [], audio: [] }, null, 'x'), /لم يُعثر/);
  assert.match(v4l2.describeDevices({ video: [], audio: [] }, new Error('boom'), ''), /تعذر فحص أجهزة الالتقاط: boom/);
});

// ---------------------------------------------------------------- قدرات الجهاز
test('أمر القدرات يستخدم -list_formats على مسار v4l2', () => {
  assert.deepEqual(v4l2.capabilitiesArgs('/dev/video0'), ['-hide_banner', '-f', 'v4l2', '-list_formats', 'all', '-i', '/dev/video0']);
  assert.throws(() => v4l2.capabilitiesArgs('etc/passwd'), /اسم جهاز الفيديو غير صالح/);
});

test('تحليل مخرج -list_formats الحقيقي يستخرج الصيغ والدقات والتوصية', () => {
  const output = [
    '[video4linux2,v4l2 @ 0x5578e2] Raw            :     yuyv422 :           YUYV 4:2:2 : 640x480 1280x720 1920x1080',
    '[video4linux2,v4l2 @ 0x5578e2] Compressed     :       mjpeg :          Motion-JPEG : 640x480 1280x720',
    '[video4linux2,v4l2 @ 0x5578e2] Raw            :        nv12 :         NV12 (Y/CbCr 4:2:0) : 640x480',
    'Cannot open video device /dev/video9: No such file or directory',
  ].join('\n');
  const caps = v4l2.parseCapabilities(output);
  assert.deepEqual(caps.videoSizes, ['1920x1080', '1280x720', '640x480']);
  assert.deepEqual(caps.pixelFormats.sort(), ['mjpeg', 'nv12', 'yuyv422']);
  assert.equal(caps.recommended.videoSize, '1280x720');
  assert.equal(caps.recommended.pixelFormat, 'mjpeg');
  assert.equal(caps.recommended.fps, 30);
  assert.equal(caps.frameRates.length, 0, 'قائمة v4l2 لا تذكر معدلات الإطارات');
  assert.ok(caps.modes.length >= 4);
});

test('مخرج لا يحتوي صيغاً يعيد قدرات فارغة بتوصية افتراضية', () => {
  const caps = v4l2.parseCapabilities('Cannot open video device /dev/video0: No such file or directory');
  assert.deepEqual(caps.videoSizes, []);
  assert.equal(caps.recommended.videoSize, '1280x720');
  assert.equal(caps.recommended.fps, 30);
});

// ---------------------------------------------------------------- وسائط الإدخال
test('وسائط إدخال الفيديو تستخدم v4l2 ومسار الجهاز فقط عند غياب الصوت', () => {
  const plan = v4l2.inputPlan({ videoDevice: '/dev/video0', videoSize: '1280x720', fps: 30 });
  assert.deepEqual(plan.args, [
    '-f', 'v4l2', '-rtbufsize', '256M',
    '-framerate', '30', '-video_size', '1280x720',
    '-i', '/dev/video0',
  ]);
  assert.equal(plan.audioInputIndex, null);
});

test('صيغة الالتقاط تُمرَّر بـ -input_format في v4l2', () => {
  const args = v4l2.videoInputArgs({ videoDevice: '0', videoSize: '640x480', fps: 25, pixelFormat: 'mjpeg' });
  assert.deepEqual(args, [
    '-f', 'v4l2', '-rtbufsize', '256M',
    '-framerate', '25', '-video_size', '640x480',
    '-input_format', 'mjpeg',
    '-i', '/dev/video0',
  ]);
});

test('الوضع الآمن لا يفرض الدقة ولا معدل الإطارات', () => {
  const args = v4l2.videoInputArgs({ videoDevice: '/dev/video0', videoSize: '1920x1080', fps: 60, captureSafeMode: true });
  assert.deepEqual(args, ['-f', 'v4l2', '-rtbufsize', '256M', '-i', '/dev/video0']);
});

test('جهاز الصوت يضيف إدخال ALSA منفصلاً وفهرسه 1', () => {
  const plan = v4l2.inputPlan({ videoDevice: '/dev/video0', videoSize: '640x480', fps: 25, audioDevice: 'plughw:1' });
  assert.deepEqual(plan.args, [
    '-f', 'v4l2', '-rtbufsize', '256M',
    '-framerate', '25', '-video_size', '640x480',
    '-i', '/dev/video0',
    '-thread_queue_size', '512', '-f', 'alsa', '-rtbufsize', '128M',
    '-i', 'plughw:1',
  ]);
  assert.equal(plan.audioInputIndex, 1);
});

test('القيم التالفة لا تصل إلى FFmpeg على Linux', () => {
  const args = v4l2.videoInputArgs({ videoDevice: '/dev/video0', videoSize: 'not-a-size', fps: '', pixelFormat: 'bad format!' });
  assert.equal(args[args.indexOf('-video_size') + 1], '1280x720');
  assert.equal(args.includes('-input_format'), false);
  assert.equal(args[args.indexOf('-framerate') + 1], '30', '«افتراضي» يعني 30 لا إطاراً واحداً');
  assert.throws(() => v4l2.videoInputArgs({ videoDevice: '' }), /جهاز الفيديو غير صالح لـ V4L2/);
});

// ---------------------------------------------------------------- اختبار الالتقاط
test('وسائط اختبار الالتقاط على Linux', () => {
  assert.deepEqual(v4l2.testAudioArgs('plughw:0'), [
    '-hide_banner', '-loglevel', 'error', '-f', 'alsa', '-rtbufsize', '128M', '-i', 'plughw:0', '-t', '3', '-f', 'null', '-',
  ]);
  assert.deepEqual(v4l2.testVideoArgs({ videoDevice: '/dev/video0', videoSize: '1280x720', fps: 30 }), [
    '-hide_banner', '-loglevel', 'error', '-f', 'v4l2', '-rtbufsize', '128M',
    '-framerate', '30', '-video_size', '1280x720',
    '-i', '/dev/video0', '-t', '3', '-f', 'null', '-',
  ]);
  const withAudio = v4l2.testVideoArgs({ videoDevice: '/dev/video0', videoSize: '640x480', fps: 25, audioDevice: 'default' });
  assert.deepEqual(withAudio.slice(withAudio.indexOf('-i')), [
    '-i', '/dev/video0',
    '-thread_queue_size', '512', '-f', 'alsa', '-rtbufsize', '128M', '-i', 'default',
    '-map', '0:v:0', '-map', '1:a:0?',
    '-t', '3', '-f', 'null', '-',
  ]);
});

test('اختبار الالتقاط على Linux يرفض المدخلات غير الصالحة', () => {
  assert.throws(() => v4l2.testAudioArgs(''), /اختر جهاز صوت صالحاً/);
  assert.throws(() => v4l2.testVideoArgs({}), /جهاز الفيديو غير صالح/);
  assert.throws(() => v4l2.testVideoArgs({ videoDevice: '/dev/video0', videoSize: 'big' }), /إعدادات الالتقاط غير صالحة/);
  assert.throws(() => v4l2.testVideoArgs({ videoDevice: '/dev/video0', fps: 120 }), /إعدادات الالتقاط غير صالحة/);
});

// ---------------------------------------------------------------- الواجهة الموحّدة
test('الطبقة تختار V4L2 على Linux ولا تمس وسائط Windows', () => {
  const source = { videoDevice: '/dev/video0', videoSize: '1280x720', fps: 30, audioDevice: 'plughw:0' };
  const linuxPlan = capture.captureInputArgs(source, 'linux');
  assert.equal(linuxPlan.args.includes('-f'), true);
  assert.equal(linuxPlan.args[linuxPlan.args.indexOf('-f') + 1], 'v4l2');
  assert.equal(linuxPlan.audioInputIndex, 1);

  const winPlan = capture.captureInputArgs({ videoDevice: 'USB Video', videoSize: '1280x720', fps: 30, audioDevice: 'USB Audio' }, 'win32');
  assert.equal(winPlan.args[winPlan.args.indexOf('-f') + 1], 'dshow');
  assert.equal(winPlan.audioInputIndex, null, 'DirectShow يحمل الصوت داخل الإدخال نفسه');
});

test('اكتشاف الأجهزة على Linux لا يشغّل FFmpeg', async () => {
  let called = false;
  const result = await capture.discoverDevices('linux', async () => { called = true; return { err: null, output: '' }; });
  assert.equal(called, false);
  assert.equal(Array.isArray(result.video), true);
  assert.equal(Array.isArray(result.audio), true);
  assert.equal(typeof result.note, 'string');
});

test('اكتشاف الأجهزة على Windows يمرّر أمر DirectShow إلى دالة التشغيل', async () => {
  let received = null;
  const result = await capture.discoverDevices('win32', async (args) => {
    received = args;
    return { err: null, output: '[dshow @ 000001] "USB Video" (video)' };
  });
  assert.deepEqual(received, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
  assert.deepEqual(result.video, [{ value: 'USB Video', label: 'USB Video' }]);
  assert.match(result.note, /DirectShow/);
});

test('server.js لا يبني أوامر v4l2/alsa بنفسه ولا يعرف المحرك', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  for (const literal of ["'v4l2'", "'alsa'", '"-f", "v4l2"', "'list_formats'"]) {
    assert.equal(source.includes(literal), false, `ما زال server.js يحتوي ${literal}`);
  }
  assert.ok(source.includes('capture.captureInputArgs('), 'server.js يجب أن يبني إدخال الالتقاط عبر الطبقة');
  assert.ok(source.includes('capture.discoverDevices('), 'server.js يجب أن يعدّد الأجهزة عبر الطبقة');
});
