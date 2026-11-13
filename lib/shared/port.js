'use strict';
// قاعدة واحدة لكل من الخادم وسكربتات Windows: أي قيمة ليست منفذاً صحيحاً
// (1..65535) تُستبدل بالافتراضي بدل تمرير NaN إلى دالة الاستماع.
function resolvePort(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

module.exports = { resolvePort };
