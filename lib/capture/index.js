'use strict';
// واجهة موحّدة لطبقة الالتقاط (Capture Abstraction Layer).
//
// server.js يستدعي هذه الواجهة فقط، ولا يعرف أي محرك التقاط يعمل في الخلفية.
// كل محرك يُسجَّل في ENGINES بمفتاح process.platform، ويوفر الواجهة نفسها:
//   deviceListArgs() / parseDeviceList(output) / describeDevices(...)
//   discover(options)                — تعداد الأجهزة (قد لا يحتاج FFmpeg)
//   capabilitiesArgs(device) / parseCapabilities(output) / capabilitiesNote()
//   inputPlan(source)                — { args, audioInputIndex }
//   usbInputArgs(source) / testVideoArgs(body) / testAudioArgs(device)
//
// المحركات الحالية:
//   win32 → dshow  (DirectShow، هو نفسه منطق الإصدار السابق بلا تغيير)
//   linux → v4l2   (Video4Linux2 للفيديو + ALSA للصوت)
// أي نظام آخر يُعامل كمحرك v4l2 لأنه POSIX، ما لم يكن Windows.
//
// إضافة محرك لنظام جديد = ملف جديد يوفّر هذه الدوال + سطر تسجيل في ENGINES،
// بلا لمس منطق القنوات أو إعادة التشغيل أو HLS.

const dshow = require('./dshow');
const v4l2 = require('./v4l2');
const screen = require('./screen');

const ENGINES = { win32: dshow, linux: v4l2 };

function engineFor(platform = process.platform) {
  return ENGINES[platform] || (platform === 'win32' ? dshow : v4l2);
}

function registeredEngines() {
  return Object.keys(ENGINES);
}

// اسم المحرك الفعلي المستخدم على نظام معيّن — للتشخيص ورسائل اللوحة.
function engineName(platform = process.platform) {
  return engineFor(platform).name;
}

function engineLabel(platform = process.platform) {
  return engineFor(platform).label;
}

function deviceListArgs(platform) {
  return engineFor(platform).deviceListArgs();
}

function parseDeviceList(output, platform) {
  return engineFor(platform).parseDeviceList(output);
}

function describeDevices(devices, err, output, platform) {
  return engineFor(platform).describeDevices(devices, err, output);
}

// تعداد الأجهزة عبر المحرك. المحركات التي لا تحتاج FFmpeg (مثل v4l2) تقرأ النظام
// مباشرة؛ أما dshow فيُنفَّذ أمر FFmpeg عبر الدالة run التي يمرّرها server.js،
// فتبقى الطبقة معزولة عن تشغيل العمليات.
async function discoverDevices(platform = process.platform, run) {
  const engine = engineFor(platform);
  if (typeof engine.discover === 'function') {
    const local = engine.discover({ platform });
    return {
      video: local.video || [],
      audio: local.audio || [],
      output: local.output || 'لم تظهر أجهزة',
      note: local.note || engine.describeDevices(local, null, local.output),
    };
  }
  const args = engine.deviceListArgs();
  const { err, output } = await run(args);
  const devices = engine.parseDeviceList(output);
  const video = (devices.video || []).map(name => ({ value: name, label: name }));
  const audio = (devices.audio || []).map(name => ({ value: name, label: name }));
  return {
    video,
    audio,
    output: output || (err ? err.message : 'لم تظهر أجهزة'),
    note: engine.describeDevices(devices, err, output),
  };
}

function capabilitiesArgs(device, platform) {
  return engineFor(platform).capabilitiesArgs(device);
}

function capabilitiesNote(platform) {
  return engineFor(platform).capabilitiesNote();
}

function parseCapabilities(output, platform) {
  return engineFor(platform).parseCapabilities(output);
}

// وسائط الإدخال مع فهرس إدخال الصوت (null يعني أن الصوت داخل الإدخال الأول).
function captureInputArgs(source, platform) {
  const engine = engineFor(platform);
  if (typeof engine.inputPlan === 'function') return engine.inputPlan(source);
  return { args: engine.usbInputArgs(source), audioInputIndex: null };
}

function usbInputArgs(source, platform) {
  return captureInputArgs(source, platform).args;
}

function testVideoArgs(body, platform) {
  return engineFor(platform).testVideoArgs(body);
}

function testAudioArgs(device, platform) {
  return engineFor(platform).testAudioArgs(device);
}

function screenInputArgs(source, platform) {
  return screen.inputArgs(source, platform);
}

module.exports = {
  engineFor,
  registeredEngines,
  engineName,
  engineLabel,
  deviceListArgs,
  parseDeviceList,
  describeDevices,
  discoverDevices,
  capabilitiesArgs,
  capabilitiesNote,
  parseCapabilities,
  captureInputArgs,
  usbInputArgs,
  testVideoArgs,
  testAudioArgs,
  screenInputArgs,
};
