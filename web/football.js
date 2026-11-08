'use strict';
/* البرنس لايف — تبويب الجداول والنتائج
   يعرض ترتيب الدوريات ونتائجها من /api/public/football (الخادم يجلب ويخزّن). */
(function () {
  const $ = (s) => document.querySelector(s);

  const COMPETITIONS = [
    { slug: 'esp.1', name: 'الإسباني' },
    { slug: 'eng.1', name: 'الإنجليزي' },
    { slug: 'ksa.1', name: 'السعودي' },
    { slug: 'uefa.champions', name: 'أبطال أوروبا' }
  ];
  const REFRESH_MS = 120000;
  const state = { active: 'esp.1', timer: null, cache: new Map() };

  const dateFmt = new Intl.DateTimeFormat('ar-EG', { weekday: 'short', day: 'numeric', month: 'short' });
  const timeFmt = new Intl.DateTimeFormat('ar-EG', { hour: '2-digit', minute: '2-digit', hour12: true });
  function fmtDate(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : dateFmt.format(d);
  }
  function fmtTime(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : timeFmt.format(d);
  }

  // الاسم العربي يأتي من الخادم (teamAr / nameAr)، والإنجليزي يبقى بديلاً.
  const teamName = (t) => (t && (t.nameAr || t.name)) || '—';
  const initial = (name) => (String(name || '').replace(/^ال/, '').trim().charAt(0) || '؟');

  // شعار النادي: صورة إن توفّرت، وإلا حرف من اسمه داخل دائرة.
  const logoImg = (logo, name) => logo
    ? `<img class="lg-logo" src="${esc(logo)}" alt="" loading="lazy">`
    : `<span class="lg-logo ph" aria-hidden="true">${esc(initial(name))}</span>`;

  // مناطق الجدول تصل من الخادم (دوري أبطال أوروبا): مفتاح ألوان فوق الجدول
  // وفاصل رفيع قبل بداية كل منطقة حتى يُقرأ ترتيب الستة والثلاثين فريقاً بسرعة.
  function zonesLegend(zones) {
    if (!zones.length) return '';
    return `<div class="lg-zones">${zones.map(z =>
      `<span class="lg-zone-chip tone-${esc(z.tone)}"><i></i>${esc(z.label)}</span>`).join('')}</div>`;
  }

  function zonesRows(rows, zones) {
    const zoneOf = (rank) => zones.find(z => rank >= z.from && rank <= z.to) || null;
    let prevTone = '';
    return rows.map(r => {
      const zone = zoneOf(r.rank);
      const tone = zone ? zone.tone : '';
      const start = tone && tone !== prevTone ? 'zone-start' : '';
      if (tone) prevTone = tone;
      const cls = [r.rank <= 2 ? 'lg-row-top' : '', tone ? 'zone-' + tone : '', start]
        .filter(Boolean).join(' ');
      // مؤشر ملوّن بجانب الفريق يوضّح منطقته (تأهل/ملحق/هبوط) بنفس ألوان الواجهة.
      const mark = tone ? `<i class="lg-zone-mark tone-${esc(tone)}" aria-hidden="true"></i>` : '';
      return `<tr class="${cls}">
            <td class="rank">${esc(r.rank)}</td>
            <td class="team-col">${mark}${logoImg(r.logo, r.teamAr || r.team)}<span>${esc(r.teamAr || r.team)}</span></td>
            <td>${esc(r.played)}</td><td>${esc(r.wins)}</td><td>${esc(r.draws)}</td><td>${esc(r.losses)}</td>
            <td>${esc(r.goalsFor)}</td><td>${esc(r.goalsAgainst)}</td>
            <td>${r.diff > 0 ? '+' + esc(r.diff) : esc(r.diff)}</td>
            <td class="pts">${esc(r.points)}</td>
          </tr>`;
    }).join('');
  }

  // ── تبويبات صفحة المشاهدين ──────────────────────────────────────────────
  function showStandings(on) {
    const tabBtn = $('#standingsTab');
    const channelsBtn = document.querySelector('.tab[data-tab="channels"]');
    const grid = $('#tab-channels');
    const section = $('#tab-standings');
    const player = $('#playerSection');
    if (!tabBtn || !section) return;
    tabBtn.classList.toggle('active', on);
    if (channelsBtn) channelsBtn.classList.toggle('active', !on);
    section.classList.toggle('hidden', !on);
    if (grid) grid.classList.toggle('hidden', on);
    if (on && player) player.classList.add('hidden');
    if (on) {
      loadActive();
      clearInterval(state.timer);
      state.timer = setInterval(loadActive, REFRESH_MS);
    } else {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  function renderLeagueTabs() {
    const bar = $('#leagueTabs');
    if (!bar) return;
    bar.innerHTML = COMPETITIONS.map(c =>
      `<button class="lg-tab${c.slug === state.active ? ' active' : ''}" data-comp="${esc(c.slug)}">${esc(c.name)}</button>`
    ).join('');
    bar.querySelectorAll('.lg-tab').forEach(btn => btn.addEventListener('click', () => {
      state.active = btn.dataset.comp;
      bar.querySelectorAll('.lg-tab').forEach(b => b.classList.toggle('active', b === btn));
      loadActive();
    }));
  }

  async function loadActive(force) {
    const body = $('#leagueBody');
    if (!body) return;
    const comp = COMPETITIONS.find(c => c.slug === state.active) || COMPETITIONS[0];
    const cached = state.cache.get(comp.slug);
    if (!force && cached && Date.now() - cached.at < REFRESH_MS) { body.innerHTML = cached.html; return; }
    if (!body.dataset.ready || force) body.innerHTML = '<p class="lg-note">جارٍ تحميل الجداول…</p>';
    body.dataset.ready = '1';
    try {
      const res = await fetch('/api/public/football?comp=' + encodeURIComponent(comp.slug)).then(r => r.json());
      if (!res.ok) throw new Error(res.error || 'تعذّر جلب البيانات');
      body.innerHTML = renderComp(res);
      state.cache.set(comp.slug, { at: Date.now(), html: body.innerHTML });
    } catch (e) {
      body.innerHTML = `<p class="lg-note lg-error">${esc(e.message || 'تعذّر جلب البيانات')}</p>`;
    }
  }

  function renderComp(data) {
    const rows = data.standings || [];
    const top = data.top || [];

    const topCards = top.length ? `<div class="lg-top">
      ${top.map((t, i) => `<div class="lg-top-card${i === 0 ? ' leader' : ''}">
        <span class="lg-top-rank">${i + 1}</span>
        <div class="lg-top-body">
          <span class="lg-top-label">${i === 0 ? 'المتصدر' : 'الوصيف'}</span>
          <div class="lg-top-team">${logoImg(t.logo, t.teamAr || t.team)}<strong>${esc(t.teamAr || t.team)}</strong></div>
          <span class="lg-top-points">${esc(t.points)} نقطة · ${esc(t.played)} مباراة</span>
        </div>
      </div>`).join('')}
    </div>` : '';

    const zones = data.zones || [];

    const table = rows.length ? `<div class="lg-card">
      <h3 class="lg-card-title">جدول الترتيب</h3>${zonesLegend(zones)}
      <div class="lg-table-wrap">
        <table class="lg-table">
          <thead><tr>
            <th>#</th>
            <th class="team-col">الفريق</th>
            <th title="المباريات الملعوبة">لعب</th>
            <th title="فوز">ف</th>
            <th title="تعادل">ت</th>
            <th title="خسارة">خ</th>
            <th title="أهداف له">له</th>
            <th title="أهداف عليه">عليه</th>
            <th title="فارق الأهداف">+/-</th>
            <th title="النقاط">نقاط</th>
          </tr></thead>
          <tbody>${zonesRows(rows, zones)}</tbody>
        </table>
      </div>
    </div>` : '<p class="lg-note">لم يُخزَّن جدول ترتيب لهذا الدوري بعد.</p>';

    const results = (data.results || []).length ? `<div class="lg-card">
      <h3 class="lg-card-title">آخر النتائج</h3>
      <ul class="lg-matches">${data.results.map(m => matchRow(m, true)).join('')}</ul>
    </div>` : '';

    const upcoming = (data.upcoming || []).length ? `<div class="lg-card">
      <h3 class="lg-card-title">المباريات القادمة</h3>
      <ul class="lg-matches">${data.upcoming.map(m => matchRow(m, false)).join('')}</ul>
    </div>` : '';

    const lists = (results || upcoming) ? `<div class="lg-split">${results}${upcoming}</div>` : '';

    return `<div class="lg-head">
        <div class="lg-head-main">
          <span class="lg-comp">${esc(data.competition?.name || '')}</span>
          ${data.season ? `<span class="lg-season">${esc(data.season)}</span>` : ''}
        </div>
        <span class="lg-updated${data.stale ? ' stale' : ''}">${data.stale
          ? 'بيانات محفوظة — تعذّر التحديث الآن'
          : 'آخر تحديث ' + fmtTime(data.updatedAt)}</span>
      </div>${topCards}${table}${lists}`;
  }

  function matchRow(m, finished) {
    const home = teamName(m.home);
    const away = teamName(m.away);
    const score = finished
      ? `<span class="lg-score">${esc(m.home.score ?? 0)}<i>-</i>${esc(m.away.score ?? 0)}</span>`
      : '<span class="lg-score pending">VS</span>';
    return `<li class="lg-match">
      <span class="lg-when"><b>${fmtDate(m.date)}</b><span>${finished ? 'انتهت' : fmtTime(m.date)}</span></span>
      <span class="lg-teams">
        <span class="lg-team home${m.home.winner ? ' won' : ''}"><span class="nm">${esc(home)}</span>${logoImg(m.home.logo, home)}</span>
        ${score}
        <span class="lg-team away${m.away.winner ? ' won' : ''}">${logoImg(m.away.logo, away)}<span class="nm">${esc(away)}</span></span>
      </span>
    </li>`;
  }

  async function init() {
    let enabled = true;
    try {
      const r = await fetch('/api/public/settings').then(x => x.json());
      enabled = r.settings ? r.settings.worldCupFullPage !== false : true;
    } catch (e) { enabled = true; }
    const tabBtn = $('#standingsTab');
    if (!tabBtn || !$('#tab-standings')) return;
    if (!enabled) { tabBtn.remove(); return; }
    tabBtn.classList.remove('hidden');
    tabBtn.hidden = false;
    tabBtn.addEventListener('click', () => showStandings(true));
    const channelsBtn = document.querySelector('.tab[data-tab="channels"]');
    if (channelsBtn) channelsBtn.addEventListener('click', () => showStandings(false));
    renderLeagueTabs();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
