'use strict';
// مستويات جودة الفيديو: جدول القيم الثلاث، تحويل القيم المحفوظة، وحساب الوضع التلقائي.
const test = require('node:test');
const assert = require('node:assert');
const {
  VIDEO_BITRATE_LEVELS, bitrateKbps, normalizeVideoLevel, autoVideoLevel, resolveVideoLevel
} = require('../../lib/shared/video-levels');

test('جدول المستويات يحمل قيم -b:v و-maxrate و-bufsize المطلوبة مستقلة', () => {
  const table = VIDEO_BITRATE_LEVELS.map((level) => [level.id, level.bitrate, level.maxrate, level.bufsize]);
  assert.deepEqual(table, [
    ['auto', '', '', ''],
    // -maxrate يساوي -b:v، و-bufsize ضعفه.
    ['economy', '300k', '300k', '600k'],
    ['accepted', '400k', '400k', '800k'],
    ['balanced', '500k', '500k', '1000k'],
    ['highest', '600k', '600k', '1200k']
  ]);
});

test('normalizeVideoLevel يقبل المعرّفات والقيم القديمة ويرفض غير المعروف', () => {
  assert.equal(normalizeVideoLevel(''), 'auto');
  assert.equal(normalizeVideoLevel(null), 'auto');
  assert.equal(normalizeVideoLevel('auto'), 'auto');
  assert.equal(normalizeVideoLevel('highest'), 'highest');
  assert.equal(normalizeVideoLevel('ECONOMY'), 'economy');
  // قيم البِتريت القديمة تُطابق مستوى يحمل نفس -b:v.
  assert.equal(normalizeVideoLevel('300k'), 'economy');
  assert.equal(normalizeVideoLevel('500k'), 'balanced');
  assert.equal(normalizeVideoLevel('600k'), 'highest');
  assert.equal(normalizeVideoLevel('800k'), '');
  assert.equal(normalizeVideoLevel('fast'), '');
});

test('autoVideoLevel يحسب الهدف من الدقة وFPS ويختار أصغر مستوى يغطيه', () => {
  // 426×240×15×0.1 = 153k → اقتصادي (300k).
  assert.equal(autoVideoLevel(426, 240, 15).level.id, 'economy');
  // 640×360×15×0.1 = 346k → مقبول (400k).
  assert.equal(autoVideoLevel(640, 360, 15).level.id, 'accepted');
  // 640×360×20×0.1 = 461k → متوازن (500k).
  assert.equal(autoVideoLevel(640, 360, 20).level.id, 'balanced');
  // 640×360×25×0.1 = 576k → أعلى (600k).
  assert.equal(autoVideoLevel(640, 360, 25).level.id, 'highest');
  // 720p يتجاوز أعلى مستوى → يُستخدم «أعلى» كسقف مع تعليم التقييد.
  const clamped = autoVideoLevel(1280, 720, 25);
  assert.equal(clamped.level.id, 'highest');
  assert.equal(clamped.clamped, true);
});

test('resolveVideoLevel يمرّر قيم المستوى المختار كما هي ويحسب التلقائي', () => {
  const balanced = resolveVideoLevel('balanced', { outputWidth: 640, outputHeight: 360, outputFps: 20 });
  assert.deepEqual([balanced.level.bitrate, balanced.level.maxrate, balanced.level.bufsize], ['500k', '500k', '1000k']);
  assert.equal(balanced.autoTargetKbps, null);

  const auto = resolveVideoLevel('', { outputWidth: 640, outputHeight: 360, outputFps: 20 });
  assert.equal(auto.level.id, 'balanced');
  assert.equal(auto.autoTargetKbps, 461);
});

test('bitrateKbps يقرأ k وM ويُعيد صفراً لغير الصالح', () => {
  assert.equal(bitrateKbps('500k'), 500);
  assert.equal(bitrateKbps('2M'), 2000);
  assert.equal(bitrateKbps('96k'), 96);
  assert.equal(bitrateKbps(''), 0);
  assert.equal(bitrateKbps('fast'), 0);
});
