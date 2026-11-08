'use strict';
/* البرنس لايف — منطق لوحة التحكم */

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => [...(el || document).querySelectorAll(s)];

// جودة القناة الواحدة: نسخ المصدر (copy) ثم جودات الترميز.
const CH_QUALITIES = [
  ['copy', 'نسخ المصدر (بلا ترميز — الأخف والأعلى جودة)'],
  ['auto', 'تلقائي (الأبعاد الافتراضية)'],
  ['240p', '240p'], ['288p', '288p'], ['320p', '320p'], ['360p', '360p'],
  ['432p', '432p'], ['480p', '480p'], ['720p', '720p']
];
// مستويات جودة الفيديو تصل من الخادم (/api/settings → videoLevels): مصدر واحد
// لقيم -b:v/-maxrate/-bufsize، فلا تنحرف نسخة ثانية في اللوحة عن قيم FFmpeg.
// «تلقائي» يحسب المستوى المناسب من دقة الخرج ومعدل الإطارات في الخادم.
const AUTO_BITRATE_LEVEL = { id: 'auto', name: 'تلقائي', label: 'تلقائي حسب جودة الخرج (يُحسب من الدقة وFPS)', kbps: null };
let CH_BITRATES = [AUTO_BITRATE_LEVEL];
function applyVideoLevels(levels) {
  if (!Array.isArray(levels) || !levels.length) return;
  CH_BITRATES = levels.map((level) => ({
    id: level.id,
    name: level.id === 'auto' ? 'تلقائي' : level.label,
    label: level.id === 'auto'
      ? 'تلقائي حسب جودة الخرج (يُحسب من الدقة وFPS)'
      : `${level.label} — ${level.bitrate} / سقف ${level.maxrate} / مخزن ${level.bufsize}`,
    kbps: level.bitrate ? Number(String(level.bitrate).replace(/k$/i, '')) : null
  }));
}
// بِتريت القنوات القديم (300k..600k) يُطابق مستواه الذي يحمل نفس -b:v.
const LEGACY_BITRATES = { '300k': 'economy', '400k': 'accepted', '500k': 'balanced', '600k': 'highest' };
// المستوى المقابل لقيمة محفوظة؛ أي قيمة غير معروفة تُعرض كـ«تلقائي».
function bitrateLevel(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text || text === 'auto') return CH_BITRATES[0];
  return CH_BITRATES.find((level) => level.id === text)
    || CH_BITRATES.find((level) => level.id === LEGACY_BITRATES[text]) || CH_BITRATES[0];
}
// معدّل الإطارات (FPS) لكل قناة — فارغ = الافتراضي 20 إطاراً.
const CH_FPS = [
  ['', 'تلقائي (20 إطار)'],
  ['15', '15 إطار'], ['20', '20 إطار'], ['25', '25 إطار'],
  ['30', '30 إطار'], ['50', '50 إطار'], ['60', '60 إطار']
];
const TYPE_LABELS = {
  usb: 'كرت التقاط (DirectShow)', http: 'HTTP مباشر', hls: 'HLS / M3U8',
file: 'ملف فيديو محلي', screen: 'التقاط الشاشة'
};
const STATUS_LABELS = { running: 'تعمل ON AIR', stopped: 'متوقفة', starting: 'جارٍ التشغيل', stopping: 'جارٍ الإيقاف', restarting: 'إعادة تشغيل', error: 'خطأ', blocked: 'محظورة من المزوّد' };

let DATA = { sources: [], channels: [], settings: {} };
let statusTimer = null, currentLogChannel = null;

// ---------------- API helper ----------------
async function api(path, opts) {
  opts = opts || {};
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
    opts.body = JSON.stringify(opts.body);
  }
  const r = await fetch('/api' + path, opts);
  const j = await r.json().catch(() => ({}));
  // 401 على /login تعني بيانات دخول خاطئة، لا جلسة منتهية — نُظهر رسالة الخادم.
  if (r.status === 401 && path !== '/login') { showLogin(); throw new Error('انتهت الجلسة، سجّل الدخول مجدداً'); }
  if (!r.ok || j.ok === false) throw new Error(j.message || 'حدث خطأ غير متوقع');
  return j;
}

function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), 3200);
}

// ---------------- Auth ----------------
function showLogin() { $('#loginScreen').classList.remove('hidden'); $('#app').classList.add('hidden'); }
function showApp() { $('#loginScreen').classList.add('hidden'); $('#app').classList.remove('hidden'); }

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  try {
    await api('/login', { method: 'POST', body: { user: $('#loginUser').value.trim(), pass: $('#loginPass').value } });
    $('#loginPass').value = '';
    showApp();
    await boot();
  } catch (err) { $('#loginError').textContent = err.message; }
});

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST' }); } catch (e) { /* الخروج محلياً يكفي */ }
  location.reload();
});

async function changePassword() {
  const current = $('#pw_current').value;
  const next = $('#pw_next').value;
  if (!current || !next) { toast('أدخل كلمة المرور الحالية والجديدة', true); return; }
  try {
    await api('/settings/password', { method: 'POST', body: { current, next } });
    $('#pw_current').value = '';
    $('#pw_next').value = '';
    toast('تم تغيير كلمة المرور');
  } catch (e) { toast(e.message, true); }
}

// ---------------- Navigation ----------------
$$('.nav-btn').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));
function switchView(name) {
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach(v => v.classList.toggle('hidden', v.id !== 'view-' + name));
  if (name === 'dashboard') refreshStatus();
}


// ---------------- Boot ----------------
async function boot() {
  // المصادر أولاً: جدول القنوات يطابق sourceId بأسماء المصادر، والتحميل المتوازي
  // كان يعرض «—» في عمود المصدر حتى إعادة تحميل القنوات.
  await Promise.all([loadSettings(), loadSources()]);
  await loadChannels();
  refreshStatus();
  clearInterval(statusTimer);
  statusTimer = setInterval(refreshStatus, 5000);
}

(async function init() {
  let authed = false;
  try { authed = (await fetch('/api/me').then(r => r.json())).authed === true; } catch (e) { authed = false; }
  if (!authed) { showLogin(); return; }
  showApp();
  try { await boot(); } catch (e) { console.error(e); toast(e.message, true); }
})();

// ---------------- Settings ----------------
const S_KEYS = ['siteName','siteNameLatin','logo','phone','theme','worldCupFullPage','ticker','tickerEnabled','x264Preset',
  'port','nginxPort',
  'x264Threads','x264QualityMode','hlsTime','gopSeconds','hlsListSize','hlsDeleteThreshold','startupQueueDelayMs','startupConcurrency','autoRestartCrashed','maxRestarts','restartBackoffMs','hideCosmeticLogs',
  'playerMaxBufferLength','playerBackBufferLength','playerLiveSyncDuration','capLevelToPlayerSize',
  'cpuSaverDefault','ffmpegPath','ffprobePath','nginxPath','streamUserAgent','autoStartOnDemand','idleStopEnabled','idleStopMinutes',
  'sourceFailStopMinutes','blockedStopMinutes'];

