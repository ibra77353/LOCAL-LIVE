'use strict';
// اختبارات تكامل لاستقرار إدارة القنوات وإعدادات DirectShow أثناء التشغيل:
// تغيير Bitrate/FPS للقناة أو بيانات جهاز الالتقاط على قناة تعمل يجب أن يعيد
// تشغيل FFmpeg مرة واحدة بالقيم الجديدة، والحفظ المرفوض يجب ألا يقطع البث.
//
// تُشغَّل الاختبارات على نسخة معزولة من الخادم (tests/http/lib/harness.js) مع
// بديل تنفيذي لـ FFmpeg يبقى حياً دون جهاز التقاط حقيقي، حتى يمكن التحقق من
// سلوك «أثناء التشغيل» دون كرت USB. البديل سكربت POSIX، فتُتخطى اختبارات
// التشغيل على ويندوز (حيث تُجرَّب هذه المسارات على جهاز حقيقي).
//
// التشغيل: node --test tests/http/runtime-config.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startTestServer } = require('./lib/harness');
const { createClient } = require('./lib/client');

const SKIP = process.platform === 'win32'
  ? 'يحتاج بديل FFmpeg قابلاً للتنفيذ (POSIX) لتشغيل قناة حية أثناء الاختبار'
  : false;

const VIDEO_DEVICE = 'USB Video Test Device';
const VIDEO_DEVICE_RENAMED = 'USB Video Renamed Device';
const AUDIO_DEVICE = 'USB Audio Test Device';

let srv;
let api;
let stubDir = '';
let pidFile = '';
const state = { sourceId: '', channelId: '' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 8000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(stepMs);
  }
  return last;
}

const status = async () => (await api.get(`/api/status?channelId=${state.channelId}`)).json;
const logs = async () => (await api.get('/api/logs')).json.logs;
const argsLines = (text) => String(text || '').split(/\r?\n/).filter((line) => line.includes('FFmpeg args:'));

