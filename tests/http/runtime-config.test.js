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
let stallFlag = '';
let slowStopFlag = '';
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
// live وoutputBps يظهران في قائمة القنوات فقط، و/running/pid في /api/status.
const channelRow = async () => (await api.get('/api/channels')).json.channels.find((c) => c.id === state.channelId);
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

// عدد مقاطع HLS التي كتبها البديل للقناة: دليل مادي على أن البث يستمر في التوليد.
function stubSegments() {
  try {
    return fs.readdirSync(path.join(srv.dir, 'hls', state.channelId)).filter((name) => name.endsWith('.ts')).length;
  } catch {
    return 0;
  }
}

const windowLines = (text) => String(text || '').split(/\r?\n/).filter((line) => line.includes('استقرار البِتريت'));

test.before(async () => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-ffmpeg-stub-'));
  pidFile = path.join(stubDir, 'pids.txt');
  stallFlag = path.join(stubDir, 'stall');
  // ملف علامة يجعل البديل يتأخر 0.6 ثانية قبل الخروج، فتكون هناك نافذة حقيقية
  // «إغلاق جارٍ» لاختبار سباق الإيقاف اليدوي مع حفظ الإعدادات.
  slowStopFlag = path.join(stubDir, 'slow-stop');
  const stub = path.join(stubDir, 'ffmpeg-stub.sh');
  // يتجاهل وسائط FFmpeg ويبقى حياً حتى تُوقف القناة — يحاكي التقاطاً مستمراً.
  // يكتب أيضاً مقاطع HLS بمعدّل ثابت (56KB كل نصف ثانية = 112KB/s ≈ 896kbps، أي
  // فيديو 800k + صوت 96k كما يفعل الخرج الحقيقي المجمّع في مقاطع HLS) حتى
  // يحسب الخادم معدّلاً فعلياً حقيقياً على نافذة القياس 12 ثانية. اسم المقطع يحمل
  // معرّف العملية حتى تبدأ كل نسخة ملفات جديدة، فلا يُخفي الكتابة فوق ملف قديم نموَّها.
  fs.writeFileSync(stub, `#!/bin/sh
echo $$ >> "${pidFile}"
segment=""
playlist=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "-hls_segment_filename" ]; then segment="$arg"; fi
  previous="$arg"
  playlist="$arg"
done
dir=$(dirname "$segment")
index=1
trap 'if [ -f "${slowStopFlag}" ]; then sleep 0.6; fi; exit 0' TERM INT
while :; do
  # ملف العلامة يحاكي فقدان إشارة الجهاز: العملية تبقى حيّة لكن لا مقاطع تُكتب.
  if [ -f "${stallFlag}" ]; then sleep 0.5; continue; fi
  name=$(printf '%s/seg_%s_%05d.ts' "$dir" "$$" "$index")
  dd if=/dev/zero of="$name" bs=1000 count=56 2>/dev/null
  printf '#EXTM3U\\n#EXT-X-VERSION:3\\n#EXT-X-TARGETDURATION:2\\n#EXTINF:2.0,\\n%s\\n' "$(basename "$name")" > "$playlist"
  index=$((index + 1))
  sleep 0.5
done
`, 'utf8');
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

// ------------------- الإيقاف اليدوي يمنع إعادة التشغيل التلقائية (بما فيها الحفظ)
test('الإيقاف اليدوي يمنع إعادة تشغيل القناة عند حفظ إعدادات الترميز', { skip: SKIP }, async () => {
  await api.post(`/api/channels/${state.channelId}/start`);
  const running = await waitFor(async () => { const s = await status(); return s.running ? s : null; });
  assert.ok(running, 'القناة يجب أن تعمل قبل الإيقاف اليدوي');

  fs.writeFileSync(slowStopFlag, '1');
  const stopped = await api.post(`/api/channels/${state.channelId}/stop`);
  assert.equal(stopped.status, 200);

  // حفظ إعدادات ترميز أثناء إغلاق FFmpeg: كان يفتح القناة الموقوفة يدوياً من جديد.
  const saved = await api.put(`/api/channels/${state.channelId}`, { bitrate: '400k' });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.changedEncoding, ['bitrate']);
  assert.equal(saved.json.restarted, false, 'الحفظ يجب ألا يعيد تشغيل قناة موقوفة يدوياً');

  await sleep(1500);
  assert.equal((await status()).running, false, 'القناة الموقوفة يدوياً يجب أن تبقى متوقفة');
  assert.equal((await channelRow()).manualStopped, true, 'الإيقاف اليدوي يبقى مثبتاً بعد الحفظ');
  assert.equal(aliveStubPids().length, 0, 'يجب ألا تبقى عملية FFmpeg حية');
  fs.rmSync(slowStopFlag, { force: true });
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
  // الانتظار حتى يخرج FFmpeg فعلياً قبل الاختبار التالي (تشغيل أثناء الإغلاق يُرفض).
  await waitFor(() => aliveStubPids().length === 0, 5000);
});

