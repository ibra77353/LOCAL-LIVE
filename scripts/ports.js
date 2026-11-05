'use strict';
// مصدر المنافذ الوحيد لكل سكربتات Windows (start/stop/check/firewall) والخادم.
// يتبع نفس ترتيب الأولوية المستخدم في server.js حتى لا يختلف المنفذ الذي يوقف
// السكربت خادماً يعمل على منفذ آخر:
//   Node:  PORT (بيئة) ← data.settings.port ← config.port ← 3001
//   Nginx: data.settings.nginxPort ← config.nginxPort ← 80
// المخرجات: "<nginxPort> <nodePort>" في سطر واحد تقرأه ملفات BAT بـ tokens=1,2.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}
// نفس قاعدة server.js: أي قيمة غير رقمية أو خارج نطاق المنافذ تُستبدل بالافتراضي.
function toPort(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

const data = readJson('data.json');
const settings = data && data.settings ? data.settings : null;
const cfg = readJson('config.json') || {};

// عند تعذّر قراءة data.json يعيد server.js إنشاءه من config.json، فنقرأ config هنا أيضاً.
const nginxPort = toPort(settings ? settings.nginxPort : cfg.nginxPort, toPort(cfg.nginxPort, 80));
const envPort = String(process.env.PORT || '').trim();
const nodePort = envPort
  ? toPort(envPort, 3001)
  : toPort(settings ? settings.port : cfg.port, 3001);

process.stdout.write(`${nginxPort} ${nodePort}\n`);
