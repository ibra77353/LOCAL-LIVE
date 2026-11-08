'use strict';
/* مطبّعات موحّدة لبيانات الدوريات بشكل ESPN، مشتركة بين:
   - lib/football/espn.js لدوري أبطال أوروبا.
   - lib/football/index.js لمصدر worldcup26.ir الذي يعيد الشكل نفسه.
   مكان واحد يمنع اختلاف تحويل الجدول والمباريات بين المصدرين. */

function statValue(stats, name) {
  const found = (stats || []).find(x => x.name === name);
  return found ? Number(found.displayValue) || 0 : 0;
}

// في الترتيب تُعاد الأيقونات داخل logos[]، وفي المباريات داخل logo مباشرةً.
function teamLogo(team) {
  if (team?.logo) return team.logo;
  return team?.logos?.[0]?.href || '';
}

// ESPN يعيد ترتيب دوري الأبطال (League Phase) كمجموعة واحدة داخل children[0].
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

module.exports = { normalizeStandings, normalizeEvents };
