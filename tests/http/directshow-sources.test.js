'use strict';
// اختبار تكامل لإنشاء مصادر DirectShow عبر POST /api/sources:
// يتحقق من حفظ كل حقول الالتقاط على القرص، ومن رفض الحقول القديمة (مثل crf
// والدقة العامة وGOP) بدل تجاهلها بصمت، فلا يُنشأ مصدر ولا يتغيّر أي سجل قائم.
//
// تُشغَّل الاختبارات على نسخة معزولة من الخادم (tests/http/lib/harness.js)
// فلا تُمسّ بيانات المستخدم.
//
// التشغيل: node --test tests/http/directshow-sources.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestServer } = require('./lib/harness');
const { createClient } = require('./lib/client');

const VIDEO_DEVICE = 'USB Video Test Device';
const AUDIO_DEVICE = 'USB Audio Test Device';

// حقول ترميز قديمة أُلغيت من المصادر: تُرفض صراحةً عند الإنشاء.
const LEGACY_FIELDS = ['crf', 'crfValue', 'outputWidth', 'outputHeight', 'outputFps', 'gopSeconds', 'gop'];

let srv;
let api;
const createdIds = [];

const readDataFile = () => JSON.parse(fs.readFileSync(path.join(srv.dir, 'data.json'), 'utf8'));
const sourceCount = async () => (await api.get('/api/sources')).json.sources.length;

test.before(async () => {
  srv = await startTestServer({ port: 3907 });
  api = createClient(srv.baseUrl);
  const login = await api.post('/api/login', { user: srv.user, pass: srv.pass });
  assert.equal(login.status, 200, `تعذر تسجيل الدخول: ${login.text}`);
});

test.after(async () => {
  for (const id of createdIds) await api.del(`/api/sources/${id}`);
  if (srv) await srv.stop();
});

// ------------------------------------------------- إنشاء مصدر DirectShow صالح
test('POST /api/sources ينشئ مصدر DirectShow ويحفظ كل حقول الالتقاط', async () => {
  const payload = {
    name: 'كاميرا DirectShow للاختبار',
    type: 'usb',
    videoDevice: VIDEO_DEVICE,
    videoDeviceLabel: 'كاميرا USB',
    audioDevice: AUDIO_DEVICE,
    videoSize: '1920x1080',
    fps: 30,
    pixelFormat: 'mjpeg',
    vcodec: 'mjpeg',
    captureSafeMode: true,
    enabled: true,
  };

  const res = await api.post('/api/sources', payload);
  assert.equal(res.status, 201, `تعذر إنشاء المصدر: ${res.text}`);
  assert.equal(res.json.ok, true);
  const source = res.json.source;
  createdIds.push(source.id);
  assert.match(source.id, /^src_/);

  // الاستجابة تعكس القيم كما أُرسلت.
  for (const key of ['name', 'videoDevice', 'videoDeviceLabel', 'audioDevice', 'videoSize', 'fps', 'pixelFormat', 'vcodec', 'captureSafeMode', 'enabled']) {
    assert.deepEqual(source[key], payload[key], `الحقل ${key} لم يُحفظ كما أُرسل`);
  }
  assert.equal(source.type, 'usb');

  // القيم مُثبَّتة فعلاً: في قائمة API وفي data.json على القرص.
  const listed = (await api.get('/api/sources')).json.sources.find((s) => s.id === source.id);
  assert.ok(listed, 'المصدر يجب أن يظهر في قائمة المصادر');
  assert.equal(listed.videoDevice, VIDEO_DEVICE);
  assert.equal(listed.videoSize, '1920x1080');
  assert.equal(listed.fps, 30);

  const stored = readDataFile().sources.find((s) => s.id === source.id);
  assert.ok(stored, 'المصدر يجب أن يُكتب في data.json');
  assert.equal(stored.pixelFormat, 'mjpeg');
  assert.equal(stored.audioDevice, AUDIO_DEVICE);
  assert.equal(stored.vcodec, 'mjpeg');
  assert.equal(stored.captureSafeMode, true);
});

test('POST /api/sources يقبل مصدر DirectShow فيديو فقط بلا جهاز صوت', async () => {
  const res = await api.post('/api/sources', {
    name: 'كاميرا بلا صوت', type: 'usb', videoDevice: VIDEO_DEVICE, videoSize: '1280x720', fps: 25,
  });
  assert.equal(res.status, 201, res.text);
  createdIds.push(res.json.source.id);
  assert.equal(res.json.source.audioDevice, undefined, 'بلا جهاز صوت لا يُفترض جهاز وهمي');
  assert.equal(res.json.source.videoSize, '1280x720');
});

// ------------------------------------------------------- رفض الحقول القديمة
test('POST /api/sources يرفض كل حقل ترميز قديم ولا ينشئ مصدراً', async () => {
  const before = await sourceCount();

  for (const field of LEGACY_FIELDS) {
    const res = await api.post('/api/sources', {
      name: `مصدر مرفوض ${field}`,
      type: 'usb',
      videoDevice: VIDEO_DEVICE,
      [field]: field === 'crf' || field === 'crfValue' ? 23 : 30,
    });
    assert.equal(res.status, 400, `الحقل القديم ${field} يجب أن يُرفض`);
    assert.equal(res.json.ok, false);
    assert.match(String(res.json.error || ''), new RegExp(field), `رسالة الرفض يجب أن تسمّي ${field}`);
  }

  assert.equal(await sourceCount(), before, 'الطلبات المرفوضة يجب ألا تُضيف مصادر');
  const stored = readDataFile().sources;
  for (const field of LEGACY_FIELDS) {
    assert.equal(stored.some((s) => s.name === `مصدر مرفوض ${field}`), false, `المصدر المرفوض (${field}) لا يُكتب في data.json`);
    assert.equal(Object.prototype.hasOwnProperty.call(stored[0] || {}, field), false, `الحقل ${field} لا يُخزَّن على المصادر`);
  }
});

test('POST /api/sources يرفض حقول DirectShow المطلوبة الناقصة', async () => {
  const before = await sourceCount();

  const noName = await api.post('/api/sources', { type: 'usb', videoDevice: VIDEO_DEVICE });
  assert.equal(noName.status, 400);
  assert.match(noName.json.error, /اسم المصدر/);

  const noDevice = await api.post('/api/sources', { name: 'بلا جهاز', type: 'usb' });
  assert.equal(noDevice.status, 400);
  assert.match(noDevice.json.error, /جهاز الفيديو/);

  const emptyDevice = await api.post('/api/sources', { name: 'جهاز فارغ', type: 'usb', videoDevice: '   ' });
  assert.equal(emptyDevice.status, 400);

  const badType = await api.post('/api/sources', { name: 'نوع خاطئ', type: 'satellite', videoDevice: VIDEO_DEVICE });
  assert.equal(badType.status, 400);
  assert.match(badType.json.error, /نوع المصدر/);

  assert.equal(await sourceCount(), before, 'المدخلات غير الصالحة يجب ألا تنشئ مصادر');
});
