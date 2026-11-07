'use strict';
/* جداول ونتائج الدوريات من واجهة worldcup26.ir المجانية (بلا مفتاح).
   الخادم هو من يتصل بالمصدر ويُنظّم الردّ ويخزّنه مؤقتاً، فلا يتصل متصفح
   المشاهد بأي طرف خارجي، ونحافظ على حدود الاستخدام العادل للواجهة. */

const https = require('https');

const API_HOST = 'worldcup26.ir';
const CACHE_MS = 2 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 12000;
const MAX_RESULTS = 12;
const MAX_UPCOMING = 12;

// الدوريات المعروضة في صفحة الجداول. دوري أبطال أوروبا غير مشمول في الواجهة
// المجانية (لا يوجد مسار له)، فيُعلَن غير متاح بدل إظهار صفحة فارغة.
const COMPETITIONS = [
  { slug: 'esp.1', name: 'الدوري الإسباني', country: 'إسبانيا' },
  { slug: 'eng.1', name: 'الدوري الإنجليزي', country: 'إنجلترا' },
  { slug: 'ksa.1', name: 'الدوري السعودي', country: 'السعودية' },
  { slug: 'uefa.champions', name: 'دوري أبطال أوروبا', country: 'أوروبا', unavailable: true }
];

const cache = new Map();

function fetchJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      host: API_HOST,
      path: pathname,
      timeout: UPSTREAM_TIMEOUT_MS,
      headers: { 'User-Agent': 'PrinceLive/8.0 (+league-tables)', Accept: 'application/json' }
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`واجهة الدوريات ردّت بالرمز ${res.statusCode}`));
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('ردّ غير صالح من واجهة الدوريات')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('انتهت مهلة الاتصال بواجهة الدوريات')));
    req.on('error', reject);
  });
}

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

async function loadCompetition(slug) {
  const comp = COMPETITIONS.find(c => c.slug === slug);
  if (!comp) return { ok: false, status: 404, error: 'دوري غير معروف' };
  if (comp.unavailable) return { ok: false, status: 503, error: 'واجهة الدوريات المجانية لا توفّر دوري أبطال أوروبا' };
  const season = new Date().getFullYear();
  const [standingsRaw, finishedRaw, scheduledRaw] = await Promise.all([
    fetchJson(`/get/soccer/${slug}/standings?season=${season}`),
    fetchJson(`/get/soccer/${slug}/fixtures?status=finished`),
    fetchJson(`/get/soccer/${slug}/fixtures?status=scheduled`)
  ]);
  const table = normalizeStandings(standingsRaw);
  const results = normalizeEvents(finishedRaw.events)
    .sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, MAX_RESULTS);
  const upcoming = normalizeEvents(scheduledRaw.events)
    .sort((a, b) => new Date(a.date) - new Date(b.date)).slice(0, MAX_UPCOMING);
  return {
    ok: true,
    competition: { slug: comp.slug, name: comp.name, country: comp.country },
    season: table.season,
    standings: table.rows,
    top: table.rows.slice(0, 2).map(row => ({ team: row.team, logo: row.logo, points: row.points, played: row.played })),
    results,
    upcoming,
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
