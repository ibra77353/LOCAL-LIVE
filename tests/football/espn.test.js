'use strict';
// اختبارات وحدة لمصدر دوري أبطال أوروبا (lib/football/espn.js):
// تحويل ترتيب ESPN ومبارياته إلى الشكل الذي تعرضه واجهة المشاهدين، بلا اتصال شبكي.
//
// التشغيل: node --test tests/football/

const test = require('node:test');
const assert = require('node:assert/strict');

const espn = require('../../lib/football/espn');
const football = require('../../lib/football');

function stat(name, displayValue) {
  return { name, displayValue };
}

test('normalizeStandings يقرأ جدول الدوري السويسري ويرتّبه حسب المركز', () => {
  const raw = {
    children: [{
      name: 'League Phase',
      standings: {
        seasonDisplayName: '2026-27 UEFA Champions League',
        entries: [
          {
            team: { displayName: 'Arsenal', logos: [{ href: 'https://logo/arsenal.png' }] },
            stats: [
              stat('rank', '1'), stat('gamesPlayed', '8'), stat('wins', '7'), stat('ties', '1'),
              stat('losses', '0'), stat('pointsFor', '20'), stat('pointsAgainst', '4'),
              stat('pointDifferential', '+16'), stat('points', '22')
            ]
          },
          {
            team: { displayName: 'Bayern Munich', logos: [{ href: 'https://logo/bayern.png' }] },
            stats: [
              stat('rank', '2'), stat('gamesPlayed', '8'), stat('wins', '6'), stat('ties', '1'),
              stat('losses', '1'), stat('pointsFor', '18'), stat('pointsAgainst', '7'),
              stat('pointDifferential', '+11'), stat('points', '19')
            ]
          }
        ]
      }
    }]
  };

  const table = espn.normalizeStandings(raw);
  assert.equal(table.season, '2026-27 UEFA Champions League');
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows[0], {
    rank: 1, team: 'Arsenal', logo: 'https://logo/arsenal.png',
    played: 8, wins: 7, draws: 1, losses: 0,
    goalsFor: 20, goalsAgainst: 4, diff: 16, points: 22
  });
  assert.equal(table.rows[1].team, 'Bayern Munich');
});

test('normalizeStandings يعيد جدولاً فارغاً عند ردّ بلا مجموعات', () => {
  const table = espn.normalizeStandings({ events: [] });
  assert.deepEqual(table, { season: '', rows: [] });
  assert.deepEqual(espn.normalizeStandings(null), { season: '', rows: [] });
});

test('normalizeEvents يحوّل مباراة منتهية وقادمة إلى الفريقين والنتيجة', () => {
  const raw = [
    {
      id: '401',
      competitions: [{
        date: '2026-11-04T20:00Z',
        status: { type: { state: 'post', shortDetail: 'FT' } },
        competitors: [
          { homeAway: 'home', score: '2', winner: false, team: { displayName: 'AEK Athens', logo: 'https://logo/aek.png' } },
          { homeAway: 'away', score: '3', winner: true, team: { displayName: 'Real Madrid', logo: 'https://logo/rm.png' } }
        ]
      }]
    },
    {
      id: '402',
      competitions: [{
        date: '2026-11-25T17:45Z',
        status: { type: { state: 'pre', shortDetail: 'Scheduled' } },
        competitors: [
          { homeAway: 'home', score: '', team: { displayName: 'Arsenal' } },
          { homeAway: 'away', score: '', team: { displayName: 'Bodo/Glimt' } }
        ]
      }]
    }
  ];

  const events = espn.normalizeEvents(raw);
  assert.equal(events.length, 2);
  assert.equal(events[0].id, '401');
  assert.equal(events[0].state, 'post');
  assert.deepEqual(events[0].home, { name: 'AEK Athens', logo: 'https://logo/aek.png', score: 2, winner: false });
  assert.deepEqual(events[0].away, { name: 'Real Madrid', logo: 'https://logo/rm.png', score: 3, winner: true });
  assert.equal(events[1].state, 'pre');
  assert.equal(events[1].home.score, null);
  assert.equal(events[1].away.winner, false);
  assert.deepEqual(espn.normalizeEvents(undefined), []);
});

test('دوري أبطال أوروبا مسجّل بمصدر ESPN وغير معلَّم كغير متاح', () => {
  const ucl = football.COMPETITIONS.find(c => c.slug === 'uefa.champions');
  assert.ok(ucl, 'دوري أبطال أوروبا يجب أن يكون ضمن الدوريات');
  assert.equal(ucl.source, 'espn');
  assert.equal(ucl.unavailable, undefined);
});
