'use strict';
/* شعارات الأندية محليّة داخل المشروع: تُخزَّن في web/assets/teams ويُقرأ دليلها
   من team-logos.json، فيقدّم الخادم مساراً داخلياً (/assets/teams/...) بدل
   عنوان خارجي.
   أي فريق جديد يظهر في المصادر يُنزَّل شعاره تلقائياً إلى المشروع ويُضاف إلى
   الدليل قبل أن يُعاد الردّ، فإن فشل التنزيل بقي الشعار الخارجي كما هو ولم
   يتعطّل شيء. */

const fs = require('fs');
const path = require('path');
const https = require('https');

const { BROWSER_UA } = require('./http');

const MANIFEST_PATH = path.join(__dirname, 'team-logos.json');
const LOGOS_DIR = path.join(__dirname, '..', '..', 'web', 'assets', 'teams');
const PUBLIC_BASE = '/assets/teams';
const DOWNLOAD_TIMEOUT_MS = 8000;
// بعد فشل التنزيل لا نكرّره مع كل طلب، بل بعد هذه المدة.
const RETRY_MS = 10 * 60 * 1000;
const IMAGE_EXT = new Set(['.png', '.webp', '.jpg', '.jpeg', '.svg']);

// حروف لا يفكّها NFD إلى حرف + علامة، فتُستبدل يدوياً حتى لا يعتمد المفتاح على
// طريقة كتابة المصدر (Bodø/Glimt مقابل Bodo/Glimt).
const LETTERS = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', đ: 'd', ð: 'd', ł: 'l', þ: 'th' };

// توحيد الاسم للمقارنة بين المصادر: «Atlético Madrid» و«Atletico Madrid» و
// «ATLÉTICO MADRID» كلها مفتاح واحد.
function normalizeTeamName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[øæœßđðłþ]/gi, c => LETTERS[c.toLowerCase()] || c)
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function readManifest() {
  try {
    const raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

const manifest = readManifest();
const inFlight = new Map();
const failedAt = new Map();

function extOf(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return IMAGE_EXT.has(ext) ? ext : '.png';
  } catch {
    return '.png';
  }
}

// اسم الملف من الاسم الموحّد للفريق: يبقى ثابتاً حتى لو تغيّر رابط المصدر.
function fileName(key, url) {
  return (key.replace(/\s+/g, '-') || 'team') + extOf(url);
}

function downloadLogo(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: timeoutMs || DOWNLOAD_TIMEOUT_MS,
      headers: { 'User-Agent': BROWSER_UA, Accept: 'image/*' }
    }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (!buf.length) return reject(new Error('ملف فارغ'));
        resolve(buf);
      });
    });
    req.on('timeout', () => req.destroy(new Error('انتهت مهلة تحميل الشعار')));
    req.on('error', reject);
  });
}

function writeManifest() {
  try {
    const ordered = {};
    Object.keys(manifest).sort().forEach(key => { ordered[key] = manifest[key]; });
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(ordered, null, 2) + '\n');
  } catch {
    // مشروع للقراءة فقط: يبقى الدليل في الذاكرة وتعمل الشعارات حتى إعادة التشغيل.
  }
}

// المسار المحلي إن وُجد، وإلا الشعار الخارجي كما وصل من المصدر.
function localLogo(team, remote) {
  return manifest[normalizeTeamName(team)] || remote || '';
}

// الدليل قد يذكر ملفاً محذوفاً (نسخة ناقصة من المشروع): نتحقّق من وجوده فعلاً
// ونزيل السطر المعلّق كي يُنزَّل الشعار من جديد.
function hasLogoFile(key) {
  const rel = manifest[key];
  if (!rel) return false;
  try {
    return fs.statSync(path.join(LOGOS_DIR, path.basename(rel))).size > 0;
  } catch {
    delete manifest[key];
    return false;
  }
}

// تنزيل شعار فريق واحد إلى المشروع وتسجيله في الدليل.
async function saveLogo(key, url) {
  const file = fileName(key, url);
  const dest = path.join(LOGOS_DIR, file);
  const publicPath = `${PUBLIC_BASE}/${file}`;
  try {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      manifest[key] = publicPath;
      return publicPath;
    }
    const buf = await downloadLogo(url);
    fs.mkdirSync(LOGOS_DIR, { recursive: true });
    // كتابة ثم إعادة تسمية حتى لا يُخدَم ملف نصف مكتوب.
    const tmp = `${dest}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
    manifest[key] = publicPath;
    writeManifest();
    return publicPath;
  } catch {
    failedAt.set(key, Date.now());
    return '';
  }
}

// يضمن وجود نسخة محلية لكل فريق قبل عرضه: الموجود يُقرأ من الدليل، والجديد
// يُنزَّل الآن بالتوازي. يعيد عدد الشعارات التي أُضيفت فعلاً.
async function ensureLogos(teams) {
  const todo = [];
  const seen = new Set();
  (teams || []).forEach(({ team, logo }) => {
    const key = normalizeTeamName(team);
    if (!key || !/^https?:/i.test(logo || '') || hasLogoFile(key) || seen.has(key)) return;
    const at = failedAt.get(key);
    if (at && Date.now() - at < RETRY_MS) return;
    seen.add(key);
    todo.push({ key, logo });
  });
  if (!todo.length) return 0;
  const results = await Promise.all(todo.map(({ key, logo }) => {
    if (!inFlight.has(key)) inFlight.set(key, saveLogo(key, logo).finally(() => inFlight.delete(key)));
    return inFlight.get(key);
  }));
  return results.filter(Boolean).length;
}

module.exports = {
  MANIFEST_PATH,
  LOGOS_DIR,
  manifest,
  normalizeTeamName,
  fileName,
  localLogo,
  ensureLogos
};
