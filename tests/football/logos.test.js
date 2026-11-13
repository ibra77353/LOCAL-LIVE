'use strict';
// اختبارات شعارات الأندية المحلية (lib/football/logos.js): توحيد أسماء الفرق،
// ووجود كل ملف في الدليل داخل web/assets/teams، والرجوع للشعار الخارجي عند
// غياب النسخة المحلية. بلا اتصال شبكي.
//
// التشغيل: node --test tests/football/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { manifest, normalizeTeamName, localLogo, fileName, ensureLogos } = require('../../lib/football/logos');

const WEB_DIR = path.join(__dirname, '..', '..', 'web');

test('normalizeTeamName يوحّد الاسم للمقارنة بين المصادر', () => {
  assert.equal(normalizeTeamName('Atlético Madrid'), 'atletico madrid');
  assert.equal(normalizeTeamName('Bodø/Glimt'), 'bodo glimt');
  assert.equal(normalizeTeamName('Paris Saint-Germain'), 'paris saint germain');
  assert.equal(normalizeTeamName('Brighton & Hove Albion'), 'brighton and hove albion');
  assert.equal(normalizeTeamName('  '), '');
  assert.equal(normalizeTeamName(null), '');
});

test('كل شعار في الدليل ملف موجود داخل المشروع', () => {
  const keys = Object.keys(manifest);
  assert.ok(keys.length > 0, 'دليل الشعارات يجب أن يحتوي فرقاً');
  for (const key of keys) {
    const rel = manifest[key];
    assert.match(rel, /^\/assets\/teams\/[a-z0-9-]+\.(png|webp|jpe?g|svg)$/);
    const file = path.join(WEB_DIR, rel.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), `ملف شعار مفقود: ${rel}`);
  }
});

test('localLogo يفضّل النسخة المحلية ويعود للشعار الخارجي للمجهول', () => {
  assert.equal(localLogo('Real Madrid', 'https://logo/rm.png'), '/assets/teams/real-madrid.png');
  assert.equal(localLogo('فريق بلا شعار محلي', 'https://logo/x.png'), 'https://logo/x.png');
  assert.equal(localLogo('فريق بلا شعار محلي', ''), '');
});

test('fileName يبني اسم ملف ثابتاً من اسم الفريق', () => {
  assert.equal(fileName('real madrid', 'https://a.espncdn.com/i/teamlogos/soccer/500/86.png'), 'real-madrid.png');
  assert.equal(fileName('real madrid', 'https://example.com/logo'), 'real-madrid.png');
  assert.equal(fileName('al hilal', 'https://example.com/x.webp'), 'al-hilal.webp');
});

test('ensureLogos لا ينزّل شيئاً لفرق لها شعار محلي أو بلا رابط خارجي', async () => {
  assert.equal(await ensureLogos([]), 0);
  assert.equal(await ensureLogos([{ team: 'Real Madrid', logo: 'https://logo/rm.png' }]), 0);
  assert.equal(await ensureLogos([{ team: 'فريق بلا رابط', logo: '' }]), 0);
});
