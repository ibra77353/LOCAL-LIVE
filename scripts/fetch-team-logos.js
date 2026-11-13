'use strict';
/* تعبئة شعارات الأندية مقدماً.
   الخادم ينزّل شعار أي فريق جديد يظهر تلقائياً، وهذا السكربت يفعل الشيء نفسه
   لكل فرق الدوريات الحالية مرة واحدة: ينزّل ما ليس موجوداً في web/assets/teams
   ويضيفه إلى دليل lib/football/team-logos.json.

   التشغيل: node scripts/fetch-team-logos.js (أو npm run logos) */

const football = require('../lib/football');
const { LOGOS_DIR, MANIFEST_PATH, manifest, ensureLogos } = require('../lib/football/logos');

async function main() {
  const teams = [];
  for (const comp of football.COMPETITIONS) {
    try {
      const data = await football.loadCompetitionRaw(comp.slug);
      if (!data.ok) {
        console.warn(`تخطّي ${comp.name}: ${data.error || 'ردّ غير متوقع'}`);
        continue;
      }
      teams.push(...football.collectTeamLogos(data));
      console.log(`${comp.name}: ${(data.standings || []).length} فريقاً في الجدول`);
    } catch (err) {
      console.warn(`تعذّر جلب ${comp.name}: ${err.message}`);
    }
  }

  const before = Object.keys(manifest).length;
  const added = await ensureLogos(teams);
  console.log(`\nالشعارات المحلية: ${Object.keys(manifest).length} فريقاً — أُضيف ${added} الآن (كان ${before})`);
  console.log(`المجلد: ${LOGOS_DIR}`);
  console.log(`الدليل: ${MANIFEST_PATH}`);
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
