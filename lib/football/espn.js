'use strict';
/* دوري أبطال أوروبا من واجهة ESPN العامة (بلا مفتاح)، لأن المصدر الأساسي
   (worldcup26.ir) لا يوفّر مساراً لهذا الدوري.
   الترتيب من /standings، والنتائج والمباريات القادمة من /scoreboard،
   وكل شيء يبقى على الخادم ويُخزَّن مؤقتاً داخل lib/football/index.js. */

const { fetchJson } = require('./http');

const SITE_API = 'https://site.api.espn.com';
// المباريات القادمة تُعرض فقط ضمن هذه النافذة حتى لا تظهر مواعيد بعيدة جداً.
const UPCOMING_WINDOW_DAYS = 60;

function statValue(stats, name) {
  const found = (stats || []).find(x => x.name === name);
  return found ? Number(found.displayValue) || 0 : 0;
}

// في الترتيب تُعاد الأيقونات داخل logos[]، وفي المباريات داخل logo مباشرةً.
function teamLogo(team) {
  if (team?.logo) return team.logo;
  return team?.logos?.[0]?.href || '';
}

// ESPN يعيد ترتيب الدوري السويسري (League Phase) كمجموعة واحدة داخل children[0].
function normalizeStandings(raw) {
  const group = raw && raw.children && raw.children[0];
  const entries = group?.standings?.entries;
  if (!Array.isArray(entries)) return { season: '', rows: [] };
  const rows = entries.map(entry => {
    const stats = entry.stats || [];
    return {
      rank: statValue(stats, 'rank'),
      team: entry.team?.displayName || entry.team?.name || '—',
      logo: teamLogo(entry.team),
      played: statValue(stats, 'gamesPlayed'),
      wins: statValue(stats, 'wins'),
      draws: statValue(stats, 'ties'),
      losses: statValue(stats, 'losses'),
      goalsFor: statValue(stats, 'pointsFor'),
      goalsAgainst: statValue(stats, 'pointsAgainst'),
      diff: statValue(stats, 'pointDifferential'),
      points: statValue(stats, 'points')
    };
  }).sort((a, b) => (a.rank || 99) - (b.rank || 99));
  return {
    season: group?.standings?.seasonDisplayName || group?.name || '',
    rows
  };
}

function teamOf(competitor) {
  const score = competitor?.score;
  return {
    name: competitor?.team?.displayName || competitor?.team?.name || '—',
    logo: teamLogo(competitor?.team),
    score: score === '' || score == null ? null : Number(score),
    winner: competitor?.winner === true
  };
}

function normalizeEvents(list) {
  return (Array.isArray(list) ? list : []).map(event => {
    const comp = (event.competitions && event.competitions[0]) || {};
    const competitors = comp.competitors || [];
    return {
      id: String(event.id || ''),
      date: comp.date || event.date || '',
      state: comp.status?.type?.state || 'pre',
      detail: comp.status?.type?.shortDetail || comp.status?.type?.detail || '',
      home: teamOf(competitors.find(c => c.homeAway === 'home')),
      away: teamOf(competitors.find(c => c.homeAway === 'away'))
    };
  }).filter(x => x.date);
}

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

module.exports = {
  UPCOMING_WINDOW_DAYS,
  normalizeStandings,
  normalizeEvents,
  loadCompetition
};
