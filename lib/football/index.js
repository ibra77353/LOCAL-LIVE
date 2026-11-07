'use strict';
/* جداول ونتائج الدوريات. المصدر الأساسي worldcup26.ir (بلا مفتاح) للدوريات
   الإسباني والإنجليزي والسعودي، ودوري أبطال أوروبا من ESPN لأن المصدر
   الأساسي لا يوفّر مساراً له. الخادم هو من يتصل بالمصادر ويُنظّم الردّ
   ويخزّنه مؤقتاً، فلا يتصل متصفح المشاهد بأي طرف خارجي، ونحافظ على حدود
   الاستخدام العادل للواجهات. */

const { fetchJson } = require('./http');
const espn = require('./espn');
const { arabicTeam } = require('./teams-ar');

const API_BASE = 'https://worldcup26.ir';
const CACHE_MS = 2 * 60 * 1000;
const MAX_RESULTS = 12;
const MAX_UPCOMING = 12;

// الدوريات المعروضة في صفحة الجداول. عند إضافة دوري جديد: أضفه هنا وفي
// web/football.js، واختر مصدره (worldcup26 أو espn).
const COMPETITIONS = [
  { slug: 'esp.1', name: 'الدوري الإسباني', country: 'إسبانيا' },
  { slug: 'eng.1', name: 'الدوري الإنجليزي', country: 'إنجلترا' },
  { slug: 'ksa.1', name: 'الدوري السعودي', country: 'السعودية' },
  { slug: 'uefa.champions', name: 'دوري أبطال أوروبا', country: 'أوروبا', source: 'espn' }
];

const cache = new Map();

function statValue(stats, name) {
  const found = (stats || []).find(x => x.name === name);
  return found ? Number(found.displayValue) || 0 : 0;
}

function normalizeStandings(raw) {
  const group = raw && raw.children && raw.children[0];
  const entries = group && group.standings && group.standings.entries;
  if (!Array.isArray(entries)) return { season: '', rows: [] };
  const rows = entries.map(entry => {
    const stats = entry.stats || [];
    return {
      rank: statValue(stats, 'rank'),
      team: entry.team?.displayName || entry.team?.name || '—',
      logo: entry.team?.logo || '',
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
  return { season: group?.name || '', rows };
}

function teamOf(competitor) {
  return {
    name: competitor?.team?.displayName || competitor?.team?.name || '—',
    logo: competitor?.team?.logo || '',
    score: competitor?.score === '' || competitor?.score == null ? null : Number(competitor.score),
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

async function loadWorldcupCompetition(slug) {
  const season = new Date().getFullYear();
  const [standingsRaw, finishedRaw, scheduledRaw] = await Promise.all([
    fetchJson(`${API_BASE}/get/soccer/${slug}/standings?season=${season}`),
    fetchJson(`${API_BASE}/get/soccer/${slug}/fixtures?status=finished`),
    fetchJson(`${API_BASE}/get/soccer/${slug}/fixtures?status=scheduled`)
  ]);
  const table = normalizeStandings(standingsRaw);
  const results = normalizeEvents(finishedRaw.events)
    .sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, MAX_RESULTS);
  const upcoming = normalizeEvents(scheduledRaw.events)
    .sort((a, b) => new Date(a.date) - new Date(b.date)).slice(0, MAX_UPCOMING);
  return { season: table.season, standings: table.rows, results, upcoming };
}

// الأسماء الإنجليزية تصل من المصادر، والواجهة عربية: نضيف الاسم العربي بجانب
// الأصلي (يبقى للاستخدام في alt والبحث) دون تغيير بنية الردّ.
function localizeStanding(row) {
  return { ...row, teamAr: arabicTeam(row.team) };
}

function localizeMatch(match) {
  return {
    ...match,
    home: { ...match.home, nameAr: arabicTeam(match.home.name) },
    away: { ...match.away, nameAr: arabicTeam(match.away.name) }
  };
}

async function loadCompetition(slug) {
  const comp = COMPETITIONS.find(c => c.slug === slug);
  if (!comp) return { ok: false, status: 404, error: 'دوري غير معروف' };
  const data = comp.source === 'espn'
    ? await espn.loadCompetition(comp.slug, { results: MAX_RESULTS, upcoming: MAX_UPCOMING })
    : await loadWorldcupCompetition(comp.slug);
  const standings = (data.standings || []).map(localizeStanding);
  return {
    ok: true,
    competition: { slug: comp.slug, name: comp.name, country: comp.country },
    season: data.season,
    standings,
    top: standings.slice(0, 2).map(row => ({
      team: row.team, teamAr: row.teamAr, logo: row.logo, points: row.points, played: row.played
    })),
    results: (data.results || []).map(localizeMatch),
    upcoming: (data.upcoming || []).map(localizeMatch),
    updatedAt: new Date().toISOString()
  };
}

// بيانات مخزّنة مؤقتاً لدقيقتين: طلبات كثيرة من المشاهدين تتحوّل إلى طلب واحد
// للمصدر، وعند تعذّر الاتصال تُقدَّم آخر نسخة ناجحة بدل خطأ فارغ.
async function getCompetition(slug) {
  const cached = cache.get(slug);
  if (cached && Date.now() - cached.at < CACHE_MS) return { ...cached.data, cached: true };
  try {
    const result = await loadCompetition(slug);
    if (result.ok) cache.set(slug, { at: Date.now(), data: result });
    return result;
  } catch (err) {
    if (cached) return { ...cached.data, cached: true, stale: true };
    return { ok: false, status: 502, error: err.message || 'تعذّر جلب بيانات الدوريات' };
  }
}

module.exports = { COMPETITIONS, CACHE_MS, getCompetition };
