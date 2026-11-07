'use strict';
/* شعارات الأندية محليّة داخل المشروع: يحمّلها scripts/fetch-team-logos.js مرة
   واحدة إلى web/assets/teams ويعيد كتابة دليلها في team-logos.json، ثم يقرأ
   الخادم الدليل هنا فيقدّم مساراً داخلياً (/assets/teams/...) بدل عنوان خارجي.
   أي فريق غير موجود في الدليل يبقى على شعاره الخارجي، فلا تنكسر الواجهة. */

const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.join(__dirname, 'team-logos.json');

// حروف لا يفكّها NFD إلى حرف + علامة، فتُستبدل يدوياً حتى لا يعتمد المفتاح على
// طريقة كتابة المصدر (Bodø/Glimt مقابل Bodo/Glimt).
const LETTERS = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', đ: 'd', ð: 'd', ł: 'l', þ: 'th' };

// توحيد الاسم للمقارنة بين المصادر: «Atlético Madrid» و«Atletico Madrid» و
// «ATLÉTICO MADRID» كلها مفتاح واحد.
function normalizeTeamName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[øæœßđðłþ]/gi, c => LETTERS[c.toLowerCase()] || c)
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function readManifest() {
  try {
    const raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

const manifest = readManifest();

// المسار المحلي إن وُجد، وإلا الشعار الخارجي كما وصل من المصدر.
function localLogo(team, remote) {
  return manifest[normalizeTeamName(team)] || remote || '';
}

module.exports = { MANIFEST_PATH, manifest, normalizeTeamName, localLogo };
