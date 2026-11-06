'use strict';
// واجهة موحّدة لطبقة الالتقاط (Capture Abstraction Layer) — Windows فقط.
//
// server.js يستدعي هذه الواجهة فقط، ولا يعرف أي محرك التقاط يعمل في الخلفية.
// المحرك الوحيد هو DirectShow، ويُستخدم على أي نظام تشغيل تُشغَّل عليه الأداة
// (المشروع مدعوم على Windows 10/11 فقط: dshow للفيديو والصوت، وgdigrab للشاشة).
// لا يوجد أي محرك آخر ولا قراءة لـ /dev أو /proc.

const dshow = require('./dshow');
const screen = require('./screen');

const ENGINE = dshow;
const SUPPORTED_TARGETS = [{ target: 'Windows 10/11', platform: 'win32', engine: 'dshow' }];

function supportedTargets() {
  return SUPPORTED_TARGETS.map(row => ({ ...row }));
}

function engineName() {
  return ENGINE.name;
}

function engineLabel() {
  return ENGINE.label;
}

function deviceListArgs() {
  return ENGINE.deviceListArgs();
}

function parseDeviceList(output) {
  return ENGINE.parseDeviceList(output);
}

function describeDevices(devices, err, output) {
  return ENGINE.describeDevices(devices, err, output);
}

// تعداد الأجهزة عبر FFmpeg (DirectShow). الدالة run يمرّرها server.js فتبقى
// الطبقة معزولة عن تشغيل العمليات.
async function discoverDevices(run) {
  const args = ENGINE.deviceListArgs();
  const { err, output } = await run(args);
  const devices = ENGINE.parseDeviceList(output);
  const video = (devices.video || []).map(name => ({ value: name, label: name }));
  const audio = (devices.audio || []).map(name => ({ value: name, label: name }));
  return {
    video,
    audio,
    output: output || (err ? err.message : 'لم تظهر أجهزة'),
    note: ENGINE.describeDevices(devices, err, output),
  };
}

function capabilitiesArgs(device) {
  return ENGINE.capabilitiesArgs(device);
}

function capabilitiesNote() {
  return ENGINE.capabilitiesNote();
}

function parseCapabilities(output) {
  return ENGINE.parseCapabilities(output);
}

// وسائط إدخال جهاز الالتقاط كما يبنيها المحرك.
function captureInputArgs(source) {
  return ENGINE.usbInputArgs(source);
}

function usbInputArgs(source) {
  return captureInputArgs(source);
}

function testVideoArgs(body) {
  return ENGINE.testVideoArgs(body);
}

function testAudioArgs(device) {
  return ENGINE.testAudioArgs(device);
}

function screenInputArgs(source) {
  return screen.inputArgs(source);
}

module.exports = {
  supportedTargets,
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
