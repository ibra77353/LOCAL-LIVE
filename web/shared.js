'use strict';
/* دوال مشتركة بين صفحة المشاهدة ولوحة التحكم (تُحمَّل قبلهما). */

// تهريب نص لإدراجه في HTML.
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// مسار صورة محفوظ في الإعدادات (srv/uploads/x) ← رابط يخدمه الخادم (/uploads/x).
function getAssetUrl(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^https?:\/\//i.test(s)) return s; // رابط خارجي
  if (s.startsWith('/')) return s;       // مسار مطلق
  return '/' + s.replace(/^srv\/uploads\/?/, 'uploads/').replace(/^\.?\/+/, '');
}
