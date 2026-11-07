'use strict';
// اختبارات وحدة لقاموس أسماء الأندية العربية (lib/football/teams-ar.js).
//
// التشغيل: node --test tests/football/

const test = require('node:test');
const assert = require('node:assert/strict');

const { arabicTeam, normalizeName } = require('../../lib/football/teams-ar');

test('arabicTeam يعيد الاسم العربي للأندية المعروفة', () => {
  assert.equal(arabicTeam('Barcelona'), 'برشلونة');
  assert.equal(arabicTeam('Atlético Madrid'), 'أتلتيكو مدريد');
  assert.equal(arabicTeam('Manchester United'), 'مانشستر يونايتد');
  assert.equal(arabicTeam('Al Hilal'), 'الهلال');
  assert.equal(arabicTeam('Paris Saint-Germain'), 'باريس سان جيرمان');
  assert.equal(arabicTeam('Brighton & Hove Albion'), 'برايتون');
});

test('arabicTeam يتجاهل الحالة والمسافات الزائدة', () => {
  assert.equal(arabicTeam('  real madrid '), 'ريال مدريد');
  assert.equal(arabicTeam('RB LEIPZIG'), 'لايبزيغ');
});

test('arabicTeam يترك الاسم الأصلي عند غياب الترجمة أو وجوده بالعربية', () => {
  assert.equal(arabicTeam('Some Unknown FC'), 'Some Unknown FC');
  assert.equal(arabicTeam('برشلونة'), 'برشلونة');
  assert.equal(arabicTeam(''), '');
  assert.equal(arabicTeam(null), '');
});

test('normalizeName يوحّد الحركات والرموز', () => {
  assert.equal(normalizeName('Bodo/Glimt'), 'bodo glimt');
  assert.equal(normalizeName("Nîmes  Olympique"), 'nimes olympique');
});
