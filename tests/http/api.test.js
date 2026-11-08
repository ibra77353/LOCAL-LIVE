'use strict';
// اختبارات HTTP تكاملية لواجهات PrinceLive الأساسية:
// المصادقة، المصادر، القنوات، حالة البث، السجلات، الأجهزة، والإحصاءات.
// تُنفَّذ على نسخة معزولة من الخادم (انظر lib/harness.js) فلا تُمسّ بيانات المستخدم.
//
// التشغيل:  node --test tests/http/
// أو:       node --test tests/http/api.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestServer } = require('./lib/harness');
const { createClient } = require('./lib/client');
const { sleep, waitFor } = require('./lib/wait');

let srv;
let api;
const state = { sourceId: '', channelId: '', networkSourceId: '' };

// المشروع Windows فقط: أسماء الأجهزة هي أسماء DirectShow في كل بيئة تشغيل.
const VIDEO_DEVICE = 'USB Video Test Device';
const VIDEO_DEVICE_RENAMED = 'USB Video Renamed';
const AUDIO_DEVICE = 'USB Audio Test Device';

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
  // نسبة المعالج والذاكرة الحقيقية للشريط العلوي من عدّادات النظام.
  assert.ok(res.json.cpuPercent === null || typeof res.json.cpuPercent === 'number', 'cpuPercent يجب أن يكون رقماً');
  assert.equal(typeof res.json.cpuCount, 'number');
  assert.ok(res.json.memTotalBytes > 0, 'memTotalBytes يجب أن يكون موجباً');
  assert.ok(res.json.memUsedBytes >= 0 && res.json.memUsedBytes <= res.json.memTotalBytes, 'memUsedBytes خارج النطاق');
  assert.equal(res.json.memPercent, Math.round((res.json.memUsedBytes / res.json.memTotalBytes) * 100));
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

