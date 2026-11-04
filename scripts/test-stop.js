'use strict';
// اختبار يحاكي ما يفعله scripts/stop.bat بالضبط:
//   1) يقرأ المنفذ من data.json (نفس مصدر ports.js)
//   2) يقرأ رمز التحكّم المحلي من run/control.token
//   3) يرسل POST /api/stop مع ترويسة X-Control-Token ويتحقق من النتيجة
// ونتحقق أيضاً أن الطلب بدون الرمز يُرفض بـ 401، وإلا فالاختبار لا يثبت شيئاً.
// الاستخدام: node scripts/test-stop.js [port]   — رمز الخروج: 0 نجاح، 1 فشل.
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const TOKEN_FILE = path.join(ROOT, 'run', 'control.token');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

const settings = readJson('data.json').settings || {};
const cfg = readJson('config.json');
const PORT = Number(process.argv[2]) || Number(settings.port) || Number(cfg.port) || 3001;

function stopRequest(token) {
  return new Promise(resolve => {
    const headers = { 'Content-Length': 0 };
    if (token) headers['X-Control-Token'] = token;
    const req = http.request({ host: HOST, port: PORT, path: '/api/stop', method: 'POST', headers, timeout: 5000 }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch {}
        resolve({ status: res.statusCode, body, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('انتهت مهلة الاتصال')));
    req.on('error', err => resolve({ error: err.message }));
    req.end();
  });
}

(async () => {
  const failures = [];
  console.log(`1) المنفذ المستخدم: ${PORT} (من data.json وconfig.json كما في ports.js)`);

  let token = '';
  try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
  if (!token) {
    console.error(`FAIL: تعذر قراءة run/control.token — شغّل الخادم أولاً (scripts\\start.bat).`);
    process.exit(1);
  }
  console.log(`2) قُرئ رمز التحكّم المحلي من run/control.token (${token.length} حرفاً)`);

  const anonymous = await stopRequest('');
  if (anonymous.error) {
    console.error(`FAIL: الخادم لا يستجيب على ${HOST}:${PORT} — ${anonymous.error}`);
    process.exit(1);
  }
  console.log(`3) طلب بدون رمز: HTTP ${anonymous.status}`);
  if (anonymous.status !== 401) failures.push(`الطلب بدون رمز لم يُرفض بـ 401 (جاء ${anonymous.status})؛ رمز التحكّم غير فعّال`);

  const authed = await stopRequest(token);
  if (authed.error) {
    console.error(`FAIL: تعذر إرسال طلب الإيقاف — ${authed.error}`);
    process.exit(1);
  }
  console.log(`4) طلب بالرمز: HTTP ${authed.status} ${authed.body}`);
  if (authed.status !== 200) failures.push(`طلب الإيقاف بالرمز فشل: HTTP ${authed.status}`);
  if (!authed.json || authed.json.ok !== true) failures.push('استجابة الإيقاف لا تحتوي ok:true');
  else if (!Array.isArray(authed.json.results)) failures.push('استجابة الإيقاف لا تحتوي مصفوفة results');

  if (failures.length) {
    console.error('STOP TEST FAILED');
    for (const line of failures) console.error(`- ${line}`);
    process.exit(1);
  }
  console.log('STOP TEST PASSED');
  console.log('الرمز المحلي يعمل، والطلب بدون رمز مرفوض، وأمر إيقاف كل القنوات قُبل من الخادم.');
})();