// ------------------------------------- تعديل DirectShow أثناء بث نشط: استمرار واستقرار
test('تغيير إعدادات DirectShow لقناة نشطة يبقي البث مستمراً والبتريت مستقراً', { skip: SKIP }, async () => {
  const configured = await api.put(`/api/channels/${state.channelId}`, { bitrate: '800k', fps: 25 });
  assert.equal(configured.status, 200);
  await api.post(`/api/channels/${state.channelId}/start`);

  // أول نافذة قياس: لا معدّل فعلي قبل مرور 12 ثانية من عينات المقاطع.
  const firstWindow = await waitFor(async () => {
    const row = await channelRow();
    return row && row.live && row.outputBps > 0 ? row : null;
  }, 22000, 300);
  assert.ok(firstWindow, 'يجب أن يظهر معدّل بت فعلي خلال أول نافذة قياس (12 ثانية)');
  assert.equal(firstWindow.live, true, 'قائمة التشغيل يجب أن تكون حديثة قبل التغيير');

  const before = await status();
  const windowsBefore = windowLines(await logs()).length;

  // تعديل جهاز الالتقاط وإعداداته على قناة تبث الآن.
  const updated = await api.put(`/api/sources/${state.sourceId}`, {
    videoDevice: VIDEO_DEVICE_RENAMED, videoSize: '1920x1080', fps: 30, pixelFormat: 'nv12',
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.json.restartedChannels, [state.channelId], 'القناة النشطة تُعاد تشغيلها بالتعديل');

  // 1) استمرار البث: نسخة FFmpeg جديدة تعمل بالقيم الجديدة، ومقاطع جديدة تُكتب.
  const restarted = await waitFor(async () => {
    const s = await status();
    return s.running && s.pid && s.pid !== before.pid ? s : null;
  }, 10000, 100);
  assert.ok(restarted, 'القناة يجب أن تعود للعمل بعد تغيير إعدادات DirectShow');

  const args = argsLines(await logs()).pop() || '';
  assert.match(args, /-video_size 1920x1080/);
  assert.match(args, /-framerate 30/);
  assert.match(args, /-pixel_format nv12/);
  assert.match(args, new RegExp(`video=${VIDEO_DEVICE_RENAMED}`));

  // مُجلد مقاطع القناة يُفرَّغ عند كل تشغيل، فالمقارنة تبدأ بعد إعادة التشغيل:
  // المطلوب أن يبدأ البث فوراً بإنتاج مقاطع جديدة من العملية الجديدة.
  const segmentsAfterRestart = stubSegments();
  const grew = await waitFor(() => stubSegments() > segmentsAfterRestart, 8000, 150);
  assert.ok(grew && stubSegments() > 0, 'البث يجب أن يستمر بإنتاج مقاطع جديدة بعد إعادة التشغيل');

  // 2) الاستقرار: نافذة قياس جديدة بعد التغيير، والفعلي داخل ±10% من الهدف الكلي
  // 896k = فيديو 800k (بِتريت القناة) + صوت 96k (لأن المصدر يحمل جهاز صوت).
  const TARGET_KBPS = 800 + 96;
  const settled = await waitFor(async () => {
    const row = await channelRow();
    if (!row || !row.live || row.outputBps <= 0) return null;
    const lines = windowLines(await logs());
    if (lines.length <= windowsBefore) return null;
    const actualKbps = Math.round((row.outputBps * 8) / 1000);
    if (Math.abs(actualKbps - TARGET_KBPS) / TARGET_KBPS > 0.1) return null;
    return { row, actualKbps, lastLine: lines[lines.length - 1] };
  }, 26000, 500);
  assert.ok(settled, 'البتريت الفعلي يجب أن يبقى ضمن ±10% من الهدف الكلي (896k) بعد تغيير إعدادات DirectShow');
  assert.match(settled.lastLine, /مستقر ضمن الهدف/);
  assert.equal(settled.row.live, true, 'البث يبقى نشطاً (قائمة تشغيل حديثة) بعد التعديل');
  assert.ok(settled.row.outputBps > 0, 'معدّل البت الفعلي يتجدّد بعد التعديل');
  assert.equal(aliveStubPids().length, 1, 'إعادة التشغيل بسبب تعديل المصدر يجب ألا تُبقي نسخة FFmpeg مزدوجة');
});

// ---------------------- فقدان إشارة DirectShow أثناء البث النشط: إعادة محاولة تلقائية
test('فقدان إشارة مصدر DirectShow أثناء البث يعيد الالتقاط تلقائياً', { skip: SKIP }, async () => {
  // بيئة الاختبار تعطّل إعادة التشغيل التلقائي لتجنّب ضجيج السجلات؛ نفعّلها هنا.
  const enabled = await api.put('/api/settings', { autoRestartCrashed: true, maxRestarts: 5, restartBackoffMs: 1000 });
  assert.equal(enabled.status, 200);

  const before = await status();
  assert.equal(before.running, true, 'القناة يجب أن تكون عاملة قبل محاكاة فقدان الإشارة');
  const segmentsBefore = stubSegments();
  const resumedSegments = await waitFor(() => stubSegments() > segmentsBefore, 6000, 150);
  assert.ok(resumedSegments, 'الالتقاط يجب أن يولّد مقاطع قبل فقدان الإشارة');

  // محاكاة فقدان الإشارة: العملية تبقى حيّة لكنها تتوقف عن كتابة أي مقاطع.
  fs.writeFileSync(stallFlag, '1');
  const lossAt = Date.now();
  const restarted = await waitFor(async () => {
    const s = await status();
    return s.running && s.pid && s.pid !== before.pid ? s : null;
  }, 45000, 500);
  assert.ok(restarted, 'الخادم يجب أن ينهي الالتقاط ويعيد المحاولة تلقائياً عند فقدان الإشارة');
  assert.ok(Date.now() - lossAt >= 15000, 'إعادة المحاولة تُنتظر حتى تتجاوز مهلة كشف انقطاع الإشارة');

  const stallLines = String(await logs()).split(/\r?\n/).filter((line) => line.includes('فقدان إشارة مصدر DirectShow'));
  assert.ok(stallLines.length >= 1, 'سبب الإعادة يجب أن يُسجَّل بوضوح في سجل الخادم');
  assert.equal(aliveStubPids().length, 1, 'إعادة المحاولة يجب ألا تُبقي نسخة FFmpeg مزدوجة');

  // زوال العطل: البث يستأنف توليد المقاطع ويعود نشطاً دون تدخل يدوي.
  const segmentsAtRecovery = stubSegments();
  fs.rmSync(stallFlag, { force: true });
  const resumed = await waitFor(async () => {
    const row = await channelRow();
    return row && row.live && stubSegments() > segmentsAtRecovery ? row : null;
  }, 22000, 400);
  assert.ok(resumed, 'البث يجب أن يعود نشطاً تلقائياً بعد عودة إشارة المصدر');
});
