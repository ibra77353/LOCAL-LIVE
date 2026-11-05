'use strict';
// اختبارات HTTP تكاملية لواجهات PrinceLive الأساسية:
// المصادقة، المصادر، القنوات، حالة البث، السجلات، الأجهزة، والإحصاءات.
// تُنفَّذ على نسخة معزولة من الخادم (انظر lib/harness.js) فلا تُمسّ بيانات المستخدم.
//
// التشغيل:  node --test tests/http/
// أو:       node --test tests/http/api.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./lib/harness');
const { createClient } = require('./lib/client');

let srv;
let api;
const state = { sourceId: '', channelId: '', networkSourceId: '' };

// أسماء أجهزة الاختبار تتبع محرك الالتقاط الخاص بنظام التشغيل:
// DirectShow يستخدم أسماء أجهزة، وV4L2 يستخدم مسارات /dev/video* مع ALSA للصوت.
const IS_WIN = process.platform === 'win32';
const VIDEO_DEVICE = IS_WIN ? 'USB Video Test Device' : '/dev/video0';
const VIDEO_DEVICE_RENAMED = IS_WIN ? 'USB Video Renamed' : '/dev/video1';
const AUDIO_DEVICE = IS_WIN ? 'USB Audio Test Device' : 'plughw:0';

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
  srv = await startTestServer({ port: 3901 });
  api = createClient(srv.baseUrl);
});

test.after(async () => {
  if (srv) await srv.stop();
});

// ---------------------------------------------------------------- عام
test('GET /api/public/settings يعيد إعدادات المشاهد دون مسارات النظام', async () => {
  const res = await api.get('/api/public/settings');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(res.json.settings);
  assert.equal(typeof res.json.settings.siteName, 'string');
  assert.equal(res.json.settings.ffmpegPath, undefined, 'المسارات الداخلية يجب ألا تُسرَّب للعامة');
});

test('GET /api/status يعيد ok:true مع قائمة القنوات', async () => {
  const res = await api.get('/api/status');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(Array.isArray(res.json.channels), true);
  assert.equal(res.json.running, false);
});

// فحص Nginx: الحالة تُشتق من استماع فعلي على منفذ Nginx، والسبب يظهر فقط عند الغياب.
test('حالة Nginx مشتقة من استماع فعلي على منفذ Nginx', async () => {
  const res = await api.get('/api/status');
  assert.equal(typeof res.json.nginx, 'boolean');
  assert.equal(res.json.nginxBinding.listening, res.json.nginx);
  assert.equal(res.json.nginxBinding.port, 80);
  assert.equal(res.json.nginxBinding.reason, res.json.nginx ? '' : 'لم يستجب أي خدمة على المنفذ 80');
});

test('الصفحات الثابتة تُخدم من web/', async () => {
  const home = await api.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /<html/i);
  const admin = await api.get('/admin');
  assert.equal(admin.status, 200);
  assert.match(admin.text, /<html/i);
});

test('طلبات HLS غير المعروفة والمحاولات الخبيثة لا تُعيد محتوى', async () => {
  const missing = await api.get('/hls/doesnotexist/index.m3u8');
  assert.equal(missing.status, 404);
  const traversal = await api.get('/hls/..%2f..%2fetc%2fpasswd');
  assert.notEqual(traversal.status, 200);
});

// ---------------------------------------------------------------- المصادقة
test('نقاط الإدارة ترفض الطلبات غير المصادقة بـ 401', async () => {
  for (const path of ['/api/channels', '/api/sources', '/api/settings', '/api/stats', '/api/logs']) {
    const res = await api.get(path);
    assert.equal(res.status, 401, `${path} يجب أن يعيد 401`);
    assert.equal(res.json.ok, false);
  }
});

test('GET /api/me يعيد authed:false قبل الدخول', async () => {
  const res = await api.get('/api/me');
  assert.equal(res.status, 200);
  assert.equal(res.json.authed, false);
});

test('POST /api/login بلا بيانات يعيد 400', async () => {
  const res = await api.post('/api/login', {});
  assert.equal(res.status, 400);
});

test('POST /api/login بكلمة مرور خاطئة يعيد 401 ولا يمنح كوكي', async () => {
  const res = await api.post('/api/login', { user: srv.user, pass: 'wrong-password' });
  assert.equal(res.status, 401);
  assert.equal(res.json.ok, false);
  assert.equal(api.hasCookie(), false);
});

test('POST /api/login صحيح يمنح جلسة تعمل على نقاط الإدارة', async () => {
  const res = await api.post('/api/login', { user: srv.user, pass: srv.pass });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(api.hasCookie(), true);

  const me = await api.get('/api/me');
  assert.equal(me.json.authed, true);
  const channels = await api.get('/api/channels');
  assert.equal(channels.status, 200);
  assert.equal(Array.isArray(channels.json.channels), true);
});

