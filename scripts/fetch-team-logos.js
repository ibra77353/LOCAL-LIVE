'use strict';
/* تحميل شعارات الأندية إلى المشروع.
   يمرّ على كل دوري في lib/football، يجمع أسماء الفرق وعناوين شعاراتها من
   المصادر، ينزّل كل شعار مرة واحدة إلى web/assets/teams، ثم يعيد كتابة دليل
   الأسماء في lib/football/team-logos.json ليقدّمه الخادم من داخل المشروع.

   التشغيل: node scripts/fetch-team-logos.js [--force]
   (--force يعيد تنزيل الشعارات الموجودة أصلاً.) */

const fs = require('fs');
const path = require('path');

const football = require('../lib/football');
const { normalizeTeamName } = require('../lib/football/logos');
const { MANIFEST_PATH } = require('../lib/football/logos');

const ROOT = path.join(__dirname, '..');
const LOGOS_DIR = path.join(ROOT, 'web', 'assets', 'teams');
const PUBLIC_BASE = '/assets/teams';
const TIMEOUT_MS = 20000;
const FORCE = process.argv.includes('--force');

const IMAGE_EXT = new Set(['.png', '.webp', '.jpg', '.jpeg', '.svg']);

function extOf(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return IMAGE_EXT.has(ext) ? ext : '.png';
  } catch {
    return '.png';
  }
}

function fileName(key, url) {
  const slug = key.replace(/\s+/g, '-') || 'team';
  return slug + extOf(url);
}

async function download(url, dest) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
      Accept: 'image/*'
    },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('ملف فارغ');
  fs.writeFileSync(dest, buf);
  return buf.length;
}

// نجمع الفرق من الترتيب والنتائج والمباريات القادمة: الأولوية للشعار الأول
// الذي يصل، والاسم الموحّد يمنع تنزيل شعار النادي مرتين.
function collectTeams(data, teams) {
  const add = (team, logo) => {
    if (!team || !logo || !/^https?:/i.test(logo)) return;
    const key = normalizeTeamName(team);
    if (!key || teams.has(key)) return;
    teams.set(key, { team, logo });
  };
  (data.standings || []).forEach(row => add(row.team, row.logo));
  (data.results || []).concat(data.upcoming || []).forEach(match => {
    add(match.home?.name, match.home?.logo);
    add(match.away?.name, match.away?.logo);
  });
}

async function main() {
  const teams = new Map();
  for (const comp of football.COMPETITIONS) {
    try {
      const data = await football.loadCompetitionRaw(comp.slug);
      if (!data.ok) {
        console.warn(`تخطّي ${comp.name}: ${data.error || 'ردّ غير متوقع'}`);
        continue;
      }
      collectTeams(data, teams);
      console.log(`${comp.name}: ${(data.standings || []).length} فريقاً في الجدول`);
    } catch (err) {
      console.warn(`تعذّر جلب ${comp.name}: ${err.message}`);
    }
  }

  fs.mkdirSync(LOGOS_DIR, { recursive: true });
  const manifest = {};
  let downloaded = 0;
  let kept = 0;
  let failed = 0;

  for (const [key, team] of teams) {
    const file = fileName(key, team.logo);
    const dest = path.join(LOGOS_DIR, file);
    const publicPath = `${PUBLIC_BASE}/${file}`;

    if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      manifest[key] = publicPath;
      kept++;
      continue;
    }
    try {
      const size = await download(team.logo, dest);
      manifest[key] = publicPath;
      downloaded++;
      console.log(`✓ ${team.team} (${Math.round(size / 1024)}KB)`);
    } catch (err) {
      failed++;
      console.warn(`✗ ${team.team}: ${err.message}`);
    }
  }

  const ordered = {};
  Object.keys(manifest).sort().forEach(key => { ordered[key] = manifest[key]; });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(ordered, null, 2) + '\n');

  console.log(`\nالشعارات: ${Object.keys(ordered).length} فريقاً محلياً — تنزيل ${downloaded}، موجود ${kept}، فشل ${failed}`);
  console.log(`الدليل: ${path.relative(ROOT, MANIFEST_PATH)}`);
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