async function loadSettings() {
  const { settings, nginx, videoLevels } = await api('/settings');
  DATA.settings = settings;
  applyVideoLevels(videoLevels);
  // مسار Nginx المحلول فعلياً من الإعدادات، مع تنبيه إن كان الملف غير موجود.
  const nginxNote = $('#nginxPathNote');
  if (nginxNote) {
    nginxNote.textContent = nginx && nginx.binary
      ? (nginx.binaryExists ? 'مسار Nginx المستخدم: ' : 'لم يُعثر على ملف Nginx في: ') + nginx.binary
      : '';
    nginxNote.classList.toggle('warn', !!(nginx && !nginx.binaryExists));
  }
  loadLanLinks();
  for (const k of S_KEYS) {
    const el = $('#s_' + k);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!settings[k]; else el.value = settings[k] ?? '';
  }
  document.body.classList.toggle('worldcup', settings.theme === 'worldcup');
  $('#brandName').textContent = settings.siteName || 'البرنس لايف';
  $('#adminFooter').textContent = 'جميع الحقوق محفوظة © البرنس لايف';
  const logo = $('#brandLogo');
  if (settings.logo) { logo.src = getAssetUrl(settings.logo); logo.classList.remove('hidden'); }
  else logo.classList.add('hidden');
}

async function saveSettings() {
  const body = {};
  for (const k of S_KEYS) {
    const el = $('#s_' + k);
    if (!el) continue;
    body[k] = el.type === 'checkbox' ? el.checked : ((el.type === 'number' || el.type === 'range') ? Number(el.value) : el.value);
  }
  try {
    const r = await api('/settings', { method: 'POST', body });
    // إعدادات الترميز العامة (Preset/Threads/HLS/GOP) يعيد الخادم تشغيل القنوات
    // النشطة بها فوراً، فنخبر المستخدم بعدد القنوات التي طُبّقت عليها.
    const applied = (r.restartedChannels || []).length;
    toast(applied ? `تم حفظ الإعدادات وتطبيقها على ${applied} قناة نشطة` : 'تم حفظ الإعدادات');
    loadSettings();
    refreshStatus();
    if (r.restartRequired || r.nginxRestartRequired) {
      alert('تم تغيير المنفذ. لتطبيق التغيير:\n1) اضغط «تحديث ملف nginx.conf بالمنافذ الحالية».\n2) أعد تشغيل النظام (أغلق نافذة الأوامر وشغّل start.bat).\n3) أعد تشغيل Nginx.');
    }
  } catch (e) { toast(e.message, true); }
}

async function regenerateNginx() {
  try {
    // احفظ المنافذ الحالية من الحقول أولاً حتى لا يعتمد على ترتيب الضغط
    const nginxPort = Number($('#s_nginxPort').value) || 80;
    const port = Number($('#s_port').value) || 3000;
    if (nginxPort === port) { toast('منفذ النظام و Nginx يجب أن يكونا مختلفين', true); return; }
    await api('/settings', { method: 'PUT', body: { nginxPort, port } });
    const r = await api('/settings/regenerate-nginx', { method: 'POST', body: {} });
    const written = (r.written || []).join('\n');
    const notes = (r.notes || []).join('\n');
    alert('المنفذ المطبّق فعلياً: Nginx=' + r.nginxPort + ' · Node=' + r.port + '\n\nالملفات المكتوبة:\n' + written + '\n\n' + notes);
    toast('تم تحديث nginx.conf على المنفذ ' + r.nginxPort);
    loadSettings();
  } catch (e) { toast(e.message, true); }
}

// أوامر Nginx تُنفَّذ على المسار المحفوظ في «مسار Nginx» (settings.nginxPath).
async function nginxAction(action) {
  const labels = { test: 'اختبار', restart: 'إعادة تشغيل' };
  if (action === 'restart' && !confirm('إعادة تشغيل Nginx بالمسار المحفوظ في الإعدادات؟')) return;
  try {
    const r = await api('/nginx/action', { method: 'POST', body: { action } });
    alert((r.message || '') + (r.output ? '\n\n' + r.output : ''));
    if (r.ok) toast('تم ' + (labels[action] || action) + ' Nginx');
    else toast(r.message || 'فشل أمر Nginx', true);
  } catch (e) { toast(e.message, true); }
}

// عناوين الوصول من الهاتف: الخادم يعيد عناوين IPv4 الحقيقية للكمبيوتر (بلا محوّلات وهمية)
// مع منفذ Nginx الفعلي، فيكتب المستخدم العنوان الصحيح بدل تخمينه.
async function loadLanLinks() {
  const box = $('#lanLinks');
  if (!box) return;
  let info;
  try { info = await api('/network/interfaces'); }
  catch (e) { box.innerHTML = '<p class="field-note warn">تعذر اكتشاف عناوين الشبكة.</p>'; return; }
  const list = Array.isArray(info.interfaces) ? info.interfaces : [];
  if (!list.length) {
    box.innerHTML = '<p class="field-note warn">لم يُعثر على عنوان شبكة محلية — تأكد من اتصال الكمبيوتر بالشبكة.</p>';
    return;
  }
  const port = Number(info.port) || 80;
  const suffix = port === 80 ? '' : ':' + port;
  const link = (item, path) => {
    const url = `http://${item.address}${suffix}${path}`;
    return `<a href="${url}" target="_blank" rel="noopener">${url}</a>`;
  };
  // الخادم يحدد العنوان الذي يخرج منه الجهاز فعلاً؛ نعرضه وحده أولاً بدل قائمة يجرّبها المستخدم كلها.
  const primary = list.find((item) => item.primary) || list[0];
  const others = list.filter((item) => item !== primary);
  const rows = [`<p>${link(primary, '/')} للمشاهدة · ${link(primary, '/admin')} للإدارة <span class="lan-if">(${escHtml(primary.name)})</span></p>`];
  if (others.length) {
    // سطر مستقل باتجاه LTR حتى تبقى العناوين بترتيبها ولا يقلبها اتجاه الصفحة العربي.
    rows.push('<p class="field-note">عناوين أخرى على الجهاز (لا تستخدمها إلا إذا لم يعمل العنوان أعلاه):</p>'
      + `<p class="lan-alt" dir="ltr">${others.map((item) => link(item, '/')).join(' · ')}</p>`);
  }
  const fw = info.firewall || {};
  const fwWarn = fw.checked === true && (fw.viewer === false || fw.api === false)
    ? '<p class="field-note warn">جدار الحماية لا يسمح بالمنافذ بعد — شغّل scripts\\allow-lan.bat مرة واحدة، وتأكد أن شبكة ويندوز مصنّفة «خاصة».</p>'
    : '';
  box.innerHTML = `<div class="lan-links">${rows.join('')}</div>`
    + '<p class="field-note">اكتب العنوان حرفياً على الهاتف مع نفس المنفذ، وتأكد أن الهاتف على شبكة Wi-Fi نفسها وليست شبكة ضيوف.</p>'
    + fwWarn;
}

