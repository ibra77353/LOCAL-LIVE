'use strict';
// واجهة موحّدة لطبقة الالتقاط (Capture Abstraction Layer).
//
// server.js يستدعي هذه الواجهة فقط، ولا يعرف أي محرك التقاط يعمل في الخلفية.
// كل محرك يُسجَّل في ENGINES بمفتاح process.platform، ويوفر الواجهة نفسها:
//   deviceListArgs() / parseDeviceList(output) / describeDevices(...)
//   capabilitiesArgs(device) / parseCapabilities(output)
//   usbInputArgs(source) / testVideoArgs(body) / testAudioArgs(device)
//
// المرحلة الأولى: المحرك الوحيد هو DirectShow (Windows). أي نظام آخر يعود إليه
// عمداً حتى يبقى السلوك مطابقاً للأصل (نفس وسائط dshow ونفس رسائل FFmpeg).
// إضافة محرك Linux (V4L2/ALSA) مستقبلاً = ملف جديد + سطر تسجيل هنا، بلا لمس
// منطق القنوات أو إعادة التشغيل أو HLS.

const dshow = require('./dshow');
const screen = require('./screen');

const ENGINES = { win32: dshow };
const DEFAULT_ENGINE = dshow;

function engineFor(platform = process.platform) {
  return ENGINES[platform] || DEFAULT_ENGINE;
}

function registeredEngines() {
  return Object.keys(ENGINES);
}

// اسم المحرك الفعلي المستخدم على نظام معيّن — للتشخيص ورسائل اللوحة.
function engineName(platform = process.platform) {
  return engineFor(platform).name;
}

function deviceListArgs(platform) {
  return engineFor(platform).deviceListArgs();
}

function parseDeviceList(output) {
  return engineFor().parseDeviceList(output);
}

function describeDevices(devices, err, output) {
  return engineFor().describeDevices(devices, err, output);
}

function capabilitiesArgs(device, platform) {
  return engineFor(platform).capabilitiesArgs(device);
}

function parseCapabilities(output) {
  return engineFor().parseCapabilities(output);
}

function usbInputArgs(source, platform) {
  return engineFor(platform).usbInputArgs(source);
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
  deviceListArgs,
  parseDeviceList,
  describeDevices,
  capabilitiesArgs,
  parseCapabilities,
  usbInputArgs,
  testVideoArgs,
  testAudioArgs,
  screenInputArgs,
};
