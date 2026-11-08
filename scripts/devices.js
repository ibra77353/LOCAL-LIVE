'use strict';
// تقرير أجهزة الالتقاط — أداة تشخيص لنظام ويندوز.
//
// تُستخدم من scripts\devices.bat، وتقرأ الأجهزة عبر طبقة الالتقاط نفسها التي
// يستخدمها الخادم: DirectShow عبر FFmpeg (-list_devices). لذلك أي جهاز يظهر هنا
// هو نفسه الذي سيظهر في قائمة «جهاز الفيديو» بلوحة الإدارة.
//
// التشغيل:
//   node scripts/devices.js             ← الأجهزة + أوضاع كل جهاز فيديو
//   node scripts/devices.js --no-caps   ← الأجهزة وحدها (أسرع، بلا استدعاء FFmpeg للقدرات)
//
// رموز الخروج: 0 نجح الفحص (حتى لو لم يوجد جهاز)، 1 تعذّر الفحص نفسه
// (نظام غير مدعوم، أو FFmpeg غير قابل للتشغيل على Windows حيث التعداد يحتاجه).

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const capture = require(path.join(ROOT, 'lib', 'capture'));
const { resolveToolPath } = require(path.join(ROOT, 'lib', 'shared', 'tool-path'));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

const data = readJson('data.json') || {};
const cfg = readJson('config.json') || {};
const settings = data.settings || {};

// المسار النسبي يُبحث عنه بجانب server.js أولاً ثم في PATH (قاعدة مشتركة مع الخادم).
const FFMPEG = resolveToolPath(process.env.FFMPEG_PATH || settings.ffmpegPath || cfg.ffmpegPath || 'ffmpeg', ROOT);

function runFfmpeg(args) {
  return new Promise(resolve => {
    execFile(FFMPEG, args, { windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ err, output: `${stderr || ''}\n${stdout || ''}`.trim() }));
  });
}

const line = (text = '') => process.stdout.write(`${text}\n`);

async function main() {
  const showCaps = !process.argv.includes('--no-caps');
  line('============================================================');
  line(' PrinceLive — device report');
  line('============================================================');
  line(`Platform      : ${process.platform} (${process.arch})`);
  line(`Capture engine: ${capture.engineLabel()} [${capture.engineName()}]`);
  line(`FFmpeg        : ${FFMPEG}`);

  const version = await runFfmpeg(['-hide_banner', '-version']);
  const versionLine = String(version.output || '').split(/\r?\n/).find(x => /ffmpeg version/i.test(x));
  if (versionLine) line(`FFmpeg version: ${versionLine.trim()}`);
  else line(`FFmpeg status : NOT RUNNABLE (${version.err ? version.err.message : 'no version output'})`);

  let result;
  try {
    result = await capture.discoverDevices(runFfmpeg);
  } catch (err) {
    line('');
    line(`ERROR: ${err.message}`);
    line('Capture devices cannot be listed on this operating system.');
    process.exitCode = 1;
    return;
  }

  const video = result.video || [];
  const audio = result.audio || [];
  line('');
  line(`Video devices (${video.length}):`);
  video.forEach((device, index) => {
    const extra = device.label && device.label !== device.value ? ` [${device.value}]` : '';
    line(`  ${index + 1}. ${device.label || device.value}${extra}`);
  });
  if (!video.length) line('  (none found)');

  line(`Audio devices (${audio.length}):`);
  audio.forEach((device, index) => {
    const extra = device.label && device.label !== device.value ? ` [${device.value}]` : '';
    line(`  ${index + 1}. ${device.label || device.value}${extra}`);
  });
  if (!audio.length) line('  (none found)');

  line('');
  line(`Note: ${result.note}`);

  line('Windows: a USB capture card must appear under "Cameras" (or "Imaging devices") in Device Manager,');
  line('and Settings → Privacy → Camera → "Allow desktop apps" must be enabled for FFmpeg to see it.');

  if (showCaps && video.length) {
    for (const device of video.slice(0, 8)) {
      line('');
      line(`Modes — ${device.value}:`);
      let args;
      try {
        args = capture.capabilitiesArgs(device.value);
      } catch (err) {
        line(`  not readable: ${err.message}`);
        continue;
      }
      const { err, output } = await runFfmpeg(args);
      const caps = capture.parseCapabilities(output);
      if (!caps.videoSizes.length) {
        line(`  not readable: ${err && !output ? err.message : 'the driver reported no video modes'}`);
        continue;
      }
      line(`  sizes   : ${caps.videoSizes.slice(0, 8).join(', ')}${caps.videoSizes.length > 8 ? ' …' : ''}`);
      line(`  fps     : ${caps.frameRates.join(', ') || '—'}`);
      line(`  formats : ${caps.pixelFormats.join(', ') || '—'}`);
      const rec = caps.recommended;
      line(`  best    : ${rec.videoSize} @ ${rec.fps}fps ${rec.pixelFormat || ''}`.trimEnd());
    }
    if (video.length > 8) {
      line('');
      line(`(${video.length - 8} more device(s) were listed but not probed for modes.)`);
    }
  }

  line('');
  line('Done. The admin page reads the same list at GET /api/devices.');
}

main().catch(err => {
  line(`ERROR: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
