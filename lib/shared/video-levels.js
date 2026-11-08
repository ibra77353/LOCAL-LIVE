'use strict';
// مستويات جودة الفيديو (Bitrate) — مصدر واحد لقيم FFmpeg الثلاث لكل مستوى.
// القيم مستقلة تماماً: -maxrate و-bufsize يأتيان من الجدول ولا يُشتقّان من -b:v.
// المستويات الأربعة المسمّاة هي الوحيدة المخزَّنة؛ «تلقائي» يحلّ إلى أحدها حسابياً
// من دقة الخرج ومعدل الإطارات (انظر autoVideoLevel)، فلا قيمة ثابتة تُسمّى تلقائية.

const VIDEO_BITRATE_LEVELS = [
  { id: 'auto', label: 'تلقائي حسب جودة الخرج', bitrate: '', maxrate: '', bufsize: '' },
  { id: 'economy', label: 'اقتصادي', bitrate: '300k', maxrate: '400k', bufsize: '600k' },
  { id: 'accepted', label: 'مقبول', bitrate: '400k', maxrate: '500k', bufsize: '700k' },
  { id: 'balanced', label: 'متوازن', bitrate: '500k', maxrate: '600k', bufsize: '800k' },
  { id: 'highest', label: 'أعلى', bitrate: '600k', maxrate: '700k', bufsize: '900k' }
];
// معامل الوضع التلقائي: بت لكل بكسل في الثانية. 0.1 نقطة بداية عملية لـ libx264
// بسرعة veryfast وzerolatency: صورة مقبولة بلا تضخيم الشبكة في المقاطع الهادئة.
const AUTO_BITS_PER_PIXEL = 0.1;

// يحوّل بِتريت نصياً (500k أو 2M أو 2000) إلى كيلوبت/ثانية؛ 0 لقيمة غير صالحة.
function bitrateKbps(value) {
  const text = String(value || '').trim().toLowerCase();
  const num = Number(text.replace(/[km]$/, ''));
  if (!Number.isFinite(num) || num <= 0) return 0;
  return /m$/.test(text) ? num * 1000 : Math.round(num);
}

function levelById(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return VIDEO_BITRATE_LEVELS.find(level => level.id === text) || null;
}

// قيمة القناة المحفوظة ← معرّف مستوى. '' و'auto' = تلقائي، والمعرّفات المعتمدة
// تُعاد كما هي، وقيم البِتريت القديمة (300k..600k) تُطابق مستوى بنفس -b:v.
// أي قيمة أخرى تُعيد '' ليرفضها التحقق بدل استخدام قيمة افتراضية صامتة.
function normalizeVideoLevel(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text || text === 'auto') return 'auto';
  const byId = levelById(text);
  if (byId) return byId.id;
  const legacy = VIDEO_BITRATE_LEVELS.find(level => level.bitrate && level.bitrate === text);
  return legacy ? legacy.id : '';
}

// «تلقائي»: الهدف = العرض × الارتفاع × FPS × AUTO_BITS_PER_PIXEL، ثم يُختار أصغر
// مستوى -b:v يغطي الهدف؛ وإن تجاوزه كل المستويات يُستخدم «أعلى» كسقف للجدول.
function autoVideoLevel(outputWidth, outputHeight, outputFps) {
  const width = Number(outputWidth) || 0;
  const height = Number(outputHeight) || 0;
  const fps = Number(outputFps) || 0;
  const targetKbps = Math.round((width * height * fps * AUTO_BITS_PER_PIXEL) / 1000);
  const named = VIDEO_BITRATE_LEVELS.filter(level => level.bitrate);
  const covering = named.find(level => bitrateKbps(level.bitrate) >= targetKbps);
  const level = covering || named[named.length - 1];
  return { level, targetKbps, clamped: !covering };
}

// الحل النهائي لقناة: المستوى الفعلي وقيمه الثلاث. autoTargetKbps غير null فقط
// في الوضع التلقائي، ليعرضه السجل عند بدء FFmpeg.
function resolveVideoLevel(value, { outputWidth, outputHeight, outputFps }) {
  const levelId = normalizeVideoLevel(value) || 'auto';
  if (levelId !== 'auto') return { level: levelById(levelId), autoTargetKbps: null };
  const auto = autoVideoLevel(outputWidth, outputHeight, outputFps);
  return { level: auto.level, autoTargetKbps: auto.targetKbps };
}

module.exports = { VIDEO_BITRATE_LEVELS, bitrateKbps, normalizeVideoLevel, autoVideoLevel, resolveVideoLevel };