// ---------------------------------------------------------------- المصادر
test('POST /api/sources يرفض المدخلات غير الصالحة', async () => {
  const noName = await api.post('/api/sources', { type: 'usb', videoDevice: 'USB Video' });
  assert.equal(noName.status, 400);

  const badType = await api.post('/api/sources', { name: 'x', type: 'satellite' });
  assert.equal(badType.status, 400);

  const usbNoDevice = await api.post('/api/sources', { name: 'x', type: 'usb' });
  assert.equal(usbNoDevice.status, 400);
  assert.match(usbNoDevice.json.error, /جهاز الفيديو/);

  const badUrl = await api.post('/api/sources', { name: 'x', type: 'http', url: 'ftp://example.com/a.m3u8' });
  assert.equal(badUrl.status, 400);
});

test('POST /api/sources ينشئ مصدر USB ومصدر شبكي', async () => {
  const usb = await api.post('/api/sources', {
    name: 'USB Test', type: 'usb', videoDevice: VIDEO_DEVICE,
    audioDevice: AUDIO_DEVICE, videoSize: '1280x720', fps: 30, vcodec: 'mjpeg',
  });
  assert.equal(usb.status, 201);
  assert.equal(usb.json.ok, true);
  assert.match(usb.json.source.id, /^src_/);
  state.sourceId = usb.json.source.id;

  const net = await api.post('/api/sources', { name: 'Net Test', type: 'http', url: 'http://127.0.0.1:9/stream.m3u8' });
  assert.equal(net.status, 201);
  state.networkSourceId = net.json.source.id;

  const list = await api.get('/api/sources');
  assert.equal(list.status, 200);
  const ids = list.json.sources.map((s) => s.id);
  assert.ok(ids.includes(state.sourceId));
  assert.ok(ids.includes(state.networkSourceId));
});

test('PUT /api/sources/:id يحدّث المصدر ويرفض المجهول', async () => {
  const ok = await api.put(`/api/sources/${state.sourceId}`, { videoDevice: VIDEO_DEVICE_RENAMED });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.source.videoDevice, VIDEO_DEVICE_RENAMED);
  await api.put(`/api/sources/${state.sourceId}`, { videoDevice: VIDEO_DEVICE });

  const missing = await api.put('/api/sources/src_doesnotexist', { name: 'x' });
  assert.equal(missing.status, 404);
});

// ---------------------------------------------------------------- القنوات
test('POST /api/channels يتحقق من الاسم والمصدر', async () => {
  const noName = await api.post('/api/channels', { sourceId: state.sourceId });
  assert.equal(noName.status, 400);
  const badSource = await api.post('/api/channels', { name: 'قناة', sourceId: 'src_missing' });
  assert.equal(badSource.status, 400);
});

