'use strict';
/* جداول ونتائج الدوريات. المصدر الأساسي worldcup26.ir (بلا مفتاح) للدوريات
   الإسباني والإنجليزي والسعودي، ودوري أبطال أوروبا من ESPN لأن المصدر
   الأساسي لا يوفّر مساراً له. الخادم هو من يتصل بالمصادر ويُنظّم الردّ
   ويخزّنه مؤقتاً، فلا يتصل متصفح المشاهد بأي طرف خارجي، ونحافظ على حدود
   الاستخدام العادل للواجهات. */

const { fetchJson } = require('./http');
const espn = require('./espn');
const { arabicTeam } = require('./teams-ar');
const { localLogo, ensureLogos } = require('./logos');

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

// مناطق كل جدول: تُرسم في الواجهة بمفتاح ألوان فوق الجدول ومؤشر بجانب كل فريق.
// up = مراكز مؤهّلة (لون --accent)، play = ملحق/مسابقة ثانية (--muted)،
// out = هبوط/خروج (--live).
const ZONES = {
  'uefa.champions': [
    { from: 1, to: 8, label: 'تأهل مباشر لدور الـ16', tone: 'up' },
    { from: 9, to: 24, label: 'الملحق التأهيلي', tone: 'play' },
    { from: 25, to: 36, label: 'خارج التأهل', tone: 'out' }
  ],
  'esp.1': [
    { from: 1, to: 4, label: 'دوري أبطال أوروبا', tone: 'up' },
    { from: 5, to: 6, label: 'الدوري الأوروبي', tone: 'play' },
    { from: 18, to: 20, label: 'الهبوط', tone: 'out' }
  ],
  'eng.1': [
    { from: 1, to: 4, label: 'دوري أبطال أوروبا', tone: 'up' },
    { from: 5, to: 6, label: 'الدوري الأوروبي', tone: 'play' },
    { from: 18, to: 20, label: 'الهبوط', tone: 'out' }
  ],
  'ksa.1': [
    { from: 1, to: 3, label: 'دوري أبطال آسيا', tone: 'up' },
    { from: 4, to: 5, label: 'كأس آسيا', tone: 'play' },
    { from: 16, to: 18, label: 'الهبوط', tone: 'out' }
  ]
};

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
// الأصلي (يبقى للاستخدام في alt والبحث) دون تغيير بنية الردّ. والشعار يُستبدل
// بنسخته المحلية من web/assets/teams إن كانت محمّلة، وإلا يبقى الخارجي.
function localizeStanding(row) {
  return { ...row, teamAr: arabicTeam(row.team), logo: localLogo(row.team, row.logo) };
}

function localizeTeam(team) {
  return { ...team, nameAr: arabicTeam(team.name), logo: localLogo(team.name, team.logo) };
}

function localizeMatch(match) {
  return { ...match, home: localizeTeam(match.home), away: localizeTeam(match.away) };
}

// البيانات كما تصل من المصادر، بلا تعريب ولا استبدال شعارات: يستخدمها
// scripts/fetch-team-logos.js لمعرفة العناوين الخارجية التي ينزّلها.
async function loadCompetitionRaw(slug) {
  const comp = COMPETITIONS.find(c => c.slug === slug);
  if (!comp) return { ok: false, status: 404, error: 'دوري غير معروف' };
  const data = comp.source === 'espn'
    ? await espn.loadCompetition(comp.slug, { results: MAX_RESULTS, upcoming: MAX_UPCOMING })
    : await loadWorldcupCompetition(comp.slug);
  return {
    ok: true,
    competition: { slug: comp.slug, name: comp.name, country: comp.country },
    season: data.season,
    standings: data.standings || [],
    results: data.results || [],
    upcoming: data.upcoming || []
  };
}

// كل فريق في الردّ (جدول أو مباراة) باسمه وشعاره، ليتولّى lib/football/logos
// تنزيل من ظهر حديثاً إلى داخل المشروع قبل عرضه.
function collectTeamLogos(data) {
  const teams = [];
  const add = (team, logo) => { if (team) teams.push({ team, logo }); };
  (data.standings || []).forEach(row => add(row.team, row.logo));
  (data.results || []).concat(data.upcoming || []).forEach(match => {
    add(match.home?.name, match.home?.logo);
    add(match.away?.name, match.away?.logo);
  });
  return teams;
}

async function loadCompetition(slug) {
  const data = await loadCompetitionRaw(slug);
  if (!data.ok) return data;
  await ensureLogos(collectTeamLogos(data));
  const standings = data.standings.map(localizeStanding);
  return {
    ...data,
    standings,
    zones: ZONES[slug] || [],
    top: standings.slice(0, 2).map(row => ({
      team: row.team, teamAr: row.teamAr, logo: row.logo, points: row.points, played: row.played
    })),
    results: data.results.map(localizeMatch),
    upcoming: data.upcoming.map(localizeMatch),
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

module.exports = { COMPETITIONS, ZONES, CACHE_MS, getCompetition, loadCompetitionRaw, collectTeamLogos };
