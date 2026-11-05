'use strict';
/* البرنس لايف — منطق لوحة التحكم */

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// دالة موحدة لمعالجة مسارات الصور (نفس الدالة الموجودة في viewer.js)
function getAssetUrl(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^https?:\/\//i.test(s)) return s; // رابط خارجي
  if (s.startsWith('/')) return s;       // مسار مطلق
  return '/' + s.replace(/^srv\/uploads\/?/, 'uploads/').replace(/^\.?\/+/, '');
}

// جودة القناة الواحدة: نسخ المصدر (copy) ثم جودات الترميز.
const CH_QUALITIES = [
  ['copy', 'نسخ المصدر (بلا ترميز — الأخف والأعلى جودة)'],
  ['auto', 'تلقائي (أبعاد الخرج من الإعدادات)'],
  ['240p', '240p'], ['360p', '360p'], ['480p', '480p'], ['720p', '720p']
];
// مستويات CRF المتاحة لكل قناة (نفس قيم الإعدادات العامة).
const CH_CRF_LEVELS = [
  [18, '18 — جودة عالية جداً'], [20, '20 — جودة عالية'], [23, '23 — توازن جيد'],
  [26, '26 — جودة أقل'], [28, '28 — ضغط أكبر وجودة أقل']
];
// معدّلات البت المتاحة لكل قناة — تُعرض فقط عند اختيار وضع Bitrate.
const CH_BITRATES = [
  ['', 'حسب الافتراضي (من الإعدادات)'],
  ['500k', '500k — استهلاك منخفض'],
  ['800k', '800k — متوازن'],
  ['1200k', '1200k — جودة أعلى'],
  ['2000k', '2000k — جودة عالية']
];
const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const TYPE_LABELS = {
  usb: 'كرت التقاط (DirectShow / V4L2)', http: 'HTTP مباشر', hls: 'HLS / M3U8',
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
  setTimeout(updateBanner, 4000); // إشعار التحديث بعد الدخول
}

(async function init() {
  let authed = false;
  try { authed = (await fetch('/api/me').then(r => r.json())).authed === true; } catch (e) { authed = false; }
  if (!authed) { showLogin(); return; }
  showApp();
  try { await boot(); } catch (e) { console.error(e); toast(e.message, true); }
})();

// ---------------- Settings ----------------
const S_KEYS = ['siteName','siteNameLatin','logo','phone','theme','ticker','tickerEnabled','x264Preset',
  'port','nginxPort',
  'x264Threads','hlsTime','hlsListSize','hlsDeleteThreshold','gopSeconds','outputWidth','outputHeight','outputFps','startupQueueDelayMs','startupConcurrency','autoRestartCrashed','maxRestarts','restartBackoffMs','hideCosmeticLogs',
  'encodingMode','crfValue','defaultBitrate',
  'playerMaxBufferLength','playerBackBufferLength','playerLiveSyncDuration','capLevelToPlayerSize',
  'cpuSaverDefault','ffmpegPath','ffprobePath','nginxPath','streamUserAgent','autoStartOnDemand','idleStopEnabled','idleStopMinutes',
  'sourceFailStopMinutes','blockedStopMinutes','logoImage','logoPosition','logoSizePct','logoOpacityPct'];

