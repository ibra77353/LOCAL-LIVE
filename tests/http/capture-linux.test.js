'use strict';
// اختبارات HTTP لمسار الالتقاط على Linux (V4L2 + ALSA) عبر واجهة اللوحة الحقيقية:
// تعداد الأجهزة، رفض الأجهزة غير الصالحة، ووسائط FFmpeg الناتجة عن تشغيل قناة.
//
// لا يوجد جهاز التقاط في هذه البيئة، لذلك تُختبر البنية والوسائط ورسائل الخطأ،
// لا وصولاً فعلياً إلى عتاد. التشغيل: node --test tests/http/

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./lib/harness');
const { createClient } = require('./lib/client');

let srv;
let api;
const state = { sourceId: '', channelId: '' };
const IS_WIN = process.platform === 'win32';
const EXPECTED_ENGINE = IS_WIN ? 'dshow' : 'v4l2';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 5000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(stepMs);
  }
  return last;
}

test.before(async () => {
  srv = await startTestServer({ port: 3903 });
  api = createClient(srv.baseUrl);
  const login = await api.post('/api/login', { user: srv.user, pass: srv.pass });
  assert.equal(login.status, 200);
});

test.after(async () => {
  if (srv) await srv.stop();
});

// ---------------------------------------------------------------- تعداد الأجهزة
test('GET /api/devices يعيد محرك النظام الصحيح وقوائم قابلة للاستهلاك', async () => {
  const res = await api.get('/api/devices');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.engine, EXPECTED_ENGINE);
  assert.equal(Array.isArray(res.json.video), true);
  assert.equal(Array.isArray(res.json.audio), true);
  assert.equal(typeof res.json.note, 'string');
  assert.ok(res.json.note.length > 0);
  // كل عنصر يجب أن يحمل value/label ليُعرض في لوحة التحكم.
  for (const item of [...res.json.video, ...res.json.audio]) {
    assert.equal(typeof item.value, 'string');
    assert.equal(typeof item.label, 'string');
  }
});

test('GET /api/stats يعلن محرك الالتقاط المستخدم', async () => {
  const res = await api.get('/api/stats');
  assert.equal(res.status, 200);
  assert.equal(res.json.stats.captureEngine, EXPECTED_ENGINE);
});

// ---------------------------------------------------------------- قدرات الجهاز
test('GET /api/devices/capabilities يرفض مساراً غير صالح بـ 422 ورسالة واضحة', async () => {
  if (IS_WIN) return; // التحقق من المسارات خاص بمحرك V4L2
  const res = await api.get('/api/devices/capabilities?videoDevice=' + encodeURIComponent('/etc/passwd'));
  assert.equal(res.status, 422);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /جهاز الفيديو/);
});

test('GET /api/devices/capabilities على جهاز غير موجود يعيد 422 لا 500', async () => {
  if (IS_WIN) return;
  const res = await api.get('/api/devices/capabilities?videoDevice=' + encodeURIComponent('/dev/video0'));
  assert.equal(res.status, 422);
  assert.equal(res.json.ok, false);
  assert.equal(typeof res.json.error, 'string');
  assert.equal(typeof res.json.output, 'string');
});

test('POST /api/devices/test يرفض جهازاً غير صالح قبل تشغيل FFmpeg', async () => {
  if (IS_WIN) return;
  const res = await api.post('/api/devices/test', { videoDevice: 'not-a-device' });
  assert.equal(res.status, 422);
  assert.match(res.json.error, /جهاز الفيديو غير صالح/);
});

// ---------------------------------------------------------------- وسائط القناة
test('تشغيل قناة على Linux يبني إدخال V4L2 وإدخال ALSA منفصلاً مع خريطة الصوت 1', async () => {
  if (IS_WIN) return; // هذه الوسائط خاصة بمحرك V4L2

  const source = await api.post('/api/sources', {
    name: 'V4L2 Capture', type: 'usb', videoDevice: '/dev/video0', audioDevice: 'plughw:0',
    videoSize: '1280x720', fps: 30, vcodec: 'mjpeg',
  });
  assert.equal(source.status, 201);
  state.sourceId = source.json.source.id;

  const channel = await api.post('/api/channels', { name: 'قناة V4L2', sourceId: state.sourceId, quality: '360p', fps: 25 });
  assert.equal(channel.status, 201);
  state.channelId = channel.json.channel.id;

  const start = await api.post(`/api/channels/${state.channelId}/start`);
  assert.equal(start.status, 200);
  assert.equal(start.json.ok, true);

  const logs = await waitFor(async () => {
    const res = await api.get('/api/logs');
    return res.json.logs.includes('FFmpeg args:') ? res.json.logs : null;
  }, 5000);
  assert.ok(logs, 'يجب أن يظهر سطر وسائط FFmpeg في السجل');
  assert.match(logs, /-f v4l2/);
  assert.match(logs, /-input_format mjpeg/);
  assert.match(logs, /-i \/dev\/video0/);
  assert.match(logs, /-f alsa/);
  assert.match(logs, /-i plughw:0/);
  assert.match(logs, /-map 0:v:0/);
  assert.match(logs, /-map 1:a:0\?/, 'الصوت من الإدخال الثاني (ALSA)');

  // إيقاف ثم حذف القناة والمصدر — تنظيف بيانات هذا الاختبار.
  await api.post(`/api/channels/${state.channelId}/stop`);
  const delChannel = await api.del(`/api/channels/${state.channelId}`);
  assert.equal(delChannel.status, 200);
  const delSource = await api.del(`/api/sources/${state.sourceId}`);
  assert.equal(delSource.status, 200);
  state.channelId = '';
  state.sourceId = '';
});
