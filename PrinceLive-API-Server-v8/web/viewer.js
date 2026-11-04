'use strict';
/* أمان لايف — مشغّل المشاهدين */

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let SETTINGS = {};
let CHANNELS = [];
let hls = null;
let currentChannel = null;
let activeCategory = '';
let cpuSaver = false;
const clientId = (localStorage.getItem('amaan_cid') ||
  (localStorage.setItem('amaan_cid', 'c' + Math.random().toString(36).slice(2)), localStorage.getItem('amaan_cid')));

// ---------------- bootstrap ----------------
async function init() {
  const s = await fetch('/api/public/settings').then(r => r.json());
  SETTINGS = s.settings || {};
  document.title = SETTINGS.siteName + ' — البث المباشر';
  $('#siteTitle').textContent = SETTINGS.siteName || 'أمان لايف';
  // الفوتر ثابت في HTML (أمان تيليكوم) — لا يُحقن من الإعدادات
  if (SETTINGS.phone) { $('#sitePhone').textContent = SETTINGS.phone; $('#sitePhone').href = 'tel:' + SETTINGS.phone; }
  if (SETTINGS.logo) {
    const l = $('#siteLogo');
    l.src = '/' + SETTINGS.logo.replace(/^\//, '').replace(/^srv\/uploads/, 'uploads');
    l.classList.remove('hidden');
  }
  // الثيم يُطبَّق كصنف على body — viewer.css يعرّف body.worldcup فوق متغيرات :root.
  document.body.classList.toggle('worldcup', SETTINGS.theme === 'worldcup');
  cpuSaver = !!SETTINGS.cpuSaverDefault || localStorage.getItem('amaan_cpu') === '1';
  $('#cpuSaver').checked = cpuSaver;

  await loadChannels();
  setInterval(loadChannels, 30000);
  setInterval(heartbeat, 15000);
}

async function loadChannels() {
  const r = await fetch('/api/public/channels').then(x => x.json());
  CHANNELS = r.channels || [];
  renderCats();
  renderGrid();
}

function renderCats() {
  const cats = [...new Set(CHANNELS.map(c => c.category).filter(Boolean))];
  const box = $('#catFilters');
  if (!cats.length) { box.innerHTML = ''; return; }
  const btn = (val, label) =>
    `<button class="cat-btn ${activeCategory === val ? 'active' : ''}" data-cat="${esc(val)}">${esc(label)}</button>`;
  box.innerHTML = btn('', 'الكل') + cats.map(c => btn(c, c)).join('');
  box.querySelectorAll('.cat-btn').forEach(b =>
    b.onclick = () => { activeCategory = b.dataset.cat; renderCats(); renderGrid(); });
}

function renderGrid() {
  const list = CHANNELS.filter(c => !activeCategory || c.category === activeCategory);
  $('#emptyMsg').classList.toggle('hidden', list.length > 0);
  $('#channelGrid').innerHTML = list.map(c => {
    return `
    <div class="card" tabindex="0" role="button" data-id="${c.id}" aria-label="تشغيل ${esc(c.name)}">
      ${c.cover
        ? `<img class="card-cover" loading="lazy" src="${/^https?:\/\//.test(c.cover) ? esc(c.cover) : '/' + esc(c.cover.replace(/^srv\/uploads/, 'uploads'))}" alt="">`
        : `<div class="card-cover ph">📺</div>`}
      <div class="card-body">
        <p class="card-name">${esc(c.name)}</p>
        <div class="card-meta">
          <span>${esc(c.category || '')}</span>
          ${c.live ? '<span class="badge-live">مباشر</span>' : '<span class="badge-off">متوقفة</span>'}
        </div>
      </div>
    </div>`;
  }).join('');
  document.querySelectorAll('.card').forEach(el => {
    const open = () => playChannel(el.dataset.id);
    el.onclick = open;
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  });
}

// ---------------- player ----------------
function hlsConfig() {
  const base = {
    maxBufferLength: Number(SETTINGS.playerMaxBufferLength || 20),
    backBufferLength: Number(SETTINGS.playerBackBufferLength || 10),
    liveSyncDuration: Number(SETTINGS.playerLiveSyncDuration || 4),
    capLevelToPlayerSize: !!SETTINGS.capLevelToPlayerSize,
    // تسريع بدء البث: ابدأ قرب الحافة الحية ولا تنتظر بفراً كبيراً
    maxMaxBufferLength: 30,
    liveDurationInfinity: true,
    // تحميل أسرع للقوائم والمقاطع عند الإقلاع
    manifestLoadingMaxRetry: 6,
    manifestLoadingRetryDelay: 500,
    levelLoadingMaxRetry: 6,
    levelLoadingRetryDelay: 500,
    fragLoadingMaxRetry: 6,
    fragLoadingRetryDelay: 500,
    startFragPrefetch: true,
    enableWorker: true,
    lowLatencyMode: false
  };
  if (cpuSaver) {
    // وضع توفير المعالج: بفر أصغر + إجبار الجودة على حجم المشغّل + بدء بأدنى جودة
    base.maxBufferLength = Math.min(base.maxBufferLength, 12);
    base.backBufferLength = 0;
    base.capLevelToPlayerSize = true;
    base.startLevel = 0;
  }
  return base;
}

function ensurePlayer() {
  $('#playerSection').classList.remove('hidden');
  const video = $('#video');
  if (!video._loadingWired) {
    video._loadingWired = true;
    // إخفاء شاشة التجهيز فور بدء العرض الفعلي، وإظهارها عند التوقف للتخزين
    video.addEventListener('playing', hideLoading);
    video.addEventListener('canplay', hideLoading);
    video.addEventListener('waiting', showLoading);
    video.addEventListener('stalled', showLoading);
  }
  if (window.Hls && Hls.isSupported()) {
    if (!hls) {
      hls = new Hls(hlsConfig());
      hls.attachMedia(video);
      wireHlsEvents();
    }
    return 'hls';
  }
  return 'native'; // Safari iOS
}

let stallCount = 0;
let manifestRetryTimer = null;
let manifestRetryCount = 0;
const PREP_SLOW_AFTER = 30;     // بعد ~60ث (30×2ث) من التجهيز نتمهّل ونعرض رسالة صريحة
let prepWatchdog = null;        // مؤقّت "زمن أول عرض": يحوّل الدوّارة اللانهائية لرسالة واضحة
const PREP_WATCHDOG_MS = 60000; // إن لم يبدأ العرض خلال دقيقة نُعلم المستخدم (مع مواصلة المحاولة)
function showLoading() { const el = document.getElementById('playerLoading'); if (el) el.classList.remove('hidden'); }
function hideLoading() {
  const el = document.getElementById('playerLoading'); if (el) el.classList.add('hidden');
  // بدأ العرض فعلياً → ألغِ مراقب التجهيز وصفّر العدّاد ورسالة الانتظار
  clearTimeout(prepWatchdog); prepWatchdog = null;
  manifestRetryCount = 0;
}
// يفحص حالة القناة من الخادم أثناء التجهيز: لو المصدر محظور/معطّل، يعرض رسالة
// دقيقة فوراً بدل انتظار طويل. يُستدعى دورياً أثناء إعادة محاولات التجهيز.
async function checkChannelHealth(channelId) {
  if (!channelId) return;
  try {
    const r = await fetch('/api/public/channel-health?id=' + encodeURIComponent(channelId));
    if (!r.ok) return;
    const d = await r.json();
    const msgs = {
      blocked: 'المصدر يحظر الاتصال حالياً. حاول لاحقاً أو اختر قناة أخرى.',
      error: 'تعذّر بثّ هذه القناة (المصدر غير متاح أو الرابط منتهٍ). جرّب قناة أخرى.'
    };
    if (d.status && msgs[d.status]) {
      clearTimeout(manifestRetryTimer); clearTimeout(prepWatchdog); prepWatchdog = null;
      manifestRetryCount = 0;
      hideLoading();
      showMsg(msgs[d.status]);
    }
  } catch (e) { /* تجاهل — تستمر المحاولة العادية */ }
}
// تُستدعى عند بدء تجهيز قناة: تُسلّح مراقباً يعرض رسالة صريحة إن طال التجهيز
// بدل ترك "جاري تجهيز القناة" تدور بلا نهاية حين يكون المصدر بطيئاً أو لا يستجيب.
function armPrepWatchdog() {
  clearTimeout(prepWatchdog);
  prepWatchdog = setTimeout(() => {
    showMsg('القناة قيد التجهيز والمصدر بطيء الاستجابة… نواصل المحاولة تلقائياً');
  }, PREP_WATCHDOG_MS);
}
// إعادة تحميل المصدر بالكامل بعد تأخير لأن القناة "قيد التجهيز": القائمة الفرعية
// (index.m3u8) لم تظهر بعد لأن ffmpeg لا يزال يتصل بالمصدر (أو المصدر لا يستجيب).
// لا نتوقّف نهائياً — المصادر الحيّة المتذبذبة تتعافى لاحقاً — لكن نتمهّل بعد دقيقة
// (كل 8ث بدل 2ث) لتفادي القصف، ويتكفّل armPrepWatchdog بإظهار رسالة للمستخدم.
function schedulePrepRetry() {
  showLoading();
  clearTimeout(manifestRetryTimer);
  manifestRetryCount++;
  // كل 5 محاولات، اسأل الخادم عن سبب التعطّل (محظور/خطأ) لعرض رسالة دقيقة فوراً.
  if (manifestRetryCount % 5 === 0) checkChannelHealth(currentChannel && currentChannel.id);
  const delay = manifestRetryCount >= PREP_SLOW_AFTER ? 8000 : 2000;
  manifestRetryTimer = setTimeout(() => {
    if (currentChannel && hls) hls.loadSource(currentChannel.url + '?t=' + Date.now());
  }, delay);
}
function wireHlsEvents() {
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    // ملاحظة: تحليل القائمة الرئيسية لا يعني بدء العرض — التصفير يتم في hideLoading
    // عند بدء العرض الفعلي فقط، حتى يعمل مراقب التجهيز ضد المصادر التي لا تبثّ.
    $('#video').play().catch(() => {});
    hideMsg();
    stallCount = 0;
  });
  hls.on(Hls.Events.ERROR, (ev, data) => {
    // معالجة صريحة لأشهر أخطاء البث المحلي
    if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
      stallCount++;
      showMsg('انقطاع مؤقت في البث... جارٍ المعالجة');
      if (stallCount > 3 && hls.levels && hls.levels.length > 1 && hls.currentLevel > 0) {
        hls.nextLevel = Math.max(0, hls.currentLevel - 1); // انزل جودة لتثبيت البث
        stallCount = 0;
      }
      setTimeout(hideMsg, 3000);
      return;
    }
    if (data.details === Hls.ErrorDetails.FRAG_LOAD_TIMEOUT) {
      // مهلة في تحميل جزء (المقطع موجود لكن بطيء) — استئناف خفيف يكفي
      showMsg('بطء في تحميل البث... إعادة المحاولة');
      hls.stopLoad();
      setTimeout(() => { hls.startLoad(); hideMsg(); }, 1500);
      return;
    }
    // "قيد التجهيز": القائمة الرئيسية أو الفرعية لم تجهز بعد. يشمل هذا أهم حالة
    // واقعية: القائمة الرئيسية (master) تُكتب فور بدء ffmpeg، لكن القائمة الفرعية
    // (index.m3u8) لا تظهر إلا بعد أول مقطع — فإن كان المصدر بطيئاً/لا يستجيب
    // (فشل DNS/502/رفض الاتصال) ترجع 404 (LEVEL_LOAD_ERROR) ويبقى المشغّل
    // ينتظر بلا نهاية. نعيد تحميل المصدر كاملاً دورياً حتى تجهز القائمة الفرعية.
    if (data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
        data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT ||
        data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR ||
        data.details === Hls.ErrorDetails.LEVEL_LOAD_ERROR ||
        data.details === Hls.ErrorDetails.LEVEL_LOAD_TIMEOUT ||
        data.details === Hls.ErrorDetails.LEVEL_EMPTY_ERROR) {
      schedulePrepRetry();
      return;
    }
    if (data.fatal) {
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          // أي خطأ شبكة قاتل آخر يُعامَل كقناة قيد التجهيز: إعادة تحميل المصدر
          // كاملاً دورياً (لا startLoad فقط) مع رسالة صريحة إن طال الأمر.
          schedulePrepRetry();
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          showMsg('مشكلة في الوسائط — جارٍ الإصلاح...');
          hls.recoverMediaError();
          break;
        default:
          hideLoading();
          showMsg('تعذر تشغيل البث — إعادة المحاولة خلال ثوانٍ');
          setTimeout(() => currentChannel && loadIntoPlayer(currentChannel), 4000);
      }
    }
  });
}