// ---------------- النسخ الاحتياطي ----------------
function downloadBackup() {
  toast('جارٍ تجهيز النسخة الاحتياطية...');
  // فتح رابط التنزيل مباشرةً (المتصفح يحفظ الملف)
  const a = document.createElement('a');
  a.href = '/api/backup/download';
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

let _restoreFile = null;
function restoreFileChosen(input) {
  _restoreFile = input.files[0] || null;
  $('#restoreFileName').value = _restoreFile ? _restoreFile.name : '';
  $('#restoreBtn').disabled = !_restoreFile;
}

async function doRestore() {
  if (!_restoreFile) return;
  if (!confirm('سيتم استبدال كل الإعدادات الحالية بمحتوى النسخة، وإعادة تشغيل النظام. متابعة؟')) return;
  const fd = new FormData();
  fd.append('file', _restoreFile);
  try {
    toast('جارٍ الاسترجاع...');
    await api('/backup/restore', { method: 'POST', body: fd });
    toast('تم الاسترجاع — يُعاد تشغيل النظام، انتظر قليلاً ثم حدّث الصفحة');
    setTimeout(() => location.reload(), 6000);
  } catch (e) { toast(e.message, true); }
}

// ---------------- Upload helper (Browse button) ----------------
function browseUpload(targetInputId, accept) {
  const fi = document.createElement('input');
  fi.type = 'file';
  if (accept) fi.accept = accept;
  fi.onchange = async () => {
    if (!fi.files[0]) return;
    const fd = new FormData();
    fd.append('file', fi.files[0]);
    try {
      const r = await api('/upload', { method: 'POST', body: fd });
      $('#' + targetInputId).value = r.path;
      toast('تم رفع الملف');
    } catch (e) { toast(e.message, true); }
  };
  fi.click();
}

// ---------------- Modal helpers ----------------
function openModal(title, bodyHtml, onSave) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  $('#modalError').textContent = '';
  const save = $('#modalSave');
  save.textContent = 'حفظ';
  save.classList.add('btn-primary');
  save.classList.remove('btn-danger');
  $('#modalOverlay').classList.remove('hidden');
  save.onclick = async () => {
    $('#modalError').textContent = '';
    try { await onSave(); closeModal(); }
    catch (e) { $('#modalError').textContent = e.message; }
  };
}
function closeModal() { $('#modalOverlay').classList.add('hidden'); }

// نافذة تأكيد قبل الإجراءات الحساسة (بدل confirm الخاص بالمتصفح)
function confirmAction(title, message, onConfirm) {
  openModal(title, `<p class="confirm-text">${message}</p>`, onConfirm);
  const save = $('#modalSave');
  save.textContent = 'تأكيد الحذف';
  save.classList.remove('btn-primary');
  save.classList.add('btn-danger');
}
$('#modalOverlay').addEventListener('click', (e) => { if (e.target.id === 'modalOverlay') closeModal(); });

// =====================================================================
// SOURCES
// =====================================================================
async function loadSources() {
  DATA.sources = (await api('/sources')).sources;
  const tb = $('#sourcesTable tbody');
  tb.innerHTML = DATA.sources.map(s => `<tr>
    <td><b>${esc(s.name)}</b></td>
    <td>${esc(TYPE_LABELS[s.type] || s.type)}</td>
    <td class="cell-muted">${esc(sourceDetail(s))}</td>
    <td><div class="row-actions">
      <button class="btn btn-sm" onclick="openSourceModal('${s.id}')">تعديل</button>
      <button class="btn btn-sm btn-danger" onclick="deleteSource('${s.id}')">حذف</button>
    </div></td></tr>`).join('') || '<tr><td colspan="4" class="cell-muted">لا توجد مصادر بعد — أضف أول مصدر للبدء.</td></tr>';
}

function sourceDetail(s) {
  if (s.type === 'usb') return (s.videoDeviceLabel || s.videoDevice || '') + (s.videoSize ? ' @ ' + s.videoSize : '');
  if (s.type === 'file') return s.path || '';
  if (s.type === 'screen') return 'desktop' + (s.fps ? ' @ ' + s.fps + 'fps' : '');
  return s.url || '';
}

function deleteSource(id) {
  const src = DATA.sources.find(s => s.id === id);
  confirmAction('حذف المصدر',
    `سيتم حذف المصدر «${esc(src ? src.name : '')}» نهائياً. لا يمكن التراجع عن هذا الإجراء.`,
    async () => {
      await api('/sources/' + id, { method: 'DELETE' });
      await loadSources();
      toast('تم الحذف');
    });
}