// البديل يسجّل معرّفه عند كل تشغيل، فيمكن عدّ عمليات FFmpeg الحيّة فعلياً:
// نسخة مزدوجة أثناء إعادة التشغيل تظهر كمعرّف إضافي ما زال حياً.
function stubPids() {
  try {
    return fs.readFileSync(pidFile, 'utf8').split(/\r?\n/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function aliveStubPids() {
  return stubPids().filter((pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
}

test.before(async () => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-ffmpeg-stub-'));
  pidFile = path.join(stubDir, 'pids.txt');
  const stub = path.join(stubDir, 'ffmpeg-stub.sh');
  // يتجاهل وسائط FFmpeg ويبقى حياً حتى تُوقف القناة — يحاكي التقاطاً مستمراً.
  fs.writeFileSync(stub, `#!/bin/sh\necho $$ >> "${pidFile}"\ntrap 'exit 0' TERM INT\nwhile :; do sleep 0.2; done\n`, 'utf8');
  fs.chmodSync(stub, 0o755);

  srv = await startTestServer({ port: 3905, ffmpegPath: stub });
  api = createClient(srv.baseUrl);
  await api.post('/api/login', { user: srv.user, pass: srv.pass });

  const source = await api.post('/api/sources', {
    name: 'مصدر DirectShow للتشغيل', type: 'usb',
    videoDevice: VIDEO_DEVICE, audioDevice: AUDIO_DEVICE,
    videoSize: '1280x720', fps: 30, pixelFormat: 'yuyv422',
  });
  assert.equal(source.status, 201, `تعذر إنشاء المصدر: ${source.text}`);
  state.sourceId = source.json.source.id;

  const channel = await api.post('/api/channels', {
    name: 'قناة استقرار التشغيل', sourceId: state.sourceId, quality: '360p', fps: 25, bitrate: '800k',
  });
  assert.equal(channel.status, 201, `تعذر إنشاء القناة: ${channel.text}`);
  state.channelId = channel.json.channel.id;
});

test.after(async () => {
  if (api && state.channelId) await api.post(`/api/channels/${state.channelId}/stop`);
  if (api && state.channelId) await api.del(`/api/channels/${state.channelId}`);
  if (api && state.sourceId) await api.del(`/api/sources/${state.sourceId}`);
  if (srv) await srv.stop();
  if (stubDir) fs.rmSync(stubDir, { recursive: true, force: true });
});

// ------------------------------------------------- تشغيل قناة DirectShow
test('وسائط DirectShow تُبنى من إعدادات المصدر عند تشغيل القناة', { skip: SKIP }, async () => {
  const started = await api.post(`/api/channels/${state.channelId}/start`);
  assert.equal(started.status, 200);
  assert.equal(started.json.ok, true);

  const running = await waitFor(async () => { const s = await status(); return s.running ? s : null; });
  assert.ok(running, 'القناة يجب أن تعمل بعد التشغيل');
  assert.equal(typeof running.pid, 'number');

  const args = argsLines(await logs()).pop() || '';
  assert.match(args, /-f dshow/);
  assert.match(args, /-video_size 1280x720/);
  assert.match(args, /-framerate 30/);
  assert.match(args, /-pixel_format yuyv422/);
  assert.match(args, new RegExp(`video=${VIDEO_DEVICE}:audio=${AUDIO_DEVICE}`));
});

// ------------------------------------------------- تعديل الترميز أثناء التشغيل
test('تغيير Bitrate وFPS أثناء التشغيل يعيد تشغيل القناة مرة واحدة بالقيم الجديدة', { skip: SKIP }, async () => {
  const before = await status();
  assert.equal(before.running, true);

  const res = await api.put(`/api/channels/${state.channelId}`, { bitrate: '1200k', fps: 20 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.changedEncoding, ['fps', 'bitrate']);
  assert.equal(res.json.restarted, true, 'القناة العاملة يجب أن تُعاد تلقائياً');

  const after = await waitFor(async () => {
    const s = await status();
    return s.running && s.pid !== before.pid ? s : null;
  });
  assert.ok(after, 'يجب أن تعمل نسخة جديدة من FFmpeg بعد الحفظ');

  const args = argsLines(await logs()).pop() || '';
  assert.match(args, /-b:v 1200k/);
  assert.match(args, /fps=20/);

  await waitFor(async () => aliveStubPids().length === 1);
  assert.equal(aliveStubPids().length, 1, 'يجب ألا تبقى أكثر من عملية FFmpeg واحدة');
});

test('حفظ سريع متتابع لإعدادات القناة لا يُنشئ نسخ FFmpeg مزدوجة', { skip: SKIP }, async () => {
  const values = ['300k', '500k', '800k', '1000k'];
  const responses = await Promise.all(values.map((bitrate) => api.put(`/api/channels/${state.channelId}`, { bitrate })));
  for (const res of responses) assert.equal(res.status, 200);

  const settled = await waitFor(async () => {
    const s = await status();
    const channel = (await api.get('/api/channels')).json.channels.find((c) => c.id === state.channelId);
    const args = argsLines(await logs()).pop() || '';
    if (!s.running || !channel) return null;
    return args.includes(`-b:v ${channel.bitrate}`) ? { channel, args } : null;
  }, 12000);
  assert.ok(settled, 'آخر حفظ يجب أن ينتهي بقناة تعمل ووسائط تطابق القيمة المحفوظة');
  assert.ok(values.includes(settled.channel.bitrate));

  await sleep(800);
  assert.equal((await status()).running, true);
  assert.equal(aliveStubPids().length, 1, 'التتابع السريع يجب أن يترك عملية FFmpeg واحدة');
});

// ------------------------------------------------- تعديل المصدر أثناء التشغيل
test('تعديل جهاز DirectShow للمصدر أثناء التشغيل يُعيد تشغيل القنوات المرتبطة', { skip: SKIP }, async () => {
  const before = await status();
  assert.equal(before.running, true);

  const res = await api.put(`/api/sources/${state.sourceId}`, {
    videoDevice: VIDEO_DEVICE_RENAMED, videoSize: '1920x1080', fps: 25,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.restartedChannels, [state.channelId]);
  assert.equal(res.json.source.videoDevice, VIDEO_DEVICE_RENAMED);

  const after = await waitFor(async () => {
    const s = await status();
    return s.running && s.pid !== before.pid ? s : null;
  });
  assert.ok(after, 'يجب أن تعود القناة للعمل بالمصدر الجديد');

  const args = await waitFor(async () => {
    const line = argsLines(await logs()).pop() || '';
    return line.includes(`video=${VIDEO_DEVICE_RENAMED}`) ? line : null;
  }, 8000, 150);
  assert.ok(args, 'وسائط FFmpeg يجب أن تحمل الجهاز الجديد');
  assert.match(args, /-video_size 1920x1080/);
  assert.match(args, /-framerate 25/);
  assert.equal(aliveStubPids().length, 1);
});

test('حفظ إعدادات DirectShow غير صالحة أثناء التشغيل يُرفض ويُبقي القناة تعمل', { skip: SKIP }, async () => {
  const before = await status();
  assert.equal(before.running, true);

  const res = await api.put(`/api/sources/${state.sourceId}`, { videoDevice: '' });
  assert.equal(res.status, 400);

  const after = await status();
  assert.equal(after.running, true, 'الحفظ المرفوض يجب ألا يقطع البث');
  assert.equal(after.pid, before.pid, 'طلب مرفوض لا يستدعي إعادة تشغيل');

  const source = (await api.get('/api/sources')).json.sources.find((s) => s.id === state.sourceId);
  assert.equal(source.videoDevice, VIDEO_DEVICE_RENAMED, 'المصدر يبقى بقيمه السابقة');
});

test('تعديل الإعدادات والقناة متوقفة لا يشغّلها تلقائياً', { skip: SKIP }, async () => {
  const stop = await api.post(`/api/channels/${state.channelId}/stop`);
  assert.equal(stop.status, 200);
  const stopped = await waitFor(async () => { const s = await status(); return s.running ? null : s; });
  assert.ok(stopped, 'القناة يجب أن تتوقف');

  const res = await api.put(`/api/sources/${state.sourceId}`, { videoDevice: VIDEO_DEVICE });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.restartedChannels, []);

  await sleep(700);
  assert.equal((await status()).running, false, 'قناة متوقفة لا تُشغَّل بتعديل الإعدادات');

  // القيم الجديدة تُطبَّق عند التشغيل اليدوي التالي.
  await api.post(`/api/channels/${state.channelId}/start`);
  const args = await waitFor(async () => {
    const line = argsLines(await logs()).pop() || '';
    return line.includes(`video=${VIDEO_DEVICE}`) && !line.includes(`video=${VIDEO_DEVICE_RENAMED}`) ? line : null;
  }, 8000, 150);
  assert.ok(args, 'التشغيل اليدوي يقرأ أحدث إعدادات المصدر');
  await api.post(`/api/channels/${state.channelId}/stop`);
});