/** التبديل بين القنوات لا يوقف المشغّل: نفس الـ instance، فقط loadSource جديد */
function loadIntoPlayer(ch) {
  const mode = ensurePlayer();
  const video = $('#video');
  $('#npName').textContent = ch.name;
  clearTimeout(manifestRetryTimer); // ألغِ أي إعادة محاولة لقناة سابقة
  manifestRetryCount = 0;
  hideMsg();
  showLoading();      // أظهر "جاري تجهيز البث..." حتى يبدأ العرض فعلياً
  armPrepWatchdog();  // وراقب: إن طال التجهيز اعرض رسالة صريحة بدل دوّارة لا تنتهي
  if (mode === 'hls') {
    hls.loadSource(ch.url + '?t=' + Date.now());
  } else {
    video.src = ch.url;
    video.play().catch(() => {});
  }
}


function playChannel(id) {
  const ch = CHANNELS.find(c => c.id === id);
  if (!ch) return;
  currentChannel = ch;
  // التشغيل عند الطلب: يطلب من الخادم تجهيز بث القناة إن كان الخيار مفعّلاً في الإعدادات
  fetch('/api/public/watch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: ch.id })
  }).catch(() => {});
  loadIntoPlayer(ch);
  heartbeat();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}


function showMsg(t) { const m = $('#playerMsg'); m.textContent = t; m.classList.remove('hidden'); }
function hideMsg() { $('#playerMsg').classList.add('hidden'); }