test('POST/PUT /api/sources يرفضان الخصائص غير المتوقعة', async () => {
  const postCrf = await api.post('/api/sources', { name: 'مصدر مرفوض', type: 'usb', videoDevice: VIDEO_DEVICE, crf: 23 });
  assert.equal(postCrf.status, 400);
  assert.match(postCrf.json.error, /crf/);
  const postDims = await api.post('/api/sources', { name: 'مصدر مرفوض', type: 'usb', videoDevice: VIDEO_DEVICE, outputWidth: 1280 });
  assert.equal(postDims.status, 400);
  const putCrf = await api.put(`/api/sources/${state.sourceId}`, { videoDevice: VIDEO_DEVICE, crfValue: 18 });
  assert.equal(putCrf.status, 400);
  // المصدر لم يتغيّر بعد الرفض.
  const after = (await api.get('/api/sources')).json.sources.find((s) => s.id === state.sourceId);
  assert.equal(after.videoDevice, VIDEO_DEVICE);
  assert.equal(after.crfValue, undefined);
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
    name: 'قناة اختبار', sourceId: state.sourceId, quality: '360p', fps: 25, bitrate: 'balanced',
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

// نفس التحقق يجب أن يُطبَّق عند الإنشاء، وإلا حُفظت قيمة غير مدعومة يستبدلها
// محرّك الترميز بالتلقائية بصمت لاحقاً.
test('POST /api/channels يرفض الجودة والبِتريت غير الصالحين', async () => {
  const badQuality = await api.post('/api/channels', { name: 'قناة جودة خاطئة', sourceId: state.sourceId, quality: '1080p' });
  assert.equal(badQuality.status, 400);
  const badBitrate = await api.post('/api/channels', { name: 'قناة بِتريت خاطئ', sourceId: state.sourceId, bitrate: 'fast' });
  assert.equal(badBitrate.status, 400);
  const list = await api.get('/api/channels');
  assert.equal(list.json.channels.some(c => c.name === 'قناة جودة خاطئة' || c.name === 'قناة بِتريت خاطئ'), false);
});

test('POST/PUT /api/channels يرفضان الخصائص غير المتوقعة (دقة/CRF/GOP)', async () => {
  const postCrf = await api.post('/api/channels', { name: 'قناة CRF', sourceId: state.sourceId, crf: 23 });
  assert.equal(postCrf.status, 400);
  assert.match(postCrf.json.error, /crf/);
  const postDims = await api.post('/api/channels', { name: 'قناة دقة', sourceId: state.sourceId, outputWidth: 1280, outputHeight: 720 });
  assert.equal(postDims.status, 400);
  const putCrf = await api.put(`/api/channels/${state.channelId}`, { crf: 23 });
  assert.equal(putCrf.status, 400);
  const putEnc = await api.put(`/api/channels/${state.channelId}`, { name: 'اسم مرفوض', outputFps: 30, gopSeconds: 2 });
  assert.equal(putEnc.status, 400);
  // لا يتغيّر شيء في القناة بعد الرفض.
  const after = await api.get('/api/channels');
  const channel = after.json.channels.find((c) => c.id === state.channelId);
  assert.notEqual(channel.name, 'اسم مرفوض');
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

test('PATCH /api/channels/:id يرفض أي خاصية غير التفعيل', async () => {
  const withCrf = await api.patch(`/api/channels/${state.channelId}`, { enabled: true, crf: 23 });
  assert.equal(withCrf.status, 400);
  assert.match(withCrf.json.error, /crf/);
  const widthOnly = await api.patch(`/api/channels/${state.channelId}`, { outputWidth: 1280 });
  assert.equal(widthOnly.status, 400);
  const stillOn = (await api.get('/api/channels')).json.channels.find((c) => c.id === state.channelId);
  assert.equal(stillOn.enabled, true);
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
  assert.match(logs, /-f dshow/);
  assert.match(logs, /video=USB Video Test Device/);

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

// scripts/stop.bat يغلق البرنامج عبر /api/stop، فلو ثبّت هذا المسار إيقافاً يدوياً
// بقيت كل القنوات «موقوفة يدوياً» بعد كل تشغيل ولم تُعد التشغيل التلقائي.
test('POST /api/stop لا يثبّت إيقافاً يدوياً على القنوات', async () => {
  const channelRow = async () =>
    (await api.get('/api/channels')).json.channels.find((c) => c.id === state.channelId);
  await api.post(`/api/channels/${state.channelId}/start`);
  assert.equal((await channelRow()).manualStopped, false, 'التشغيل اليدوي يلغي تثبيت الإيقاف');
  await api.post('/api/stop');
  assert.equal((await channelRow()).manualStopped, false, 'إيقاف الكل يجب ألا يثبّت إيقافاً يدوياً');
});

// ---------------------------------------------------------------- الأجهزة
test('GET /api/devices يعيد قوائم فيديو/صوت بنية ثابتة', async () => {
  const res = await api.get('/api/devices');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(Array.isArray(res.json.video), true);
  assert.equal(Array.isArray(res.json.audio), true);
  assert.equal(typeof res.json.note, 'string');
  assert.equal(res.json.engine, 'dshow');
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
  assert.equal(stats.json.stats.captureEngine, 'dshow');
  assert.equal(typeof stats.json.stats.channels.total, 'number');

  const metrics = await api.get('/api/metrics');
  assert.equal(metrics.status, 200);
  assert.equal(metrics.json.ok, true);
  // ذاكرة النظام الحقيقية: إجمالي > 0، والمستخدم بين صفر والإجمالي، والنسبة مطابقة.
  assert.ok(metrics.json.memTotalBytes > 0, 'memTotalBytes يجب أن يكون موجباً');
  assert.ok(metrics.json.memUsedBytes >= 0 && metrics.json.memUsedBytes <= metrics.json.memTotalBytes, 'memUsedBytes خارج النطاق');
  assert.equal(metrics.json.memPercent, Math.round((metrics.json.memUsedBytes / metrics.json.memTotalBytes) * 100));
});

// باندويث الإنترنت يُقرأ من عدّادات كارت الشبكة في النظام مباشرةً بدل netstat،
// فتظهر قيمة رقمية بدل «—» بعد أول عيّنة (كل 5 ثوانٍ).
test('GET /api/metrics يعرض عدّادات كارت الشبكة من النظام', async () => {
  const m = await waitFor(async () => {
    const res = await api.get('/api/metrics');
    return res.json && res.json.internetBandwidthBps !== null ? res.json : null;
  }, 15000, 500);
  assert.ok(m, 'لم تُقرأ عدّادات كارت الشبكة خلال المهلة');
  assert.ok(m.internetRxBytesTotal >= 0);
});

// إجمالي البيانات يُقرأ من سجلات Nginx لكن العدّ يبدأ من صفر عند كل إقلاع:
// ما كان في السجل قبل الإقلاع يُتجاهل تماماً، وما يُضاف بعده يُجمع (200/206 فقط،
// ومقاطع /hls وحدها تدخل باندويث الخروج، و404 لا تدخل).
test('GET /api/metrics يبدأ عدّاد Nginx من صفر ويجمع ما يُضاف بعد الإقلاع', async () => {
  const logDir = path.join(srv.dir, 'nginx', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, 'stream.log');
  // سجل «تاريخي» من تشغيل سابق: يجب ألا يظهر في أي عدّاد.
  fs.writeFileSync(file, [
    '10.0.0.5 [05/Nov/2026:09:00:00 +0300] "GET /hls/ch_unknown/old.ts HTTP/1.1" 200 5000 rt=0.001',
    '10.0.0.6 [05/Nov/2026:09:00:01 +0300] "GET /admin HTTP/1.1" 200 7000 rt=0.003'
  ].join('\n') + '\n', 'utf8');
  const baseline = await waitFor(async () => {
    const res = await api.get('/api/metrics');
    return res.json && res.json.nginxLogActive ? res.json : null;
  }, 12000, 400);
  assert.ok(baseline, 'لم تُقرأ سجلات Nginx خلال المهلة');
  assert.equal(baseline.nginxBytesTotal, 0, 'بايتات السجل القديم يجب أن تُتجاهل بعد الإقلاع');
  const baseEgress = baseline.egressBytesTotal || 0;

  fs.appendFileSync(file, [
    '10.0.0.5 [05/Nov/2026:10:00:00 +0300] "GET /hls/ch_unknown/index.m3u8 HTTP/1.1" 200 300 rt=0.001',
    '10.0.0.5 [05/Nov/2026:10:00:01 +0300] "GET /hls/ch_unknown/seg00001.ts HTTP/1.1" 206 4096 rt=0.002',
    '10.0.0.6 [05/Nov/2026:10:00:02 +0300] "GET /admin HTTP/1.1" 200 8192 rt=0.003',
    '10.0.0.7 [05/Nov/2026:10:00:03 +0300] "GET /hls/ch_unknown/missing.ts HTTP/1.1" 404 153 rt=0.001'
  ].join('\n') + '\n', 'utf8');
  const m = await waitFor(async () => {
    const res = await api.get('/api/metrics');
    return res.json && res.json.nginxBytesTotal >= 300 + 4096 + 8192 ? res.json : null;
  }, 12000, 400);
  assert.ok(m, 'لم تُقرأ السطور المضافة خلال المهلة');
  assert.equal(m.nginxBytesTotal, 300 + 4096 + 8192);
  assert.equal(m.egressBytesTotal - baseEgress, 300 + 4096);
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

// كل إقلاع يحمل معرّفاً عشوائياً في توقيع الجلسة، فجلسة تشغيل سابق لا تصلح بعد
// إعادة تشغيل النظام ويُطلب تسجيل الدخول من جديد.
test('جلسة اللوحة لا تصلح بعد إعادة تشغيل النظام (BOOT_ID)', async () => {
  const login = await api.post('/api/login', { user: srv.user, pass: srv.pass });
  assert.equal(login.status, 200);
  assert.equal((await api.get('/api/channels')).status, 200);
  const staleCookie = api.getCookie();
  assert.ok(staleCookie, 'يجب أن تكون هناك كوكي جلسة بعد الدخول');

  // خادم آخر بنفس الحساب (نفس مفتاح التوقيع) يمثّل إقلاعاً جديداً.
  const rebooted = await startTestServer({ port: 3909 });
  try {
    const client = createClient(rebooted.baseUrl);
    client.setCookie(staleCookie);
    const rejected = await client.get('/api/channels');
    assert.equal(rejected.status, 401, 'جلسة إقلاع سابق يجب أن تُرفض على إقلاع جديد');
    const fresh = await client.post('/api/login', { user: rebooted.user, pass: rebooted.pass });
    assert.equal(fresh.status, 200);
    assert.equal((await client.get('/api/channels')).status, 200);
  } finally {
    await rebooted.stop();
  }
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

// ------------------------------------------------- جودة الترميز (بتريت/FPS)
// نموذج القناة في اللوحة يرسل fps: null عند إفراغ الحقل، وكان ذلك يُرفض بـ400
// فيتعذر حفظ القناة. الإفراغ يجب أن يعني «استخدم FPS من الإعدادات».
test('PUT /api/channels/:id يقبل إفراغ FPS ويعيده إلى إعدادات الخادم', async () => {
  const src = await api.post('/api/sources', { name: 'مصدر جودة', type: 'file', path: 'srv/uploads/quality-test.mp4' });
  assert.equal(src.status, 201);
  const ch = await api.post('/api/channels', { name: 'قناة جودة', sourceId: src.json.source.id, quality: '360p', fps: 25, bitrate: 'highest' });
  assert.equal(ch.status, 201);
  const id = ch.json.channel.id;

  const nullFps = await api.put(`/api/channels/${id}`, { fps: null });
  assert.equal(nullFps.status, 200);
  assert.equal(nullFps.json.channel.fps, '');

  const emptyFps = await api.put(`/api/channels/${id}`, { fps: '' });
  assert.equal(emptyFps.status, 200);
  assert.equal(emptyFps.json.channel.fps, '');
  // القيمة الفارغة تعني معدل الإطارات الافتراضي (20) عند بناء وسائط FFmpeg.
  assert.equal(nullFps.json.channel.bitrate, 'highest');

  await api.del(`/api/channels/${id}`);
  await api.del(`/api/sources/${src.json.source.id}`);
});

// كل مستوى جودة يمرّر قيمه الثلاث كما في الجدول: -maxrate و-bufsize لا يُشتقّان
// من -b:v، ولا يتكرر أي خيار في وسائط FFmpeg ولا يتعارض.
test('كل مستوى جودة يولّد -b:v و-maxrate و-bufsize الصحيحة في وسائط FFmpeg', async () => {
  const src = await api.post('/api/sources', { name: 'مصدر المستويات', type: 'file', path: 'srv/uploads/quality-test.mp4' });
  assert.equal(src.status, 201);
  const ch = await api.post('/api/channels', { name: 'قناة المستويات', sourceId: src.json.source.id, quality: '360p', fps: 25 });
  assert.equal(ch.status, 201);
  const id = ch.json.channel.id;

  // ننتظر سطر وسائط جديداً يحمل بِتريت المستوى المطلوب، لا أي سطر قديم في السجل.
  const argsFor = async (bitrate) => {
    await api.post(`/api/channels/${id}/start`);
    const line = await waitFor(async () => {
      const res = await api.get('/api/logs');
      return res.json.logs.split(/\r?\n/)
        .filter((l) => l.includes('FFmpeg args:') && l.includes(`-b:v ${bitrate} `)).pop() || null;
    }, 5000);
    await api.post(`/api/channels/${id}/stop`);
    return line || '';
  };

  const levels = [
    ['economy', '300k', '300k', '600k'],
    ['accepted', '400k', '400k', '800k'],
    ['balanced', '500k', '500k', '1000k'],
    ['highest', '600k', '600k', '1200k'],
  ];
  for (const [level, bitrate, maxrate, bufsize] of levels) {
    const saved = await api.put(`/api/channels/${id}`, { bitrate: level });
    assert.equal(saved.status, 200, level);
    assert.equal(saved.json.channel.bitrate, level, 'المستوى يُحفظ كما اختير');
    const args = await argsFor(bitrate);
    assert.match(args, new RegExp(`-b:v ${bitrate} `), level);
    assert.match(args, new RegExp(`-maxrate ${maxrate} `), level);
    assert.match(args, new RegExp(`-bufsize ${bufsize} `), level);
    // لا خيارات مكررة أو متعارضة.
    assert.equal(args.split(' -b:v ').length - 1, 1, `${level}: -b:v مكرر`);
    assert.equal(args.split(' -maxrate ').length - 1, 1, `${level}: -maxrate مكرر`);
    assert.equal(args.split(' -bufsize ').length - 1, 1, `${level}: -bufsize مكرر`);
    assert.doesNotMatch(args, /nal-hrd|-crf/);
  }

  // القيمة القديمة 300k تُقبل وتُحفظ كمعرّف مستوى.
  const legacy = await api.put(`/api/channels/${id}`, { bitrate: '300k' });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.json.channel.bitrate, 'economy');

  await api.del(`/api/channels/${id}`);
  await api.del(`/api/sources/${src.json.source.id}`);
});

// «تلقائي» ليس قيمة ثابتة: الهدف يُحسب من دقة الخرج × FPS، ثم يُختار أصغر مستوى
// يغطيه؛ فتغيير FPS وحده قد يغيّر المستوى.
test('الوضع التلقائي يشتق المستوى من دقة الخرج ومعدل الإطارات', async () => {
  const src = await api.post('/api/sources', { name: 'مصدر التلقائي', type: 'file', path: 'srv/uploads/quality-test.mp4' });
  assert.equal(src.status, 201);
  const ch = await api.post('/api/channels', { name: 'قناة التلقائي', sourceId: src.json.source.id, quality: '240p', fps: 15, bitrate: 'auto' });
  assert.equal(ch.status, 201);
  const id = ch.json.channel.id;

  // ننتظر تشغيلاً جديداً يحمل الهدف المحسوب المتوقع، فلا يكفي سطر قديم من تشغيل سابق.
  const runFor = async (expectedTarget, expectedBitrate) => {
    await api.post(`/api/channels/${id}/start`);
    const logs = await waitFor(async () => {
      const res = await api.get('/api/logs');
      const lines = res.json.logs.split(/\r?\n/);
      const decision = lines.filter((l) => l.includes('جودة الفيديو التلقائية') && l.includes(`الهدف ${expectedTarget}k`)).pop();
      const argsLine = lines.filter((l) => l.includes('FFmpeg args:') && l.includes(`-b:v ${expectedBitrate} `)).pop();
      return decision && argsLine ? { args: argsLine, decision } : null;
    }, 5000);
    await api.post(`/api/channels/${id}/stop`);
    return logs || { args: '', decision: '' };
  };

  // 426×240@15 → الهدف 153k ⇒ اقتصادي (300k/300k/600k).
  let run = await runFor(153, '300k');
  assert.match(run.decision, /«اقتصادي»/);
  assert.match(run.args, /-b:v 300k /);
  assert.match(run.args, /-maxrate 300k /);
  assert.match(run.args, /-bufsize 600k /);

  // نفس الدقة بمعدّل إطارات أعلى: 426×240@30 = 307k ⇒ مقبول (400k/400k/800k).
  await api.put(`/api/channels/${id}`, { fps: 30 });
  run = await runFor(307, '400k');
  assert.match(run.decision, /«مقبول»/);
  assert.match(run.args, /-b:v 400k /);
  assert.match(run.args, /-maxrate 400k /);
  assert.match(run.args, /-bufsize 800k /);

  // دقة 360p@25 = 576k ⇒ أعلى (600k/600k/1200k).
  await api.put(`/api/channels/${id}`, { quality: '360p', fps: 25 });
  run = await runFor(576, '600k');
  assert.match(run.decision, /«أعلى»/);
  assert.match(run.args, /-b:v 600k /);
  assert.match(run.args, /-maxrate 600k /);
  assert.match(run.args, /-bufsize 1200k /);

  await api.del(`/api/channels/${id}`);
  await api.del(`/api/sources/${src.json.source.id}`);
});

// gopSeconds إعداد عام (1..10 ثوانٍ، بلا وضع تلقائي): -g = fps × القيمة.
test('gopSeconds العام يضبط -g في وسائط FFmpeg', async () => {
  const src = await api.post('/api/sources', { name: 'مصدر GOP', type: 'file', path: 'srv/uploads/quality-test.mp4' });
  assert.equal(src.status, 201);
  const ch = await api.post('/api/channels', { name: 'قناة GOP', sourceId: src.json.source.id, quality: '360p', fps: 25 });
  assert.equal(ch.status, 201);
  const id = ch.json.channel.id;

  const argsGop = async () => {
    await api.post(`/api/channels/${id}/start`);
    const line = await waitFor(async () => {
      const res = await api.get('/api/logs');
      return res.json.logs.split(/\r?\n/).filter((l) => l.includes('FFmpeg args:')).pop() || null;
    }, 5000);
    await api.post(`/api/channels/${id}/stop`);
    return /-g (\d+)/.exec(line || '')?.[1];
  };

  assert.equal(await argsGop(), '50', 'الافتراضي 2 ثانية = 25 إطاراً × 2');
  const saved = await api.put('/api/settings', { gopSeconds: 1 });
  assert.equal(saved.status, 200);
  assert.equal(await argsGop(), '25', 'القيمة العامة = 25 إطاراً × 1 ثانية');
  assert.equal((await api.put('/api/settings', { gopSeconds: 0 })).status, 400, 'لا وضع تلقائي بعد الآن');

  await api.put('/api/settings', { gopSeconds: 2 });
  await api.del(`/api/channels/${id}`);
  await api.del(`/api/sources/${src.json.source.id}`);
});

// تغيير إعدادات الترميز (Bitrate/الجودة/FPS) لا يحتاج إعادة تشغيل يدوية:
// الخادم يبلّغ عن الحقول المتغيّرة، ويعيد تشغيل القناة تلقائياً إن كانت تعمل.
test('حفظ إعدادات الترميز يبلّغ عن الحقول المتغيّرة لتطبيقها تلقائياً', async () => {
  const src = await api.post('/api/sources', { name: 'مصدر إعادة التشغيل', type: 'file', path: 'srv/uploads/quality-test.mp4' });
  assert.equal(src.status, 201);
  const ch = await api.post('/api/channels', { name: 'قناة إعادة التشغيل', sourceId: src.json.source.id, quality: '360p', fps: 25, bitrate: 'accepted' });
  assert.equal(ch.status, 201);
  const id = ch.json.channel.id;

  const changed = await api.put(`/api/channels/${id}`, { bitrate: 'highest' });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.json.changedEncoding, ['bitrate']);
  // القناة متوقفة في هذا الاختبار، فلا إعادة تشغيل.
  assert.equal(changed.json.restarted, false);

  const namesOnly = await api.put(`/api/channels/${id}`, { name: 'قناة إعادة التشغيل' });
  assert.deepEqual(namesOnly.json.changedEncoding, []);

  await api.del(`/api/channels/${id}`);
  await api.del(`/api/sources/${src.json.source.id}`);
});

// إعدادات الترميز العامة (/api/settings) تتبع عقد حفظ القناة نفسه: تُبلِّغ عن
// الحقول المتغيّرة وتعيد تشغيل القنوات النشطة (لا قناة عاملة هنا، فالقائمة فارغة).
test('حفظ إعدادات الترميز العامة يبلّغ عن الحقول المتغيّرة', async () => {
  const before = (await api.get('/api/settings')).json.settings;
  const saved = await api.put('/api/settings', { x264Preset: 'fast', hlsListSize: 8 });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.changedSettings.sort(), ['hlsListSize', 'x264Preset']);
  assert.deepEqual(saved.json.restartedChannels, [], 'لا قناة نشطة في هذه اللحظة');

  // الحفظ نفسه بالقيم نفسها لا يعيد تشغيل أي قناة.
  const repeated = await api.put('/api/settings', { x264Preset: 'fast', hlsListSize: 8 });
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.json.changedSettings, []);
  assert.deepEqual(repeated.json.restartedChannels, []);

  await api.put('/api/settings', { x264Preset: before.x264Preset ?? 'veryfast', hlsListSize: before.hlsListSize ?? 6 });
});

// إعدادات الدقة العامة ألغيت: الدقة تُضبط لكل قناة، فأي محاولة لحفظها من
// /api/settings تُرفض كخاصية غير متوقعة بدل تجاهلها بصمت.
test('إعدادات الدقة العامة ألغيت وتُرفض من /api/settings', async () => {
  for (const body of [{ outputWidth: 642 }, { outputHeight: 362 }, { outputFps: 30 }]) {
    const res = await api.put('/api/settings', body);
    assert.equal(res.status, 400);
  }
  const after = (await api.get('/api/settings')).json.settings;
  assert.equal(after.outputWidth, undefined);
  assert.equal(after.outputHeight, undefined);
  assert.equal(after.outputFps, undefined);
  // gopSeconds ما زال مدعوماً كإعداد عام صريح (1..10 ثوانٍ).
  const savedGop = await api.put('/api/settings', { gopSeconds: 4 });
  assert.equal(savedGop.status, 200);
  assert.equal(savedGop.json.settings.gopSeconds, 4);
  await api.put('/api/settings', { gopSeconds: 2 });
});

// POST وPUT متكافئان على /api/settings: كلاهما يحفظ ويطبّق الإعدادات فوراً،
// فالواجهة الأمامية تستطيع إرسال التحديثات بأي من الطريقتين.
test('POST /api/settings يحفظ الإعدادات كـPUT ويطبّقها على القنوات النشطة', async () => {
  const before = (await api.get('/api/settings')).json.settings;
  const targetThreads = Number(before.x264Threads) === 4 ? 3 : 4;
  const saved = await api.post('/api/settings', { x264Threads: targetThreads });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.changedSettings, ['x264Threads']);
  assert.deepEqual(saved.json.restartedChannels, [], 'لا قناة نشطة في هذه اللحظة');
  assert.equal(saved.json.settings.x264Threads, targetThreads);

  const rejected = await api.post('/api/settings', { crf: 23 });
  assert.equal(rejected.status, 400);

  await api.put('/api/settings', { x264Threads: before.x264Threads });
  assert.equal((await api.get('/api/settings')).json.settings.x264Threads, before.x264Threads);
});

// وضع الجودة (x264QualityMode) إعداد عام معتمد مثل باقي إعدادات الترميز:
// يُحفظ منطقياً ويُعاد في استجابة الإعدادات، ويُغيَّر عبر POST كما عبر PUT.
test('POST /api/settings يحفظ x264QualityMode ويعيده', async () => {
  const before = (await api.get('/api/settings')).json.settings.x264QualityMode;
  const saved = await api.post('/api/settings', { x264QualityMode: true });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.settings.x264QualityMode, true);
  assert.ok(saved.json.changedSettings.includes('x264QualityMode'));
  const restore = await api.put('/api/settings', { x264QualityMode: !!before });
  assert.equal(restore.status, 200);
  assert.equal(restore.json.settings.x264QualityMode, !!before);
});

test('GET /api/settings يعيد مستويات جودة الفيديو من المصدر المشترك', async () => {
  const res = await api.get('/api/settings');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.videoLevels.map((level) => [level.id, level.bitrate, level.maxrate, level.bufsize]), [
    ['auto', '', '', ''],
    ['economy', '300k', '300k', '600k'],
    ['accepted', '400k', '400k', '800k'],
    ['balanced', '500k', '500k', '1000k'],
    ['highest', '600k', '600k', '1200k']
  ]);
});

test('PUT /api/settings يرفض الخصائص غير المتوقعة', async () => {
  const withCrf = await api.put('/api/settings', { siteName: 'اسم مرفوض', crf: 23 });
  assert.equal(withCrf.status, 400);
  assert.match(withCrf.json.error, /crf/);
  const legacy = await api.put('/api/settings', { encodingMode: 'crf', defaultBitrate: '800k' });
  assert.equal(legacy.status, 400);
  const after = (await api.get('/api/settings')).json.settings;
  assert.notEqual(after.siteName, 'اسم مرفوض');
  assert.equal(after.encodingMode, undefined);
  assert.equal(after.defaultBitrate, undefined);
});

// وضع الترميز الوحيد هو Bitrate: معدّل البت خاص بكل قناة، ولا يوجد إعداد عام،
// وحقول CRF القديمة (encodingMode/crfValue) تُتجاهل ولا تُحفظ.
test('Bitrate خاص بكل قناة ويُطبَّق في وسائط FFmpeg بلا إعداد عام', async () => {
  const src = await api.post('/api/sources', { name: 'مصدر وضع القناة', type: 'file', path: 'srv/uploads/quality-test.mp4' });
  assert.equal(src.status, 201);
  const ch = await api.post('/api/channels', { name: 'قناة وضع خاص', sourceId: src.json.source.id, quality: '360p', fps: 25 });
  assert.equal(ch.status, 201);
  const id = ch.json.channel.id;
  // لا يوجد حقل وضع ترميز في القناة بعد إلغاء CRF
  assert.equal(ch.json.channel.encodingMode, undefined);
  assert.equal(ch.json.channel.crfValue, undefined);

  const argsFor = async () => {
    await api.post(`/api/channels/${id}/start`);
    const logs = await waitFor(async () => {
      const res = await api.get('/api/logs');
      const hit = res.json.logs.split(/\r?\n/).filter((l) => l.includes('FFmpeg args:')).pop();
      return hit || null;
    }, 5000);
    await api.post(`/api/channels/${id}/stop`);
    return logs || '';
  };

  // مستوى «أعلى» بقيمه الثلاث: 600k / 600k / 1200k
  const setBitrate = await api.put(`/api/channels/${id}`, { bitrate: 'highest' });
  assert.equal(setBitrate.status, 200);
  assert.equal(setBitrate.json.channel.bitrate, 'highest');
  const channelBitrateArgs = await argsFor();
  assert.match(channelBitrateArgs, /-b:v 600k /);
  assert.match(channelBitrateArgs, /-maxrate 600k /);
  assert.match(channelBitrateArgs, /-bufsize 1200k /);
  assert.doesNotMatch(channelBitrateArgs, /-crf/);
  assert.match(channelBitrateArgs, /scale=640:360/);
  assert.doesNotMatch(channelBitrateArgs, /pad=/);
  assert.match(channelBitrateArgs, /-r 25/);
  assert.match(channelBitrateArgs, /-preset (superfast|veryfast)/);

  // قيمة خارج جدول المستويات تُرفض بدل تخمين -maxrate/-bufsize لها.
  const unknownLevel = await api.put(`/api/channels/${id}`, { bitrate: '1200k' });
  assert.equal(unknownLevel.status, 400);

  // «تلقائي» يُحسب من الدقة وFPS (360p@25 = 576k ⇒ أعلى 600k)
  const emptyBitrate = await api.put(`/api/channels/${id}`, { bitrate: '' });
  assert.equal(emptyBitrate.status, 200);
  assert.equal(emptyBitrate.json.channel.bitrate, 'auto');
  assert.match(await argsFor(), /-b:v 600k /);

  // حقول CRF القديمة تُرفض صراحةً ولا تُحفظ في القناة
  const legacy = await api.put(`/api/channels/${id}`, { encodingMode: 'crf', crfValue: 18 });
  assert.equal(legacy.status, 400);
  assert.match(legacy.json.error, /encodingMode|crfValue/);

  // الإعدادات العامة لا تحمل وضع ترميز أو بِتريت افتراضياً
  const settings = (await api.get('/api/settings')).json.settings;
  assert.equal(settings.encodingMode, undefined);
  assert.equal(settings.crfValue, undefined);
  assert.equal(settings.defaultBitrate, undefined);

  await api.del(`/api/channels/${id}`);
  await api.del(`/api/sources/${src.json.source.id}`);
});
