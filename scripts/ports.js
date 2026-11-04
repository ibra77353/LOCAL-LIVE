'use strict';
// يطبع منفذ المشاهدة ومنفذ لوحة الإدارة من الإعدادات الفعلية على شكل: "<nginxPort> <port>"
// يستخدمه scripts/firewall.bat لفتح المنافذ الصحيحة في جدار الحماية.
// المصدر الوحيد: data.settings (نفس مصدر الخادم)، وconfig.json لا يحمل منفذاً.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

const settings = readJson('data.json').settings || {};
const nginxPort = Number(settings.nginxPort) || 80;
const nodePort = Number(settings.port) || 3001;
process.stdout.write(`${nginxPort} ${nodePort}\n`);
