'use strict';
/* دوري أبطال أوروبا من واجهة ESPN العامة (بلا مفتاح)، لأن المصدر الأساسي
   (worldcup26.ir) لا يوفّر مساراً لهذا الدوري.
   الترتيب من /standings، والنتائج والمباريات القادمة من /scoreboard،
   وكل شيء يبقى على الخادم ويُخزَّن مؤقتاً داخل lib/football/index.js. */

const { fetchJson } = require('./http');
const { normalizeStandings, normalizeEvents } = require('./normalize');

const SITE_API = 'https://site.api.espn.com';
// المباريات القادمة تُعرض فقط ضمن هذه النافذة حتى لا تظهر مواعيد بعيدة جداً.
const UPCOMING_WINDOW_DAYS = 60;

// واجهة ESPN لا تدعم نطاقات تواريخ لهذه البطولة، لكن ?dates=<السنة> يعيد
// مباريات السنة كاملة (الماضية والقادمة) في طلب واحد.
async function loadYear(slug, year) {
  const raw = await fetchJson(`${SITE_API}/apis/site/v2/sports/soccer/${encodeURIComponent(slug)}/scoreboard?dates=${year}&limit=300`);
  return normalizeEvents(raw.events);
}

async function loadCompetition(slug, limits) {
  const year = new Date().getFullYear();
  const [standingsRaw, thisYear, nextYear] = await Promise.all([
    fetchJson(`${SITE_API}/apis/v2/sports/soccer/${encodeURIComponent(slug)}/standings`),
    loadYear(slug, year),
    loadYear(slug, year + 1)
  ]);
  const table = normalizeStandings(standingsRaw);
  const all = thisYear.concat(nextYear);
  const horizon = Date.now() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const results = all.filter(e => e.state === 'post')
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, limits.results);
  const upcoming = all.filter(e => e.state !== 'post' && new Date(e.date).getTime() <= horizon)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(0, limits.upcoming);
  return { season: table.season, standings: table.rows, results, upcoming };
}

module.exports = { normalizeStandings, normalizeEvents, loadCompetition };