function openSourceModal(id) {
  const src = id ? DATA.sources.find(s => s.id === id) : null;
  const body = `
    <label>اسم المصدر<input class="input" id="m_name" value="${esc(src?.name)}"></label>
    <label>نوع المصدر
      <select class="input" id="m_type" onchange="renderSourceFields()">
        ${Object.entries(TYPE_LABELS).map(([v, l]) =>
          `<option value="${v}" ${src?.type === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
    <div id="srcFields"></div>
    ${id ? '' : `<label class="switch-row" style="margin-top:10px"><input type="checkbox" id="m_autoChannel" checked> إضافة قناة تلقائياً لهذا المصدر بعد الحفظ</label>`}`;
  openModal(id ? 'تعديل مصدر' : 'إضافة مصدر', body, async () => {
    const payload = collectSourceForm();
    let created = null;
    if (id) { await api('/sources/' + id, { method: 'PUT', body: payload }); }
    else { created = await api('/sources', { method: 'POST', body: payload }); }
    // تحديث المصادر أولاً حتى يظهر اسم المصدر في جدول القنوات مباشرة
    await loadSources();
    // إضافة قناة تلقائياً إن طُلب
    if (created && $('#m_autoChannel') && $('#m_autoChannel').checked && created.source) {
      try {
        await api('/channels', { method: 'POST', body: { name: created.source.name, sourceId: created.source.id, enabled: true } });
      } catch (e) {}
      await loadChannels();
    }
    toast('تم الحفظ');
  });
  window._editSrc = src;
  renderSourceFields();
}

let _srcFieldsSeq = 0;
async function renderSourceFields() {
  const type = $('#m_type').value;
  const seq = ++_srcFieldsSeq;
  const src = window._editSrc && window._editSrc.type === type ? window._editSrc : null;
  const box = $('#srcFields');

  if (type === 'usb') {
    box.innerHTML = `<p class="hint">جارٍ قراءة الأجهزة المتصلة...</p>`;
    try {
      const d = await api('/devices');
      // تغيّر النوع أثناء جلب الأجهزة: تجاهل نتيجة هذا الطلب القديم
      if (seq !== _srcFieldsSeq) return;
      box.innerHTML = `
        <label>جهاز الفيديو
          <select class="input" id="m_videoDevice" onchange="loadSizeOptions()">
            ${d.video.map(v => `<option value="${esc(v.value)}" data-label="${esc(v.label)}"
              ${src?.videoDevice === v.value ? 'selected' : ''}>${esc(v.label)}</option>`).join('') || '<option value="">لا توجد أجهزة</option>'}
          </select></label>
        <button class="btn btn-sm" type="button" onclick="autoRecommendCapture()" style="margin:4px 0 8px">⚙️ ضبط تلقائي لأفضل إعدادات (موصى به لكروت USB)</button>
        <p class="hint" id="m_capHint"></p>
        <label>صيغة الإدخال
          <select class="input" id="m_capFormat">
            <option value="">افتراضي الجهاز</option>
            <option value="pf:yuyv422" ${src?.pixelFormat === 'yuyv422' ? 'selected' : ''}>yuyv422 (خام — يمنع أعطال MJPEG)</option>
            <option value="vc:mjpeg" ${src?.vcodec === 'mjpeg' ? 'selected' : ''}>mjpeg (إن لم يدعم الجهاز yuyv)</option>
          </select></label>
        <label>الدقة (video_size)
          <select class="input" id="m_videoSize"><option value="">افتراضي</option></select></label>
        <label>الإطارات بالثانية (FPS)
          <select class="input" id="m_fps"><option value="">افتراضي</option></select></label>
        <label class="switch-row"><input type="checkbox" id="m_capSafe" ${src?.captureSafeMode ? 'checked' : ''}>
          الوضع الآمن (لا تفرض الدقة/الإطارات — جرّبه إن ظهر خطأ "Could not set video options")</label>
        <label>جهاز الصوت (اختياري)
          <select class="input" id="m_audioDevice">
            <option value="">بدون صوت منفصل</option>
            ${d.audio.map(a => `<option value="${esc(a.value)}" ${src?.audioDevice === a.value ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}
          </select></label>
        ${(!d.video.length || !d.audio.length) ? `<p class="hint">${esc(d.note || '')}</p>` : ''}
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0">
          <button class="btn btn-sm" type="button" onclick="testCaptureDevice('video')">📷 اختبار الفيديو (3 ثوانٍ)</button>
          <button class="btn btn-sm" type="button" onclick="testCaptureDevice('audio')">🎤 اختبار الصوت (3 ثوانٍ)</button>
          <span id="m_capTestResult" class="hint" style="margin:0"></span>
        </div>`;
      await loadSizeOptions(src);
    } catch (e) {
      if (seq !== _srcFieldsSeq) return;
      box.innerHTML = `<p class="form-error">${esc(e.message)} — يلزم دعم DirectShow في ويندوز، وأن يظهر كرت UVC في «إدارة الأجهزة ← Cameras».</p>`;
    }
  } else if (type === 'file') {
    box.innerHTML = `
      <label>ملف الفيديو
        <span class="with-browse">
          <input class="input" id="m_path" value="${esc(src?.path)}" placeholder="srv/uploads/video.mp4">
          <button class="btn" type="button" onclick="browseUpload('m_path','video/*')">استعراض / رفع</button>
        </span></label>
      <p class="hint">سيتم تشغيل الملف في حلقة مستمرة (loop).</p>`;
  } else if (type === 'screen') {
    box.innerHTML = `
      <label>FPS<input class="input" id="m_fps" type="number" min="5" max="60" value="${esc(src?.fps || 15)}"></label>
      <label>الدقة (اختياري)<input class="input" id="m_videoSize" placeholder="1920x1080" value="${esc(src?.videoSize)}"></label>`;
  } else {
    box.innerHTML = `<label>الرابط<input class="input" id="m_url" dir="ltr" value="${esc(src?.url)}"
      placeholder="http://.../stream.m3u8"></label>
      <div style="display:flex;gap:8px;align-items:center;margin:8px 0">
        <button class="btn btn-sm" type="button" onclick="testSourceUrl()">🔍 اختبار قراءة الرابط</button>
        <span id="m_testResult" class="hint" style="margin:0"></span>
      </div>
      <pre id="m_testDetail" class="log-body" style="display:none;max-height:160px"></pre>`;
  }
}

// اختبار قراءة رابط المصدر قبل الحفظ: يُظهر رد الخادم ونوع البيانات (m3u8/ts/خطأ).
async function testSourceUrl() {
  const url = ($('#m_url') && $('#m_url').value || '').trim();
  const result = $('#m_testResult'), detail = $('#m_testDetail');
  if (!url) { result.textContent = 'أدخل الرابط أولاً'; result.style.color = 'var(--accent)'; return; }
  result.textContent = 'جارٍ الاختبار...'; result.style.color = '';
  if (detail) detail.style.display = 'none';
  try {
    const r = await api('/sources/test', { method: 'POST', body: { url } });
    const kindLabel = { m3u8: 'قائمة تشغيل HLS (m3u8)', ts: 'تدفق TS مباشر', other: 'نوع آخر/غير معروف', error: 'خطأ' }[r.kind] || r.kind;
    if (r.ok) result.innerHTML = `<span style="color:var(--ok,#3a7)">✓ نجح — الحالة ${r.status} — النوع: ${kindLabel}</span>`;
    else result.innerHTML = `<span style="color:var(--accent)">✗ فشل — الحالة ${r.status || '—'} — ${esc(r.message || kindLabel)}</span>`;
    if (detail) {
      detail.style.display = 'block';
      detail.textContent = `HTTP ${r.status || ''} ${r.statusText || ''}\nContent-Type: ${r.contentType || '—'}\n\n${(r.preview || '').slice(0, 1200)}`;
    }
  } catch (e) {
    result.innerHTML = `<span style="color:var(--accent)">✗ ${esc(e.message)}</span>`;
  }
}

async function autoRecommendCapture() {
  const sel = $('#m_videoDevice');
  if (!sel || !sel.value) { toast('اختر جهاز الفيديو أولاً', true); return; }
  $('#m_capHint').textContent = 'جارٍ فحص الجهاز واختيار أفضل إعدادات...';
  try {
    const r = await api('/devices/recommend?device=' + encodeURIComponent(sel.value));
    // make sure size list is populated, then apply
    await loadSizeOptions();
    // format
    if (r.pixelFormat === 'yuyv422') $('#m_capFormat').value = 'pf:yuyv422';
    else if (r.vcodec === 'mjpeg') $('#m_capFormat').value = 'vc:mjpeg';
    else $('#m_capFormat').value = '';
    // size (add if missing)
    if (r.videoSize) {
      if (![...$('#m_videoSize').options].some(o => o.value === r.videoSize))
        $('#m_videoSize').insertAdjacentHTML('beforeend', `<option>${r.videoSize}</option>`);
      $('#m_videoSize').value = r.videoSize;
    }
    if (r.fps) {
      if (![...$('#m_fps').options].some(o => o.value == r.fps))
        $('#m_fps').insertAdjacentHTML('beforeend', `<option>${r.fps}</option>`);
      $('#m_fps').value = r.fps;
    }
    const fmt = r.pixelFormat || r.vcodec || 'افتراضي';
    $('#m_capHint').textContent = `تم: الصيغة ${fmt} · الدقة ${r.videoSize} · ${r.fps}fps. الجهاز يدعم: ${(r.detected.pixelFormats.concat(r.detected.codecs)).join(', ') || '—'}`;
    toast('تم ضبط أفضل إعدادات للجهاز');
  } catch (e) {
    $('#m_capHint').textContent = '';
    toast('تعذر الفحص التلقائي: ' + e.message, true);
  }
}

// اختبار جهاز الالتقاط قبل الحفظ: يشغّل الجهاز 3 ثوانٍ على الخادم بنفس إعدادات النموذج،
// فيتأكد المستخدم أن الجهاز المتصل يعمل فعلاً قبل ربطه بقناة.
async function testCaptureDevice(mode) {
  const result = $('#m_capTestResult');
  if (!result) return;
  const form = collectSourceForm();
  if (mode === 'video' && !form.videoDevice) { result.textContent = 'اختر جهاز الفيديو أولاً'; result.style.color = 'var(--accent)'; return; }
  if (mode === 'audio' && !form.audioDevice) { result.textContent = 'اختر جهاز الصوت أولاً'; result.style.color = 'var(--accent)'; return; }
  result.textContent = 'جارٍ الاختبار (3 ثوانٍ)...';
  result.style.color = '';
  try {
    const r = mode === 'audio'
      ? await api('/devices/test-audio', { method: 'POST', body: { audioDevice: form.audioDevice } })
      : await api('/devices/test', { method: 'POST', body: {
          videoDevice: form.videoDevice, audioDevice: form.audioDevice,
          videoSize: form.videoSize || '1280x720', fps: form.fps || 30,
          pixelFormat: form.pixelFormat, vcodec: form.vcodec, captureSafeMode: form.captureSafeMode
        } });
    result.innerHTML = `<span style="color:var(--ok,#3a7)">✓ ${esc((r.result && r.result.output) || 'نجح الاختبار')}</span>`;
  } catch (e) {
    result.innerHTML = `<span style="color:var(--accent)">✗ ${esc(e.message)}</span>`;
  }
}

async function loadSizeOptions(src) {
  const sel = $('#m_videoDevice');
  if (!sel || !sel.value) return;
  const sizeSel = $('#m_videoSize'), fpsSel = $('#m_fps');
  sizeSel.innerHTML = '<option value="">جارٍ القراءة...</option>';
  try {
    const o = await api('/devices/options?device=' + encodeURIComponent(sel.value));
    sizeSel.innerHTML = '<option value="">افتراضي</option>' +
      o.sizes.map(s => `<option ${src?.videoSize === s ? 'selected' : ''}>${s}</option>`).join('');
    fpsSel.innerHTML = '<option value="">افتراضي</option>' +
      o.fps.map(f => `<option ${src?.fps == f ? 'selected' : ''}>${f}</option>`).join('');
  } catch (e) { sizeSel.innerHTML = '<option value="">تعذرت القراءة</option>'; }
}

function collectSourceForm() {
  const type = $('#m_type').value;
  const out = { name: $('#m_name').value.trim(), type };
  if (type === 'usb') {
    const sel = $('#m_videoDevice');
    out.videoDevice = sel.value;
    out.videoDeviceLabel = sel.selectedOptions[0]?.dataset.label || '';
    out.videoSize = $('#m_videoSize').value;
    out.fps = $('#m_fps').value ? Number($('#m_fps').value) : null;
    out.audioDevice = $('#m_audioDevice').value;
    // صيغة الإدخال: pf:yuyv422 → pixelFormat، vc:mjpeg → vcodec
    const fmt = $('#m_capFormat') ? $('#m_capFormat').value : '';
    out.pixelFormat = fmt.startsWith('pf:') ? fmt.slice(3) : '';
    out.vcodec = fmt.startsWith('vc:') ? fmt.slice(3) : '';
    out.captureSafeMode = $('#m_capSafe') ? $('#m_capSafe').checked : false;
  } else if (type === 'file') {
    out.path = $('#m_path').value.trim();
  } else if (type === 'screen') {
    out.fps = Number($('#m_fps').value || 15);
    out.videoSize = $('#m_videoSize').value.trim();
  } else {
    out.url = $('#m_url').value.trim();
  }
  return out;
}

// =====================================================================
// CHANNELS
// =====================================================================
async function loadChannels() {
  DATA.channels = (await api('/channels')).channels;
  const srcName = id => DATA.sources.find(s => s.id === id)?.name || '—';
  $('#channelsTable tbody').innerHTML = DATA.channels
    .slice().sort((a, b) => (a.sort || 0) - (b.sort || 0))
    .map(c => `<tr>
      <td>${c.sort || 0}</td>
      <td><b>${esc(c.name)}</b></td>
      <td class="cell-muted">${esc(c.chanId)}</td>
      <td>${esc(c.category)}</td>
      <td>${esc(srcName(c.sourceId))}</td>
      <td class="cell-muted">${qualityLabel(c.quality)}</td>
      <td>${c.autoStart ? 'نعم' : 'لا'}</td>
      <td><span class="chip" data-chip="${c.id}">…</span>${c.manualStopped ? '<span class="cell-muted" title="أُوقفت يدوياً: لا تعمل تلقائياً حتى تشغيلها"> · يدوي</span>' : ''}</td>
      <td><div class="row-actions">
        <label class="ch-enable" title="إلغاء التفعيل يوقف القناة نهائياً ويُخفيها عن المشاهدين حتى إعادة تفعيلها">
          <input type="checkbox" ${c.enabled !== false ? 'checked' : ''} onchange="toggleChannelEnabled('${c.id}', this.checked)"> مفعّلة</label>
        <button class="btn btn-sm" onclick="chAction('${c.id}','start')">تشغيل</button>
        <button class="btn btn-sm" onclick="chAction('${c.id}','stop')">إيقاف</button>
        <button class="btn btn-sm" onclick="chAction('${c.id}','restart')">إعادة</button>
        <button class="btn btn-sm" onclick="openChannelModal('${c.id}')">تعديل</button>
        <button class="btn btn-sm btn-danger" onclick="deleteChannel('${c.id}')">حذف</button>
      </div></td></tr>`).join('') || '<tr><td colspan="9" class="cell-muted">لا توجد قنوات بعد.</td></tr>';
  refreshStatus();
}

async function chAction(id, act) {
  try { await api(`/channels/${id}/${act}`, { method: 'POST' }); toast('تم تنفيذ الأمر'); setTimeout(refreshStatus, 800); }
  catch (e) { toast(e.message, true); }
}

// تفعيل/تعطيل القناة من قائمة القنوات. التعطيل يوقفها نهائياً ويُخفيها عن
// المشاهدين؛ لا تعمل إلا بإعادة التفعيل يدوياً.
async function toggleChannelEnabled(id, enabled) {
  try {
    await api('/channels/' + id, { method: 'PATCH', body: { enabled } });
    toast(enabled ? 'تم تفعيل القناة' : 'تم تعطيل القناة (موقّفة ومخفية عن المشاهدين)');
    await loadChannels();
  } catch (e) { toast(e.message, true); loadChannels(); }
}

function deleteChannel(id) {
  const ch = DATA.channels.find(c => c.id === id);
  confirmAction('حذف القناة',
    `سيتم حذف القناة «${esc(ch ? ch.name : '')}» وجدولتها نهائياً. لا يمكن التراجع عن هذا الإجراء.`,
    async () => {
      await api('/channels/' + id, { method: 'DELETE' });
      await loadChannels();
      toast('تم الحذف');
    });
}

// «تلقائي» يُحلّ في الخادم بنفس دالة الترميز؛ نعرض المستوى المحسوب بجانب الخيار
// ليتحقق المستخدم من الحساب قبل الحفظ. يتحدّث فور تغيير الجودة أو FPS أو المصدر.
async function refreshAutoLevelHint() {
  const sel = $('#m_cbitrate');
  if (!sel) return;
  const autoOpt = [...sel.options].find((o) => o.value === 'auto');
  if (!autoOpt) return;
  const base = bitrateLevel('auto').label;
  const note = $('#m_cautoHint');
  const quality = $('#m_cquality').value;
  if (quality === 'copy' || quality === 'source') { autoOpt.textContent = base; if (note) { note.textContent = ''; note.hidden = true; } return; }
  try {
    const plan = await api('/channels/plan', {
      method: 'POST',
      body: { sourceId: $('#m_csource').value, quality, fps: $('#m_cfps').value || null }
    });
    const lv = plan.level;
    autoOpt.textContent = `تلقائي — «${lv.label}» (${lv.bitrate} / سقف ${lv.maxrate} / مخزن ${lv.bufsize})`;
    // الأبعاد داخل عزل LTR حتى لا يعكسها اتجاه النص العربي (320×568 بدل 568×320).
    if (note) { note.textContent = `الحساب التلقائي لهذه القناة: \u2066${plan.outputWidth}×${plan.outputHeight}\u2069 عند ${plan.outputFps} إطاراً ← الهدف ${plan.autoTargetKbps}k ⇒ «${lv.label}».`; note.hidden = false; }
  } catch (e) { autoOpt.textContent = base; if (note) note.textContent = ''; }
}

function openChannelModal(id) {
  const ch = id ? DATA.channels.find(c => c.id === id) : null;
  const curQ = ch?.quality || 'copy';
  // مستوى جودة الفيديو الحالي للقناة (القيم القديمة تُحوَّل إلى مستواها).
  const curBitrate = bitrateLevel(ch?.bitrate).id;
  // معدّل الإطارات الحالي؛ أي قيمة خارج القائمة (مثل 24) تُضاف كخيار حتى لا تُفقد عند الحفظ.
  const curFps = String(ch?.fps || '').trim();
  const fpsOptions = CH_FPS.some(([v]) => v === curFps)
    ? CH_FPS
    : CH_FPS.concat([[curFps, curFps + ' — الحالي']]);
  openModal(id ? 'تعديل قناة' : 'إضافة قناة', `
    <label>اسم القناة<input class="input" id="m_cname" value="${esc(ch?.name)}"></label>
    <label>معرّف القناة (إنجليزي، يستخدم في الروابط)<input class="input" id="m_cid" dir="ltr" value="${esc(ch?.chanId)}" placeholder="sport1"></label>
    <label>مصدر البث
      <select class="input" id="m_csource">
        ${DATA.sources.map(s => `<option value="${s.id}" ${ch?.sourceId === s.id ? 'selected' : ''}>${esc(s.name)} (${TYPE_LABELS[s.type] || s.type})</option>`).join('') || '<option value="">أضف مصدراً أولاً</option>'}
      </select></label>
    <label>التصنيف<input class="input" id="m_ccat" value="${esc(ch?.category)}" placeholder="رياضة / أخبار / أطفال"></label>
    <label>ترتيب الظهور<input class="input" id="m_csort" type="number" value="${ch?.sort || 0}"></label>
    <label>صورة غلاف القناة
      <span class="with-browse">
        <input class="input" id="m_ccover" value="${esc(ch?.cover)}" placeholder="srv/uploads/cover.jpg">
        <button class="btn" type="button" onclick="browseUpload('m_ccover','image/*')">استعراض / رفع</button>
      </span></label>
    <label>الجودة
      <select class="input" id="m_cquality">
        ${CH_QUALITIES.map(([v, l]) => `<option value="${v}" ${curQ === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
    <p class="hint">«نسخ المصدر» يبثّ القناة كما هي بلا إعادة ترميز (الأخف على المعالج والأعلى جودة). اختر جودة محددة فقط إن أردت تصغير الحجم/الدقة (يستهلك معالجاً أكثر).</p>
    <label>معدّل الإطارات (FPS) لهذه القناة
      <select class="input" id="m_cfps" dir="ltr">
        ${fpsOptions.map(([v, l]) => `<option value="${v}" ${curFps === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
    <p class="hint">عدد الإطارات في الثانية لخرج هذه القناة وحدها؛ أقل = أستهلك معالجاً وشبكة أقل، وأعلى = حركة أنعم. يُطبَّق في وضع الترميز فقط (يُهمَل عند «نسخ المصدر»).</p>
    <label>مستوى جودة الفيديو (Video Bitrate) لهذه القناة
      <select class="input" id="m_cbitrate">
        ${CH_BITRATES.map((level) => `<option value="${level.id}" ${curBitrate === level.id ? 'selected' : ''}>${level.label}</option>`).join('')}
      </select></label>
    <p class="hint" id="m_cautoHint"></p>
    <p class="hint">كل مستوى يعتمد ثلاث قيم تُمرَّر إلى FFmpeg كما هي: -b:v (المعدّل) و-maxrate (السقف) و-bufsize (المخزن). «تلقائي» يختار المستوى المناسب من دقة الخرج ومعدل الإطارات. تُطبَّق الإعدادات فوراً: إن كانت القناة تعمل تُعاد للتشغيل تلقائياً بعد الحفظ.</p>
    <label>عدد خيوط الترميز (Threads) لهذه القناة
      <input class="input" id="m_cthreads" type="number" min="1" max="64" dir="ltr" value="${esc(ch?.threads ?? '')}" placeholder="فارغ = الإعداد العام"></label>
    <p class="hint">عدد خيوط libx264 لهذه القناة وحدها (1–64). فارغ = يتبع الإعداد العام x264Threads. قلّله إن كانت قنوات كثيرة تعمل معاً على معالج ضعيف.</p>
    <label class="switch-row"><input type="checkbox" id="m_cauto" ${ch?.autoStart ? 'checked' : ''}> تشغيل تلقائي عند إقلاع النظام</label>
    <label class="switch-row"><input type="checkbox" id="m_calwayson" ${ch?.alwaysOn ? 'checked' : ''}> تشغيل دائم 24/7 (لا يتوقف عند غياب المشاهدين)</label>
    <p class="hint">للتفعيل/التعطيل استخدم مربع «مفعّلة» في قائمة القنوات بجانب أزرار الإجراءات.</p>`,
    async () => {
      const body = {
        name: $('#m_cname').value.trim(), chanId: $('#m_cid').value.trim(),
        sourceId: $('#m_csource').value, category: $('#m_ccat').value.trim(),
        sort: Number($('#m_csort').value || 0), cover: $('#m_ccover').value.trim(),
        quality: $('#m_cquality').value,
        fps: $('#m_cfps').value || null,
        bitrate: $('#m_cbitrate').value || null,
        threads: $('#m_cthreads').value ? Number($('#m_cthreads').value) : null,
        autoStart: $('#m_cauto').checked, alwaysOn: $('#m_calwayson').checked
      };
      const saved = id
        ? await api('/channels/' + id, { method: 'PUT', body })
        : await api('/channels', { method: 'POST', body });
      await loadChannels();
      toast(saved && saved.restarted ? 'تم الحفظ وإعادة تشغيل القناة' : 'تم الحفظ');
    });
  // الجودة وFPS والمصدر تؤثر في حلّ «تلقائي»، فنعيد الحساب عند تغيير أي منها.
  ['#m_cquality', '#m_cfps', '#m_csource'].forEach((sel) => $(sel).addEventListener('change', refreshAutoLevelHint));
  refreshAutoLevelHint();
}

// =====================================================================
// DASHBOARD / MONITORING
// =====================================================================
async function refreshStatus() {
  let st;
  try { st = await api('/status'); } catch (e) { return; }
  refreshDashboard(); // بطاقات المقاييس (طلب /metrics منفصل خفيف)
  // header strip
  const liveCount = st.channels.filter(c => c.status === 'running').length;
  const strip = $('#onairStrip');
  strip.textContent = liveCount ? `ON AIR · ${liveCount}` : 'OFF AIR';
  strip.classList.toggle('live', liveCount > 0);
  _lastMsgs = st.messages || _lastMsgs; showSysMsg(_lastMsgs);
  showNginxBindWarning(st.nginxBinding);

  $('#sysStats').innerHTML = `
    <span class="stat-chip ${st.nginx ? 'good' : 'bad'}">Nginx: <b>${st.nginx ? 'يعمل' : 'متوقف'}</b></span>
    <span class="stat-chip good">الخادم: <b>${Math.floor(st.uptime / 60)} دقيقة</b></span>
    <span class="stat-chip">المعالج: <b>${Number.isFinite(st.cpuPercent) ? st.cpuPercent + '%' : '—'}</b></span>
    <span class="stat-chip">الذاكرة: <b>${Number.isFinite(st.memPercent) ? st.memPercent + '%' : st.memoryMB + ' MB'}</b></span>
    <span class="stat-chip ${st.license.valid ? 'good' : 'bad'}">الاشتراك: <b>${st.license.valid ? 'فعّال' : 'غير فعّال'}</b></span>`;

  $('#statusTable tbody').innerHTML = st.channels.map(c => `<tr>
    <td><b>${esc(c.name)}</b>${c.scheduled ? ' <span class="cell-muted">(مجدولة)</span>' : ''}</td>
    <td><span class="chip ${c.status}">${STATUS_LABELS[c.status] || c.status}</span></td>
    <td>${c.viewers}</td>
    <td>${fmtBytes(c.bytesOut)}</td>
    <td>${bitrateCell(c)}</td>
    <td>${c.restarts}</td>
    <td>${errCell(c)}</td>
    <td><div class="row-actions">
      <button class="btn btn-sm" onclick="chAction('${c.id}','start')">تشغيل</button>
      <button class="btn btn-sm" onclick="chAction('${c.id}','stop')">إيقاف</button>
      <button class="btn btn-sm" onclick="chAction('${c.id}','restart')">إعادة</button>
      <button class="btn btn-sm" onclick="showLog('${c.id}','${esc(c.name)}')">السجل</button>
    </div></td></tr>`).join('') || '<tr><td colspan="7" class="cell-muted">لا توجد قنوات.</td></tr>';

  // chips inside channels table
  st.channels.forEach(c => {
    const chip = $(`[data-chip="${c.id}"]`);
    if (chip) { chip.className = 'chip ' + c.status; chip.textContent = STATUS_LABELS[c.status] || c.status; }
  });

  if (currentLogChannel) loadLogBody(currentLogChannel);
}

async function showLog(id, name) {
  currentLogChannel = id;
  $('#logTitle').textContent = 'سجل القناة: ' + name;
  $('#logCard').classList.remove('hidden');
  await loadLogBody(id);
  $('#logCard').scrollIntoView({ behavior: 'smooth' });
}
async function loadLogBody(id) {
  try {
    const r = await api('/logs/' + id);
    const el = $('#logBody');
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    el.textContent = r.log || '(السجل فارغ)';
    if (atBottom) el.scrollTop = el.scrollHeight;
  } catch (e) {}
}
function hideLog() { currentLogChannel = null; $('#logCard').classList.add('hidden'); }

async function clearLog() {
  if (!currentLogChannel) return;
  if (!confirm('تصفير سجل هذه القناة؟ لا يمكن التراجع.')) return;
  try {
    await api('/logs/' + currentLogChannel + '/clear', { method: 'POST' });
    $('#logBody').textContent = '(السجل فارغ)';
    toast('تم تصفير السجل');
  } catch (e) { toast(e.message, true); }
}

function downloadLog() {
  if (!currentLogChannel) return;
  const a = document.createElement('a');
  a.href = '/api/logs/' + currentLogChannel + '/download';
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// خلية الأخطاء في لوحة المراقبة: تعرض فقط آخر خطأ خلال 10 دقائق (يأتي من الخادم
// كـ lastError أو null)، ملوّناً حسب الخطورة: أحمر = قاتل يمنع البث، أصفر = مشكلة
// شبكة قابلة للتعافي، رمادي = بطء/تأخّر مؤقّت. لا خطأ حديث ⇐ شرطة فقط.
function errCell(c) {
  const e = c.lastError;
  if (!e || !e.text) return '<span class="cell-muted">—</span>';
  const cls = { high: 'err-high', medium: 'err-medium', low: 'err-low' }[e.severity] || 'err-low';
  return `<div class="err-lines ${cls}" title="${esc((c.lastErrors || []).join('\n'))}">${esc(e.text)}</div>`;
}

// معدّل البت المضبوط للقناة بالكيلوبت (null حين لا يوجد معدّل ثابت: نسخ المصدر
// أو المستوى التلقائي الذي يُحسب من دقة الخرج).
function channelTargetKbps(c) {
  const q = String(c.quality || '').trim().toLowerCase();
  if (!q || q === 'copy' || q === 'source') return null;
  return bitrateLevel(c.bitrate).kbps;
}
// خلية جدول المراقبة: الفعلي مقابل المضبوط في إعدادات القناة، بالأحمر عند تجاوز
// المضبوط بأكثر من 25%: مقاطع TS تضيف عادةً 7–17% أشغال حاوية فوق معدّل الفيديو،
// فلا يُعدّ ذلك تجاوزاً، ويظهر بالأحمر التجاوز الحقيقي فقط.
function bitrateCell(c) {
  const q = String(c.quality || '').trim().toLowerCase();
  const label = (!q || q === 'copy' || q === 'source') ? 'نسخ المصدر' : bitrateLevel(c.bitrate).name;
  const actual = Number(c.outputBps) || 0;
  if (!actual) return `<span class="cell-muted">— / ${esc(label)}</span>`;
  const target = channelTargetKbps(c);
  const over = target ? actual * 8 > target * 1000 * 1.25 : false;
  return `<span class="bw-cell${over ? ' bw-over' : ''}" title="${over ? 'الفعلي يتجاوز المعدّل المضبوط بأكثر من 25%' : 'ضمن المعدّل المضبوط (يشمل أشغال الحاوية)'}">${fmtBps(actual)} <span class="cell-muted">/ ${esc(label)}</span></span>`;
}
// تسمية جودة القناة للعرض (copy = نسخ المصدر)
function qualityLabel(q) { return (!q || q === 'copy') ? 'نسخ المصدر' : (q === 'auto' ? 'تلقائي' : q); }
// تنسيق حجم البيانات بشكل مقروء
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function fmtBps(bps) {
  const bits = (Number(bps) || 0) * 8; // الباندويث يُعرض بالبت/ثانية
  if (bits < 1000) return bits.toFixed(0) + ' bps';
  if (bits < 1e6) return (bits / 1e3).toFixed(1) + ' Kbps';
  if (bits < 1e9) return (bits / 1e6).toFixed(2) + ' Mbps';
  return (bits / 1e9).toFixed(2) + ' Gbps';
}
function fmtDuration(sec) {
  sec = Number(sec) || 0;
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  if (d > 0) return `${d}ي ${h}س ${m}د`;
  if (h > 0) return `${h}س ${m}د ${s}ث`;
  if (m > 0) return `${m}د ${s}ث`;
  return `${s}ث`;
}
function dashCard(cls, ico, val, unit, label, sub, pulse) {
  return `<div class="dash-card ${cls}">
    <div class="dash-ico">${ico}</div>
    <div class="dash-val">${pulse ? '<span class="dash-pulse"></span>' : ''}${val}${unit ? `<small>${unit}</small>` : ''}</div>
    <div class="dash-lbl">${label}</div>
    ${sub ? `<div class="dash-sub">${sub}</div>` : ''}
  </div>`;
}
// لوحة مقاييس النظام: تُحدَّث مع كل نبضة حالة (كل 5ث) عبر /metrics.
async function refreshDashboard() {
  const grid = document.getElementById('dashGrid');
  if (!grid) return;
  let m;
  try { m = await api('/metrics'); } catch (e) { return; }
  // نسبة المعالج من عدّادات النظام الحقيقية (os.cpus)؛ معدل الحِمل loadavg ليس
  // نسبة استهلاك، وهو صفر دائماً على ويندوز فلا يصلح لهذه البطاقة.
  const cpuPct = Number.isFinite(m.cpuPercent) ? m.cpuPercent : 0;
  // ذاكرة النظام الحقيقية (إجمالي/مستخدم) من عدّادات نظام التشغيل عبر /metrics.
  const memTotal = Number(m.memTotalBytes) || 0;
  const memUsed = Number(m.memUsedBytes) || 0;
  const memPct = Number.isFinite(m.memPercent) ? m.memPercent : (memTotal ? Math.round((memUsed / memTotal) * 100) : 0);
  const memSub = memTotal
    ? `${m.cpuCount} نواة · الذاكرة ${fmtBytes(memUsed)} من ${fmtBytes(memTotal)} (${memPct}%)`
    : `${m.cpuCount} نواة · ذاكرة ${m.memoryMB} MB`;
  grid.innerHTML = [
    dashCard('green-accent', '⏱️', fmtDuration(m.uptimeSec), '', 'مدة التشغيل', 'منذ آخر إقلاع', false),
    dashCard('amber-accent', '🖥️', cpuPct, '%', 'استهلاك المعالج', memSub, false),
    dashCard('live-accent', '👁️', m.currentViewers, '', 'المشاهدون الآن', `يشاهدون ${m.watchedChannels} قناة`, m.currentViewers > 0),
    dashCard('blue-accent', '📊', m.totalViewers, '', 'إجمالي المشاهدين', 'منذ بدء التشغيل', false),
    dashCard('purple-accent', '📺', m.runningChannels, ` / ${m.totalChannels}`, 'قنوات تبثّ الآن', `${m.watchedChannels} منها مُشاهَدة`, m.runningChannels > 0),
    dashCard('green-accent', '⬇️', fmtBytes(m.hlsBytesTotal), '', 'بيانات HLS المُولّدة', 'إجمالي مقاطع m3u8', false),
    dashCard('live-accent', '⬆️', fmtBytes(m.egressBytesTotal), '', 'البيانات الخارجة للمشتركين', m.nginxLogActive ? 'مقاطع البث من سجلات Nginx' : 'من داخل الخادم', false),
    dashCard('green-accent', '🧮', fmtBytes(m.nginxBytesTotal), '', 'إجمالي البيانات عبر Nginx', m.nginxLogActive ? 'كل الاستجابات من السجل' : 'لا توجد سجلات Nginx', false),
    dashCard('blue-accent', '📡', fmtBps(m.ingestBandwidthBps), '', 'باندويث البث الحالي', 'مقاطع HLS المولّدة الآن', m.ingestBandwidthBps > 0),
    dashCard('amber-accent', '🌐', fmtBps(m.egressBandwidthBps), '', 'باندويث الخروج للمشاهدين', 'تقدير فعلي حالي', m.egressBandwidthBps > 0),
    dashCard('purple-accent', '🔌', m.internetBandwidthBps == null ? '—' : fmtBps(m.internetBandwidthBps), '', 'باندويث الإنترنت المستهلك', m.internetBandwidthBps == null ? 'غير متاح على هذا النظام' : ('وارد حالياً · الإجمالي ' + fmtBytes(m.internetRxBytesTotal)), m.internetBandwidthBps > 0)
  ].join('');
}

let _dismissedMsgs = JSON.parse(localStorage.getItem('amaan_msg_dismiss') || '[]');
function showSysMsg(list) {
  const bar = $('#sysMsgBar');
  if (!bar) return;
  const msgs = (Array.isArray(list) ? list : []).filter(m => m && m.text && !_dismissedMsgs.includes(m.id));
  if (!msgs.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.classList.remove('hidden');
  bar.classList.add('sys-msg-wrap');
  bar.innerHTML = msgs.map(m => `
    <div class="sys-msg ${m.level === 'warn' ? 'warn' : m.level === 'success' ? 'success' : ''}">
      <span class="sys-msg-icon">📢</span>
      <span class="sys-msg-text">${escHtml(m.text)}</span>
      <button class="sys-msg-close" onclick="dismissSysMsg('${m.id}')" title="إخفاء">✕</button>
    </div>`).join('');
}
function escHtml(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}

// تحذير تشخيصي: عملية nginx.exe قد تكون "موجودة" لكن فشلت في حجز المنفذ فعلياً
// (فشل صامت شائع على ويندوز — عادة حجز نظام ويندوز لنطاق منافذ عبر Hyper-V/WSL،
// لا علاقة له بتعدد عمليات nginx). يبقى ظاهراً بلا زر إخفاء حتى يُحَل فعلياً،
// فلا يفوت المدير مشكلة بث حقيقية بسبب إغلاقه بالخطأ.
function showNginxBindWarning(nb) {
  const bar = $('#nginxBindBar');
  if (!bar) return;
  if (!nb || nb.listening !== false || !nb.reason) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.classList.remove('hidden');
  bar.innerHTML = `<div class="sys-msg warn"><span class="sys-msg-icon">⚠️</span><span class="sys-msg-text"><b>Nginx لا يستجيب فعلياً على المنفذ ${nb.port}:</b> ${escHtml(nb.reason)}</span></div>`;
}
function dismissSysMsg(id) {
  if (id && !_dismissedMsgs.includes(id)) _dismissedMsgs.push(id);
  localStorage.setItem('amaan_msg_dismiss', JSON.stringify(_dismissedMsgs.slice(-50)));
  showSysMsg(_lastMsgs);
}
let _lastMsgs = [];
