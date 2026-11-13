'use strict';
// يشغّل نسخة معزولة من الخادم لتنفيذ اختبارات HTTP:
// يُنسخ كود المشروع إلى مجلد مؤقت، ويُكتب config.json و data.json خاصان بالاختبار،
// ثم يُشغّل server.js على منفذ منفصل. بهذا لا تُمسّ بيانات المستخدم ولا جلسة لوحته.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

const TEST_USER = 'admin';
const TEST_PASS = 'pl-test-pass-1234';
const TEST_SALT = 'b4d1c9a7e3f2058d6c1a9b8e7d6c5b4a';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function testAdminBlock() {
  const hash = crypto.scryptSync(TEST_PASS, TEST_SALT, 32).toString('hex');
  return { user: TEST_USER, salt: TEST_SALT, hash };
}

function writeConfig(dir) {
  const config = { host: '127.0.0.1', hlsRoot: 'srv/hls', admin: testAdminBlock() };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
}

// بيانات اختبار فارغة: لا مصادر ولا قنوات، وإعادة التشغيل التلقائي معطّلة حتى
// لا تُلوّث سجلات الاختبار بمحاولات إعادة تشغيل FFmpeg على بيئة بلا جهاز التقاط.
function writeData(dir, port, options = {}) {
  const data = {
    settings: {
      port,
      nginxPort: 80,
      autoRestartCrashed: false,
      idleStopEnabled: false,
      startupQueueDelayMs: 0,
      hideCosmeticLogs: false,
      // يمكن استبداله ببديل قابل للتنفيذ (اختبارات التشغيل) بدل FFmpeg الحقيقي.
      ffmpegPath: options.ffmpegPath || 'ffmpeg',
      ffprobePath: 'ffprobe',
      x264Preset: 'veryfast',
      x264Threads: 2,
    },
    sources: [],
    channels: [],
  };
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function waitForReady(baseUrl, getOutput, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response yet';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl + '/api/status', { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err.message;
    }
    await sleep(150);
  }
  throw new Error(`الخادم لم يستجب خلال ${timeoutMs}ms (${lastError}).\n--- output ---\n${getOutput()}`);
}

async function startTestServer(options = {}) {
  const port = Number(options.port) || 3901;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-http-'));

  for (const entry of ['server.js', 'package.json']) {
    fs.copyFileSync(path.join(ROOT, entry), path.join(dir, entry));
  }
  // web/ للصفحات الثابتة، وlib/ لطبقة الالتقاط والوحدات المشتركة التي يستوردها server.js.
  for (const entry of ['web', 'lib']) {
    fs.cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
  }
  writeConfig(dir);
  writeData(dir, port, options);

  const logsDir = path.join(dir, 'logs');
  const hlsDir = path.join(dir, 'hls');
  const uploadsDir = path.join(dir, 'srv', 'uploads');
  // سجلات Nginx معزولة داخل مجلد الاختبار: بلا هذا العزل يقرأ الخادم سجلّ
  // التشغيل الحقيقي (NGINX_LOG_DIR من البيئة) فتتلوّث أرقام الاختبار.
  const nginxLogsDir = path.join(dir, 'nginx', 'logs');
  for (const folder of [logsDir, hlsDir, uploadsDir, nginxLogsDir]) fs.mkdirSync(folder, { recursive: true });

  const env = Object.assign({}, process.env, {
    PORT: String(port),
    HOST: '127.0.0.1',
    LOG_DIR: logsDir,
    HLS_ROOT: hlsDir,
    UPLOADS_ROOT: uploadsDir,
    DATA_FILE: path.join(dir, 'data.json'),
    NGINX_LOG_DIR: nginxLogsDir,
  });

  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForReady(baseUrl, () => output);
  } catch (err) {
    try { child.kill('SIGKILL'); } catch {}
    throw err;
  }

  return {
    dir,
    port,
    baseUrl,
    user: TEST_USER,
    pass: TEST_PASS,
    output: () => output,
    async stop() {
      try { child.kill('SIGTERM'); } catch {}
      await Promise.race([exited, sleep(5000)]);
      try { child.kill('SIGKILL'); } catch {}
      if (!options.keepDir) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    },
  };
}

module.exports = { startTestServer, ROOT, TEST_USER, TEST_PASS };