// وضع الترميز: يُظهر حقول الوضع المختار فقط (Bitrate أو CRF) ويعرض القيمة المطبّقة.
function syncEncodingModeUI() {
  const modeEl = $('#s_encodingMode');
  const mode = modeEl ? modeEl.value : 'bitrate';
  const bitrateBox = $('#bitrateBox'), crfBox = $('#crfBox');
  if (bitrateBox) bitrateBox.style.display = mode === 'bitrate' ? '' : 'none';
  if (crfBox) crfBox.style.display = mode === 'crf' ? '' : 'none';
  const summary = $('#encModeSummary');
  if (!summary) return;
  // القيمة داخل اتجاه LTR حتى لا يعكس سياق RTL ترتيب «CRF 23» إلى «23 CRF».
  if (mode === 'crf') {
    const sel = $('#s_crfValue');
    const desc = sel && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent.split('—').slice(1).join('—').trim() : '';
    summary.innerHTML = 'الوضع المطبّق الآن: <span dir="ltr">CRF ' + (sel ? sel.value : '23') + '</span>' + (desc ? ' — ' + desc : '');
  } else {
    const bitrate = $('#s_defaultBitrate');
    summary.innerHTML = 'الوضع المطبّق الآن: <span dir="ltr">Bitrate ' + (bitrate && bitrate.value ? bitrate.value : 'حسب الجودة') + '</span> — معدّل بت ثابت';
  }
}
$('#s_encodingMode').addEventListener('change', syncEncodingModeUI);
$('#s_crfValue').addEventListener('change', syncEncodingModeUI);
$('#s_defaultBitrate').addEventListener('change', syncEncodingModeUI);

async function loadSettings() {
  const { settings, nginx } = await api('/settings');
  DATA.settings = settings;
  // مسار Nginx المحلول فعلياً من الإعدادات، مع تنبيه إن كان الملف غير موجود.
  const nginxNote = $('#nginxPathNote');
  if (nginxNote) {
    nginxNote.textContent = nginx && nginx.binary
      ? (nginx.binaryExists ? 'مسار Nginx المستخدم: ' : 'لم يُعثر على ملف Nginx في: ') + nginx.binary
      : '';
    nginxNote.classList.toggle('warn', !!(nginx && !nginx.binaryExists));
  }
  for (const k of S_KEYS) {
    const el = $('#s_' + k);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!settings[k]; else el.value = settings[k] ?? '';
  }
  syncEncodingModeUI();
  // حدّث تسميات نسب الشعار بجانب الأشرطة
  if ($('#logoSizeVal')) $('#logoSizeVal').textContent = (settings.logoSizePct ?? 10) + '٪';
  if ($('#logoOpacityVal')) $('#logoOpacityVal').textContent = (settings.logoOpacityPct ?? 50) + '٪';
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
    const r = await api('/settings', { method: 'PUT', body });
    toast('تم حفظ الإعدادات');
    loadSettings();
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
      box.innerHTML = `<p class="form-error">${esc(e.message)} — على ويندوز يلزم دعم DirectShow، وعلى لينكس يظهر الجهاز كـ /dev/video* (كرت UVC مع صلاحية وصول).</p>`;
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
      <td><span class="chip" data-chip="${c.id}">…</span></td>
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
      await loadSchedules();
      toast('تم الحذف');
    });
}

// وضع ترميز القناة: يظهر حقل الوضع المختار فقط (معدّل البت أو مستوى CRF)، ويبقى «افتراضي» بلا حقول.
function syncChannelEncodingUI() {
  const mode = $('#m_cencmode')?.value || '';
  const bitrateBox = $('#m_cbitrateBox');
  const crfBox = $('#m_ccrfBox');
  if (bitrateBox) bitrateBox.style.display = mode === 'bitrate' ? '' : 'none';
  if (crfBox) crfBox.style.display = mode === 'crf' ? '' : 'none';
  // مربّعا الشرح يظهران فقط عند اختيار وضع CRF أو CBR لهذه القناة.
  const infoCrf = $('#m_cencInfoCrf');
  const infoWarn = $('#m_cencInfoWarn');
  const showInfo = mode === 'crf' || mode === 'bitrate' ? '' : 'none';
  if (infoCrf) infoCrf.style.display = showInfo;
  if (infoWarn) infoWarn.style.display = showInfo;
}