// controls
$('#closePlayer').onclick = () => {
  $('#playerSection').classList.add('hidden');
  clearTimeout(manifestRetryTimer);
  const v = $('#video');
  try { v.pause(); } catch (e) {}
  if (hls) { try { hls.stopLoad(); hls.detachMedia(); hls.destroy(); } catch (e) {} hls = null; }
  // تفريغ كامل للفيديو لإيقاف الصوت فوراً (إزالة src وحدها لا تكفي في بعض المتصفحات)
  try { v.removeAttribute('src'); v.load(); } catch (e) {}
  hideLoading();
  currentChannel = null;
};
$('#muteBtn').onclick = () => {
  const v = $('#video');
  v.muted = !v.muted;
  $('#muteBtn').textContent = v.muted ? '🔇' : '🔊';
};
$('#fsBtn').onclick = () => {
  const v = $('#video');
  if (v.requestFullscreen) v.requestFullscreen();
  else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
};
// تحديث القناة: يعيد تحميل البث الحالي من جديد دون مغادرة المشغّل
$('#refreshBtn').onclick = () => {
  if (!currentChannel) return;
  hideMsg();
  if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
  loadIntoPlayer(currentChannel);
  heartbeat();
};
$('#cpuSaver').onchange = (e) => {
  cpuSaver = e.target.checked;
  localStorage.setItem('amaan_cpu', cpuSaver ? '1' : '0');
  if (currentChannel && hls) {
    // إعادة إنشاء المشغّل بإعدادات التوفير دون مغادرة القناة
    const ch = currentChannel;
    hls.destroy(); hls = null;
    loadIntoPlayer(ch);
  }
};

function heartbeat() {
  if (!currentChannel) return;
  fetch('/api/public/heartbeat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId: currentChannel.id, viewerId: clientId })
  }).catch(() => {});
}

window._hlsReady = () => {}; // hls.js loaded; player is created lazily on first play
init();
