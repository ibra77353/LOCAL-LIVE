'use strict';
// دالة تقييد رقمية مشتركة بين الخادم وطبقة الالتقاط.
// نُقلت حرفياً من server.js دون تغيير في الدلالات (تقريب، ثم حدّ أدنى/أعلى،
// وإرجاع القيمة الاحتياطية عند قيمة غير رقمية).

function clampNumber(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = { clampNumber };