test('POST /api/channels ينشئ قناة مرتبطة بالمصدر', async () => {
  const res = await api.post('/api/channels', {
    name: 'قناة اختبار', sourceId: state.sourceId, quality: '360p', fps: 25, bitrate: '500k',
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.ok, true);
  assert.match(res.json.channel.id, /^ch_/);
  state.channelId = res.json.channel.id;

  const list = await api.get('/api/channels');
  assert.ok(list.json.channels.some((c) => c.id === state.channelId));
});

test('PUT /api/channels/:id يرفض الجودة وFPS والبِتريت غير الصالحة', async () => {
  const badQuality = await api.put(`/api/channels/${state.channelId}`, { quality: '999p' });
  assert.equal(badQuality.status, 400);
  const badFps = await api.put(`/api/channels/${state.channelId}`, { fps: 0 });
  assert.equal(badFps.status, 400);
  const badBitrate = await api.put(`/api/channels/${state.channelId}`, { bitrate: 'fast' });
  assert.equal(badBitrate.status, 400);
});

test('PUT /api/channels/:id يقبل تعديلاً صالحاً', async () => {
  const res = await api.put(`/api/channels/${state.channelId}`, { name: 'قناة اختبار محدّثة', quality: '720p' });
  assert.equal(res.status, 200);
  assert.equal(res.json.channel.name, 'قناة اختبار محدّثة');
});

test('PATCH /api/channels/:id يبدّل حالة التفعيل', async () => {
  const off = await api.patch(`/api/channels/${state.channelId}`, { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.json.ok, true);
  const on = await api.patch(`/api/channels/${state.channelId}`, { enabled: true });
  assert.equal(on.json.ok, true);
});

// 409 Conflict هو السلوك المقصود في server.js (سطر 1362): المصدر المرتبط بقناة لا يُحذف.
test('DELETE /api/sources يرفض مصدراً مرتبطاً بقناة (409)', async () => {
  const res = await api.del(`/api/sources/${state.sourceId}`);
  assert.equal(res.status, 409);
  assert.match(res.json.error, /قناة/);
});

// ---------------------------------------------------------------- البث
test('POST /api/channels/:id/start يبني وسائط FFmpeg ويسجّل الخروج', async () => {
  const start = await api.post(`/api/channels/${state.channelId}/start`);
  assert.equal(start.status, 200);
  assert.equal(start.json.ok, true);

  const logs = await waitFor(async () => {
    const res = await api.get('/api/logs');
    return res.json.logs.includes('FFmpeg args:') ? res.json.logs : null;
  }, 5000);
  assert.ok(logs, 'يجب أن يظهر سطر وسائط FFmpeg في السجل');
  assert.match(logs, IS_WIN ? /-f dshow/ : /-f v4l2/);
  assert.match(logs, IS_WIN ? /video=USB Video Test Device/ : /-i \/dev\/video0/);

  const status = await waitFor(async () => {
    const res = await api.get(`/api/status?channelId=${state.channelId}`);
    return res.json.lastExit ? res.json : null;
  }, 8000);
  assert.ok(status, 'يجب تسجيل آخر خروج بعد فشل جهاز الالتقاط غير الموجود');
  assert.equal(status.ok, true);
  assert.equal(status.running, false);
  assert.equal(typeof status.lastExit.reason, 'string');

  const channelLog = await api.get(`/api/logs/${state.channelId}`);
  assert.equal(channelLog.status, 200);
  assert.equal(typeof channelLog.json.log, 'string');
});

test('POST /api/channels/:id/stop يوقف القناة ويُعيد ok:true', async () => {
  const res = await api.post(`/api/channels/${state.channelId}/stop`);
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  const status = await api.get(`/api/status?channelId=${state.channelId}`);
  assert.equal(status.json.running, false);
});

test('POST /api/start و /api/stop يعملان على مستوى كل القنوات', async () => {
  const start = await api.post('/api/start');
  assert.equal(start.status, 200);
  assert.equal(start.json.ok, true);
  const stop = await api.post('/api/stop');
  assert.equal(stop.status, 200);
  assert.equal(stop.json.ok, true);
});

// ---------------------------------------------------------------- الأجهزة
test('GET /api/devices يعيد قوائم فيديو/صوت بنية ثابتة', async () => {
  const res = await api.get('/api/devices');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(Array.isArray(res.json.video), true);
  assert.equal(Array.isArray(res.json.audio), true);
  assert.equal(typeof res.json.note, 'string');
});

test('نقاط الأجهزة ترفض المدخلات الناقصة بـ 422', async () => {
  const test_ = await api.post('/api/devices/test', {});
  assert.equal(test_.status, 422);
  const testAudio = await api.post('/api/devices/test-audio', {});
  assert.equal(testAudio.status, 422);
  const capabilities = await api.get('/api/devices/capabilities');
  assert.equal(capabilities.status, 422);
  const options = await api.get('/api/devices/options');
  assert.equal(options.status, 422);
});

// ---------------------------------------------------------------- الإحصاءات
test('GET /api/stats و /api/metrics يعيدان بيانات صالحة', async () => {
  const stats = await api.get('/api/stats');
  assert.equal(stats.status, 200);
  assert.equal(stats.json.ok, true);
  assert.equal(typeof stats.json.stats.platform, 'string');
  assert.equal(typeof stats.json.stats.channels.total, 'number');

  const metrics = await api.get('/api/metrics');
  assert.equal(metrics.status, 200);
  assert.equal(metrics.json.ok, true);
});

test('المسارات غير المعروفة تحت /api تعيد 404 بصيغة JSON', async () => {
  const res = await api.get('/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.ok(res.json);
});

// ---------------------------------------------------------------- الجلسات
test('POST /api/logout يُبطل الجلسة القديمة (session epoch)', async () => {
  const before = await api.get('/api/channels');
  assert.equal(before.status, 200);

  const logout = await api.post('/api/logout');
  assert.equal(logout.status, 200);

  const after = await api.get('/api/channels');
  assert.equal(after.status, 401, 'بعد الخروج يجب رفض الجلسة القديمة');

  const relogin = await api.post('/api/login', { user: srv.user, pass: srv.pass });
  assert.equal(relogin.status, 200);
  const again = await api.get('/api/channels');
  assert.equal(again.status, 200);
});

// ---------------------------------------------------------------- التنظيف
test('حذف القناة ثم المصادر يعيد الحالة إلى الصفر', async () => {
  const delChannel = await api.del(`/api/channels/${state.channelId}`);
  assert.equal(delChannel.status, 200);
  assert.equal(delChannel.json.ok, true);

  for (const id of [state.sourceId, state.networkSourceId]) {
    const res = await api.del(`/api/sources/${id}`);
    assert.equal(res.status, 200, `حذف المصدر ${id}`);
  }

  const channels = await api.get('/api/channels');
  const sources = await api.get('/api/sources');
  assert.equal(channels.json.channels.length, 0);
  assert.equal(sources.json.sources.length, 0);
});