function openChannelModal(id) {
  const ch = id ? DATA.channels.find(c => c.id === id) : null;
  const curQ = ch?.quality || (ch?.qualities && ch.qualities[0]) || 'copy';
  // معدّل بت القناة الحالي؛ إن كان خارج القائمة المعروضة يُضاف كخيار حتى لا تضيع قيمته عند الحفظ.
  const curBitrate = String(ch?.bitrate || '').trim();
  const bitrateOptions = CH_BITRATES.some(([v]) => v === curBitrate)
    ? CH_BITRATES
    : CH_BITRATES.concat([[curBitrate, curBitrate + ' — الحالي']]);
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
    <label>FPS الإخراج (اختياري — يُطبَّق عند الترميز فقط، تقليله يخفض استهلاك المعالج)<input class="input" id="m_cfps" type="number" min="10" max="60" value="${esc(ch?.fps)}"></label>
    <label>وضع الترميز لهذه القناة
      <select class="input" id="m_cencmode" onchange="syncChannelEncodingUI()">
        <option value="">افتراضي — يتبع وضع الإعدادات</option>
        <option value="bitrate" ${ch?.encodingMode === 'bitrate' ? 'selected' : ''}>CBR — معدّل بت ثابت</option>
        <option value="crf" ${ch?.encodingMode === 'crf' ? 'selected' : ''}>CRF — جودة ثابتة</option>
      </select></label>
    <label id="m_cbitrateBox">معدّل البت (Bitrate) لهذه القناة
      <select class="input" id="m_cbitrate" dir="ltr">
        ${bitrateOptions.map(([v, l]) => `<option value="${v}" ${curBitrate === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
    <label id="m_ccrfBox">مستوى CRF لهذه القناة
      <select class="input" id="m_ccrf">
        ${CH_CRF_LEVELS.map(([v, l]) => `<option value="${v}" ${Number(ch?.crfValue) === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
    <div id="m_cencInfoCrf" style="display:none; background: rgba(56,189,248,0.08); border: 1px solid rgba(56,189,248,0.2); border-radius: 8px; padding: 10px 12px; font-size: 0.82rem; color: rgb(56,189,248); line-height: 1.6; margin-bottom: 8px;">
      ℹ️ <b>وضع CRF :</b> يقلل استهلاك البيانات في المشاهد الهادئة (الاستديو) ويرفعه في المشاهد السريعة. سقف البتريت المحدد يمثل «أقصى حد مسموح» لمنع الضغط الزائد على الشبكة.
    </div>
    <div id="m_cencInfoWarn" style="display:none; background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.2); border-radius: 8px; padding: 10px 12px; font-size: 0.82rem; color: rgb(239,68,68); line-height: 1.6;">
      ⚠️ <b>العيوب :</b> تقطيع البث — أجهزة الأكسس بوينت الضعيفة أو المزدحمة بالتشويش لا تستطيع معالجة هذا الارتفاع المفاجئ، مما يؤدي إلى امتلاء الـ Buffer وتوقف الفيديو عند العميل.
    </div>
    <p class="hint">«افتراضي» يتبع وضع الترميز ومستوى CRF من الإعدادات العامة، واختيار وضع هنا يتجاوزها لهذه القناة وحدها. تُطبَّق الإعدادات فوراً: إن كانت القناة تعمل تُعاد للتشغيل تلقائياً بعد الحفظ. «CBR» يُظهر خيارات معدّل البت (أعلى = جودة أوضح واستهلاك شبكة أكبر)، و«CRF» يُظهر مستوى الجودة الثابتة.</p>
    <label class="switch-row"><input type="checkbox" id="m_cauto" ${ch?.autoStart ? 'checked' : ''}> تشغيل تلقائي عند إقلاع النظام</label>
    <label class="switch-row"><input type="checkbox" id="m_calwayson" ${ch?.alwaysOn ? 'checked' : ''}> تشغيل دائم 24/7 (لا يتوقف عند غياب المشاهدين)</label>
    <p class="hint">للتفعيل/التعطيل استخدم مربع «مفعّلة» في قائمة القنوات بجانب أزرار الإجراءات.</p>`,
    async () => {
      const body = {
        name: $('#m_cname').value.trim(), chanId: $('#m_cid').value.trim(),
        sourceId: $('#m_csource').value, category: $('#m_ccat').value.trim(),
        sort: Number($('#m_csort').value || 0), cover: $('#m_ccover').value.trim(),
        // خاصية الشعار معطَّلة من الخادم؛ نُبقي القيمة الحالية كما هي دون حقل في الواجهة.
        logoEnabled: ch?.logoEnabled != null ? ch.logoEnabled : !!ch?.logoOverlay,
        quality: $('#m_cquality').value,
        fps: $('#m_cfps').value || null,
        bitrate: $('#m_cbitrate').value || null,
        encodingMode: $('#m_cencmode').value,
        crfValue: $('#m_cencmode').value === 'crf' ? Number($('#m_ccrf').value) : null,
        autoStart: $('#m_cauto').checked, alwaysOn: $('#m_calwayson').checked
      };
      const saved = id
        ? await api('/channels/' + id, { method: 'PUT', body })
        : await api('/channels', { method: 'POST', body });
      await loadChannels();
      toast(saved && saved.restarted ? 'تم الحفظ وإعادة تشغيل القناة' : 'تم الحفظ');
    });
  syncChannelEncodingUI();
}

// =====================================================================
// SCHEDULER
// =====================================================================
async function loadSchedules() {
  const tb = $('#schedulesTable tbody');
  if (!tb) return; // لا يوجد جدول جدولة في هذه الواجهة
  DATA.schedules = (await api('/schedules')).schedules;
  const chName = id => DATA.channels.find(c => c.id === id)?.name || '؟';
  tb.innerHTML = DATA.schedules.map(s => `<tr>
    <td><b>${esc(chName(s.channelId))}</b></td>
    <td>${(s.days || []).map(d => DAYS[d]).join('، ') || 'كل الأيام'}</td>
    <td class="cell-muted" dir="ltr">${(s.slots || []).map(x => x.start + ' → ' + x.end).join(' | ')}</td>
    <td>${s.enabled !== false ? 'نعم' : 'لا'}</td>
    <td><div class="row-actions">
      <button class="btn btn-sm" onclick="openScheduleModal('${s.id}')">تعديل</button>
      <button class="btn btn-sm btn-danger" onclick="deleteSchedule('${s.id}')">حذف</button>
    </div></td></tr>`).join('') || '<tr><td colspan="5" class="cell-muted">لا توجد جداول — كل القنوات تعمل كبث مستمر.</td></tr>';
}

function slotRowHtml(s) {
  return `<div class="slot-row">
    <span>من</span><input class="input" style="width:110px" type="time" data-ss value="${esc(s.start)}">
    <span>إلى</span><input class="input" style="width:110px" type="time" data-se value="${esc(s.end)}">
    <button class="btn btn-sm btn-danger" type="button" onclick="this.parentElement.remove()">✕</button>
  </div>`;
}

function openScheduleModal(id) {
  const sc = id ? DATA.schedules.find(s => s.id === id) : null;
  const days = sc?.days || [0, 1, 2, 3, 4, 5, 6];
  const slots = sc?.slots?.length ? sc.slots : [{ start: '08:00', end: '10:00' }];
  openModal(id ? 'تعديل جدولة' : 'إضافة جدولة', `
    <label>القناة
      <select class="input" id="m_schChannel">
        ${DATA.channels.map(c => `<option value="${c.id}" ${sc?.channelId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('') || '<option value="">أضف قناة أولاً</option>'}
      </select></label>
    <label>الأيام<span class="days-checks">
      ${DAYS.map((d, i) => `<label><input type="checkbox" value="${i}" data-day ${days.includes(i) ? 'checked' : ''}>${d}</label>`).join('')}
    </span></label>
    <label>الفترات الزمنية (يمكن إضافة أكثر من فترة لنفس اليوم)</label>
    <div id="slotRows">${slots.map(slotRowHtml).join('')}</div>
    <button class="btn btn-sm" type="button" onclick="addSlotRow()">+ إضافة فترة</button>
    <label class="switch-row" style="margin-top:14px"><input type="checkbox" id="m_schEnabled" ${sc?.enabled !== false ? 'checked' : ''}> الجدولة مفعّلة</label>`,
    async () => {
      const body = {
        channelId: $('#m_schChannel').value,
        days: $$('input[data-day]:checked').map(i => Number(i.value)),
        slots: $$('#slotRows .slot-row').map(r => ({ start: $('[data-ss]', r).value, end: $('[data-se]', r).value }))
          .filter(s => s.start && s.end),
        enabled: $('#m_schEnabled').checked
      };
      if (id) await api('/schedules/' + id, { method: 'PUT', body });
      else await api('/schedules', { method: 'POST', body });
      await loadSchedules();
      toast('تم الحفظ');
    });
}
function addSlotRow() { $('#slotRows').insertAdjacentHTML('beforeend', slotRowHtml({ start: '', end: '' })); }

async function deleteSchedule(id) {
  try { await api('/schedules/' + id, { method: 'DELETE' }); loadSchedules(); }
  catch (e) { toast(e.message, true); }
}

// =====================================================================
// ADS (الإعلانات)
// =====================================================================
let _ads = [];
async function loadAds() {
  try { _ads = (await api('/ads')).ads || []; } catch (e) { return; }
  const placeLabel = a => a.type === 'text' ? '—' : (a.placement === 'underChannels' ? 'أسفل القنوات' : 'تحت الهاتف');
  const content = a => a.type === 'text'
    ? esc((a.text || '').slice(0, 60))
    : `<img src="${esc(getAssetUrl(a.image))}" style="height:34px;border-radius:4px">`;
  const rows = _ads.map(a => `<tr>
    <td>${a.type === 'text' ? 'نصّي' : 'صورة'}</td>
    <td>${content(a)}</td>
    <td>${placeLabel(a)}</td>
    <td><input type="checkbox" ${a.enabled !== false ? 'checked' : ''} onchange="toggleAd('${a.id}', this.checked)"></td>
    <td>
      <button class="btn btn-sm" onclick="openAdModal('${a.id}')">تعديل</button>
      <button class="btn btn-sm btn-danger" onclick="deleteAd('${a.id}')">حذف</button>
    </td></tr>`).join('');
  $('#adsTable').querySelector('tbody').innerHTML = rows || '<tr><td colspan="5" class="muted">لا توجد إعلانات بعد.</td></tr>';
}

function openAdModal(id) {
  const ad = id ? _ads.find(a => a.id === id) : null;
  const type = ad?.type || 'text';
  const body = `
    <label>نوع الإعلان
      <select class="input" id="ad_type" onchange="adTypeChanged()">
        <option value="text" ${type === 'text' ? 'selected' : ''}>نصّي (شريط متحرك تحت الهاتف)</option>
        <option value="image" ${type === 'image' ? 'selected' : ''}>صورة (سلايدر)</option>
      </select>
    </label>
    <div id="ad_textWrap">
      <label>نص الإعلان<input class="input" id="ad_text" value="${esc(ad?.text)}" placeholder="اكتب نص الإعلان هنا..."></label>
    </div>
    <div id="ad_imageWrap" class="hidden">
      <label>صورة الإعلان
        <div style="display:flex;gap:8px">
          <input class="input" id="ad_image" value="${esc(ad?.image)}" placeholder="srv/uploads/ad.jpg" style="flex:1">
          <button type="button" class="btn" onclick="browseUpload('ad_image','image/*')">استعراض</button>
        </div>
      </label>
      <label>مكان عرض السلايدر
        <select class="input" id="ad_placement">
          <option value="underPhone" ${ad?.placement !== 'underChannels' ? 'selected' : ''}>تحت رقم الهاتف</option>
          <option value="underChannels" ${ad?.placement === 'underChannels' ? 'selected' : ''}>أسفل أزرار القنوات</option>
        </select>
      </label>
    </div>
    <label>رابط عند الضغط (اختياري)<input class="input" id="ad_link" value="${esc(ad?.link)}" placeholder="https://..."></label>
    <label class="switch-row"><input type="checkbox" id="ad_enabled" ${ad?.enabled !== false ? 'checked' : ''}> مفعّل</label>`;
  openModal(id ? 'تعديل إعلان' : 'إضافة إعلان', body, async () => {
    const payload = {
      type: $('#ad_type').value,
      text: $('#ad_text').value.trim(),
      image: $('#ad_image').value.trim(),
      placement: $('#ad_placement').value,
      link: $('#ad_link').value.trim(),
      enabled: $('#ad_enabled').checked
    };
    if (id) await api('/ads/' + id, { method: 'PUT', body: payload });
    else await api('/ads', { method: 'POST', body: payload });
    await loadAds();
    toast('تم الحفظ');
  });
  adTypeChanged();
}
function adTypeChanged() {
  const t = $('#ad_type').value;
  $('#ad_textWrap').classList.toggle('hidden', t !== 'text');
  $('#ad_imageWrap').classList.toggle('hidden', t !== 'image');
}
async function toggleAd(id, enabled) {
  try { await api('/ads/' + id, { method: 'PUT', body: { enabled } }); }
  catch (e) { toast(e.message, true); loadAds(); }
}
async function deleteAd(id) {
  if (!confirm('حذف هذا الإعلان؟')) return;
  try { await api('/ads/' + id, { method: 'DELETE' }); loadAds(); toast('تم الحذف'); }
  catch (e) { toast(e.message, true); }
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
    dashCard('blue-accent', '📡', fmtBps(m.ingestBandwidthBps), '', 'باندويث البث الحالي', 'وارد من المصادر', m.ingestBandwidthBps > 0),
    dashCard('amber-accent', '🌐', fmtBps(m.egressBandwidthBps), '', 'باندويث الخروج للمشاهدين', 'تقدير فعلي حالي', m.egressBandwidthBps > 0),
    dashCard('purple-accent', '🔌', m.internetBandwidthBps == null ? '—' : fmtBps(m.internetBandwidthBps), '', 'باندويث الإنترنت المستهلك', m.internetBandwidthBps == null ? 'غير متاح على هذا النظام' : ('وارد حالياً · الإجمالي ' + fmtBytes(m.internetRxBytesTotal)), m.internetBandwidthBps > 0)
  ].join('');
}

// =====================================================================
// LICENSE
// =====================================================================
async function loadLicense() {
  const res = await api('/license');
  const license = res.license;
  const contact = res.contact || {};
  _lastMsgs = res.messages || []; showSysMsg(_lastMsgs);
  const fmt = ts => ts ? new Date(ts).toLocaleString('ar-SA') : '—';
  let statusText, statusColor;
  if (license.valid && license.isTrial) {
    statusText = `فترة تجريبية — متبقٍّ ${license.daysLeft} ${license.daysLeft === 1 ? 'يوم' : 'أيام'}`;
    statusColor = '#E0A82E';
  } else if (license.valid) {
    statusText = 'الاشتراك فعّال'; statusColor = 'var(--ok)';
  } else if (license.activated) {
    statusText = license.isTrial ? 'انتهت الفترة التجريبية — يرجى شراء ترخيص' : 'الاشتراك منتهي';
    statusColor = 'var(--live)';
  } else {
    statusText = 'غير مفعّل'; statusColor = 'var(--live)';
  }
  // أزرار التواصل للشراء
  const contactBtns = () => {
    let h = '';
    if (contact.whatsapp) h += `<a class="buy-btn wa" href="https://wa.me/${esc(contact.whatsapp.replace(/[^0-9]/g, ''))}" target="_blank">📱 واتساب للاشتراك</a>`;
    if (contact.phone) h += `<a class="buy-btn" href="tel:${esc(contact.phone)}">📞 ${esc(contact.phone)}</a>`;
    return h;
  };
  // لافتة حسب الحالة
  let banner = '';
  if (license.isTrial && license.valid) {
    banner = `<div class="trial-banner">أنت تستخدم النسخة التجريبية (${license.daysLeft} ${license.daysLeft === 1 ? 'يوم' : 'أيام'} متبقية). للاستمرار بعد انتهائها، احصل على اشتراك.${contact.note ? '<br>' + esc(contact.note) : ''}<div class="buy-row">${contactBtns()}</div></div>`;
  } else if (!license.valid && license.activated) {
    banner = `<div class="trial-banner ended"><b>${license.isTrial ? 'انتهت فترتك التجريبية' : 'انتهى اشتراكك'}.</b> للاستمرار في استخدام النظام، يرجى تجديد الاشتراك.${contact.note ? '<br>' + esc(contact.note) : ''}<div class="buy-row">${contactBtns()}</div></div>`;
  } else if (license.valid && !license.isTrial && license.daysLeft != null && license.daysLeft <= 3) {
    banner = `<div class="trial-banner">⏳ اشتراكك ينتهي بعد ${license.daysLeft} ${license.daysLeft === 1 ? 'يوم' : 'أيام'}. جدّد الآن لتجنّب انقطاع الخدمة.<div class="buy-row">${contactBtns()}</div></div>`;
  }
  $('#licenseStatus').innerHTML = banner + `
    <div><span class="lbl">الحالة: </span><b style="color:${statusColor}">${statusText}</b></div>
    <div><span class="lbl">معرّف هذا الجهاز (أرسله لمزوّد الخدمة): </span><div class="val">${esc(license.deviceId)}</div></div>
    <div><span class="lbl">المفتاح: </span><span class="val">${esc(license.key || '—')}</span></div>
    <div><span class="lbl">ينتهي في: </span>${fmt(license.expiresAt)}</div>
    <div><span class="lbl">آخر تحقق: </span>${fmt(license.lastCheck)}</div>`;
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

async function activateLicense() {
  $('#licMsg').textContent = '';
  try {
    await api('/license/activate', { method: 'POST', body: { key: $('#lic_key').value.trim() } });
    toast('تم تفعيل الاشتراك');
    loadLicense();
  } catch (e) { $('#licMsg').textContent = e.message; }
}

// =====================================================================
// SYSTEM UPDATE
// =====================================================================
async function checkUpdate(force) {
  try {
    const u = await api('/update/status' + (force ? '?force=1' : ''));
    const box = $('#updateStatus');
    if (u.available) {
      box.innerHTML = `
        <div><span class="lbl">الإصدار الحالي: </span><span class="val">${esc(u.currentVersion)}</span></div>
        <div><b style="color:var(--brass)">يتوفر تحديث جديد: الإصدار ${esc(u.latestVersion)}${u.mandatory ? ' (إجباري)' : ''}</b></div>
        ${u.changelog ? `<div><span class="lbl">ما الجديد: </span>${esc(u.changelog)}</div>` : ''}`;
      $('#applyUpdateBtn').classList.remove('hidden');
    } else {
      box.innerHTML = `
        <div><span class="lbl">الإصدار الحالي: </span><span class="val">${esc(u.currentVersion)}</span></div>
        <div><b style="color:var(--ok)">النظام محدَّث ✓</b></div>`;
      $('#applyUpdateBtn').classList.add('hidden');
    }
    return u;
  } catch (e) { return null; }
}

async function applyUpdate() {
  if (!confirm('سيتم إيقاف البث مؤقتاً وتنزيل التحديث ثم إعادة تشغيل النظام تلقائياً. متابعة؟')) return;
  $('#updMsg').textContent = '';
  const btn = $('#applyUpdateBtn');
  btn.disabled = true; btn.textContent = 'جارٍ التحديث...';
  try {
    const r = await api('/update/apply', { method: 'POST', body: {} });
    toast(r.message || 'تم التحديث');
    $('#updateStatus').innerHTML = '<div><b style="color:var(--ok)">تم التحديث إلى ' + esc(r.to) + ' — يُعاد تشغيل النظام، حدّث الصفحة بعد لحظات.</b></div>';
    setTimeout(() => location.reload(), 12000);
  } catch (e) {
    $('#updMsg').textContent = e.message;
    btn.disabled = false; btn.textContent = 'تحديث الآن';
  }
}

/** إشعار عام عند توفر تحديث (يظهر بعد الدخول) */
async function updateBanner() {
  const u = await checkUpdate(false);
  if (u && u.available) {
    toast('🔔 يتوفر تحديث جديد للنظام (الإصدار ' + u.latestVersion + ') — من قائمة الاشتراك والترخيص');
  }
}