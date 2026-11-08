'use strict';
// اختبارات تكامل لمستويات البِتريت: كل مستوى في جدول lib/shared/video-levels.js
// يجب أن يصل إلى FFmpeg بمعاملاته الثلاثة كما هي (-b:v و-maxrate و-bufsize)،
// والوضع «تلقائي» يصل بالمستوى الذي حسبه الخادم من دقة الخرج ومعدّل الإطارات.
//
// تُشغَّل على نسخة معزولة من الخادم (tests/http/lib/harness.js) مع بديل FFmpeg
// (سكربت POSIX يبقى حياً دون جهاز التقاط حقيقي)، وتُقرأ الوسائط من سجل الخادم.
// التشغيل: node --test tests/ffmpeg-tiers.js  أو  npm run test:tiers

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startTestServer } = require('./http/lib/harness');
const { createClient } = require('./http/lib/client');
const { waitFor } = require('./http/lib/wait');

const SKIP = process.platform === 'win32'
  ? 'يحتاج بديل FFmpeg قابلاً للتنفيذ (POSIX) لتشغيل قناة أثناء الاختبار'
  : false;

// القيم المتوقعة لكل مستوى، مأخوذة نصاً من جدول VIDEO_BITRATE_LEVELS.
// خرج القناة هنا 360p من مصدر 1280x720 أي 640×360 عند 20 إطاراً، فالوضع التلقائي
// يحسب 640×360×20×0.1 = 461k فيختار «متوازن» (500k/600k/800k).
const LEVELS = [
  { id: 'economy', bv: '300k', maxrate: '400k', bufsize: '600k' },
  { id: 'accepted', bv: '400k', maxrate: '500k', bufsize: '700k' },
  { id: 'balanced', bv: '500k', maxrate: '600k', bufsize: '800k' },
  { id: 'highest', bv: '600k', maxrate: '700k', bufsize: '900k' },
  { id: 'auto', bv: '500k', maxrate: '600k', bufsize: '800k', autoTarget: '461k' }
];

let srv;
let api;
let stubDir = '';
let pidFile = '';
const state = { sourceId: '', channelId: '' };

const logs = async () => (await api.get('/api/logs')).json.logs;
const argsLines = (text) => String(text || '').split(/\r?\n/).filter((line) => line.includes('FFmpeg args:'));
const logLines = (text) => String(text || '').split(/\r?\n/);

// البديل يسجّل معرّفه عند كل تشغيل، فيمكن التأكد من خروج العملية قبل التشغيل التالي.
function aliveStubPids() {
  let pids = [];
  try { pids = fs.readFileSync(pidFile, 'utf8').split(/\r?\n/).filter(Boolean).map(Number); } catch { return []; }
  return pids.filter((pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
}

test.before(async () => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-ffmpeg-tiers-'));
  pidFile = path.join(stubDir, 'pids.txt');
  const stub = path.join(stubDir, 'ffmpeg-stub.sh');
  // يتجاهل وسائط FFmpeg ويبقى حياً حتى تُوقف القناة — يكفي لالتقاط الوسائط من السجل.
  fs.writeFileSync(stub, `#!/bin/sh
echo $$ >> "${pidFile}"
trap 'exit 0' TERM INT
while :; do sleep 1; done
`, 'utf8');
  fs.chmodSync(stub, 0o755);

  srv = await startTestServer({ port: 3906, ffmpegPath: stub });
  api = createClient(srv.baseUrl);
  const login = await api.post('/api/login', { user: srv.user, pass: srv.pass });
  assert.equal(login.status, 200, `تعذر تسجيل الدخول: ${login.text}`);

  const source = await api.post('/api/sources', {
    name: 'مصدر مستويات البِتريت', type: 'usb',
    videoDevice: 'USB Video Tiers', audioDevice: 'USB Audio Tiers',
    videoSize: '1280x720', fps: 30,
  });
  assert.equal(source.status, 201, `تعذر إنشاء المصدر: ${source.text}`);
  state.sourceId = source.json.source.id;

  const channel = await api.post('/api/channels', {
    name: 'قناة مستويات البِتريت', sourceId: state.sourceId, quality: '360p', fps: 20, bitrate: 'balanced',
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

for (const level of LEVELS) {
  test(`المستوى «${level.id}» يمرّر -b:v ${level.bv} و-maxrate ${level.maxrate} و-bufsize ${level.bufsize}`, { skip: SKIP }, async () => {
    const saved = await api.put(`/api/channels/${state.channelId}`, { bitrate: level.id });
    assert.equal(saved.status, 200, `رفض حفظ المستوى ${level.id}: ${saved.text}`);
    assert.equal(saved.json.channel.bitrate, level.id, 'المستوى المحفوظ يجب أن يبقى كما اختير');

    // عدد أسطر الوسائط قبل التشغيل: نطابق فقط السطر الجديد لهذه النسخة.
    const before = argsLines(await logs()).length;
    const started = await api.post(`/api/channels/${state.channelId}/start`);
    assert.equal(started.status, 200, `تعذر تشغيل القناة للمستوى ${level.id}: ${started.text}`);

    const args = await waitFor(async () => {
      return argsLines(await logs()).slice(before).find((line) => line.includes(`-b:v ${level.bv} `)) || null;
    }, 10000, 150);
    assert.ok(args, `لم تُسجَّل وسائط FFmpeg للمستوى ${level.id}. سجل الخادم:\n${srv.output()}`);

    // المعاملات الثلاثة متجاورة في الأمر بالقيم نفسها، مستقلة عن بعضها.
    assert.ok(
      args.includes(`-b:v ${level.bv} -maxrate ${level.maxrate} -bufsize ${level.bufsize}`),
      `وسائط ${level.id} لا تحمل -b:v ${level.bv} -maxrate ${level.maxrate} -bufsize ${level.bufsize}: ${args}`
    );

    // «تلقائي» يمرّ أيضاً بقرار الخادم المحسوب في السجل، لا بقيمة ثابتة.
    if (level.autoTarget) {
      const decision = await waitFor(async () => {
        return logLines(await logs()).find((line) => line.includes('جودة الفيديو التلقائية') && line.includes(`الهدف ${level.autoTarget}`)) || null;
      }, 5000, 150);
      assert.ok(decision, `الوضع التلقائي يجب أن يسجّل الهدف ${level.autoTarget}: ${srv.output()}`);
      assert.match(decision, /⇒ «متوازن»/, 'الهدف 461k يقع في مستوى «متوازن»');
    }

    const stopped = await api.post(`/api/channels/${state.channelId}/stop`);
    assert.equal(stopped.status, 200, `تعذر إيقاف القناة: ${stopped.text}`);
    const exited = await waitFor(() => aliveStubPids().length === 0, 6000);
    assert.ok(exited, 'يجب أن تخرج عملية FFmpeg البديلة قبل الاختبار التالي');
  });
}
