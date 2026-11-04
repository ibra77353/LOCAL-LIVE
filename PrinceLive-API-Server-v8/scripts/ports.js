'use strict';
// يطبع منفذ المشاهدة ومنفذ لوحة الإدارة من الإعدادات الفعلية على شكل: "<nginxPort> <port>"
// يستخدمه scripts/firewall.bat لفتح المنافذ الصحيحة في جدار الحماية.
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

const cfg = readJson('config.json');
const settings = readJson('settings.json');
const nginxPort = Number(settings.nginxPort) || Number(cfg.nginxPort) || 80;
const nodePort = Number(settings.port) || Number(cfg.port) || 3001;
process.stdout.write(`${nginxPort} ${nodePort}`);
