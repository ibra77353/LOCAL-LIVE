'use strict';
/* البرنس لايف — تبويب الجداول والنتائج
   يعرض ترتيب الدوريات ونتائجها من /api/public/football (الخادم يجلب ويخزّن). */
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  const logoImg = (logo, name) => logo
    ? `<img class="lg-logo" src="${esc(logo)}" alt="${esc(name)}" loading="lazy">`
    : '<span class="lg-logo ph" aria-hidden="true"></span>';

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
        <span class="lg-top-label">${i === 0 ? 'المتصدر' : 'الوصيف'}</span>
        <div class="lg-top-team">${logoImg(t.logo, t.team)}<strong>${esc(t.team)}</strong></div>
        <span class="lg-top-points">${esc(t.points)} نقطة · ${esc(t.played)} مباراة</span>
      </div>`).join('')}
    </div>` : '';

    const table = rows.length ? `<div class="lg-card">
      <h3 class="lg-card-title">جدول الترتيب${data.season ? ' — ' + esc(data.season) : ''}</h3>
      <div class="lg-table-wrap">
        <table class="lg-table">
          <thead><tr><th>#</th><th class="team-col">الفريق</th><th>لعب</th><th>ف</th><th>ت</th><th>خ</th><th>له</th><th>عليه</th><th>+/-</th><th>نقاط</th></tr></thead>
          <tbody>${rows.map(r => `<tr class="${r.rank <= 2 ? 'lg-row-top' : ''}">
            <td class="rank">${esc(r.rank)}</td>
            <td class="team-col">${logoImg(r.logo, r.team)}<span>${esc(r.team)}</span></td>
            <td>${esc(r.played)}</td><td>${esc(r.wins)}</td><td>${esc(r.draws)}</td><td>${esc(r.losses)}</td>
            <td>${esc(r.goalsFor)}</td><td>${esc(r.goalsAgainst)}</td>
            <td>${r.diff > 0 ? '+' + esc(r.diff) : esc(r.diff)}</td>
            <td class="pts">${esc(r.points)}</td>
          </tr>`).join('')}</tbody>
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

    return `<div class="lg-head">
        <span class="lg-comp">${esc(data.competition?.name || '')}</span>
        <span class="lg-updated">${data.stale ? 'بيانات محفوظة — تعذّر التحديث الآن' : 'آخر تحديث ' + fmtTime(data.updatedAt)}</span>
      </div>${topCards}${table}${results}${upcoming}`;
  }

  function matchRow(m, finished) {
    const score = finished
      ? `${esc(m.home.score ?? 0)} - ${esc(m.away.score ?? 0)}`
      : fmtTime(m.date);
    return `<li class="lg-match">
      <span class="lg-when">${fmtDate(m.date)}</span>
      <span class="lg-side home${m.home.winner ? ' won' : ''}">${esc(m.home.name)}${logoImg(m.home.logo, m.home.name)}</span>
      <span class="lg-score${finished ? '' : ' pending'}">${score}</span>
      <span class="lg-side away${m.away.winner ? ' won' : ''}">${logoImg(m.away.logo, m.away.name)}${esc(m.away.name)}</span>
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
