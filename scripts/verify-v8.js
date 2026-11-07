'use strict';
// فحص استقرار المشروع بعد اعتماد لوحة PrinceLive وصفحة المشاهدة الجديدة.
// يتحقق من: سلامة الملفات والصيغة، تطابق حقول الإعدادات بين اللوحة والبيانات،
// عناصر اللوحة الأساسية، عقد نقاط النهاية بين صفحة المشاهدة والخادم، وسلامة البيانات.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const failures = [];
const filePath = (file) => path.join(root, file);
const readText = (file) => fs.readFileSync(filePath(file), 'utf8').replace(/^\uFEFF/, '');

// 1) الملفات الأساسية المطلوبة للتشغيل
const required = [
  'server.js', 'config.json', 'data.json',
  'web/admin.html', 'web/admin.js', 'web/admin.css',
  'web/index.html', 'web/viewer.js', 'web/viewer.css', 'web/vendor/hls.min.js',
  'nginx/conf/nginx.conf', 'scripts/nginx-dirs.bat', 'nginx/temp/.gitkeep'
];
for (const file of required) if (!fs.existsSync(filePath(file))) failures.push(`ملف مفقود: ${file}`);

// 2) صيغة JavaScript
const syntaxFiles = ['server.js', 'web/admin.js', 'web/viewer.js'];
for (const dir of ['lib/capture', 'lib/shared']) {
  if (!fs.existsSync(filePath(dir))) continue;
  for (const file of fs.readdirSync(filePath(dir))) if (/\.js$/i.test(file)) syntaxFiles.push(`${dir}/${file}`);
}
for (const file of syntaxFiles) {
  if (!fs.existsSync(filePath(file))) continue;
  const result = spawnSync(process.execPath, ['--check', filePath(file)], { encoding: 'utf8' });
  if (result.status !== 0) failures.push(`فشل فحص JavaScript: ${file}\n${result.stderr}`);
}

// 3) صلاحية ملفات JSON ومخططها
const parsed = {};
for (const file of ['config.json', 'data.json']) {
  try { parsed[file] = JSON.parse(readText(file)); }
  catch (e) { failures.push(`JSON غير صالح: ${file}: ${e.message}`); }
}
const data = parsed['data.json'] || { sources: [], channels: [], settings: {} };
const cfg = parsed['config.json'] || {};
if (!Array.isArray(data.sources) || !Array.isArray(data.channels) || !data.settings) failures.push('مخطط data.json غير مكتمل');
if (!Number.isFinite(Number(data.settings.port))) failures.push('data.json يفتقد منفذاً رقمياً صالحاً في settings.port');

// 3.1) ملف واحد للحالة: settings.json لم يعد مستخدماً، وconfig.json للتمهيد فقط
if (fs.existsSync(filePath('settings.json'))) failures.push('settings.json ما زال موجوداً مع أن data.json هو المصدر الوحيد للإعدادات');
const bootstrapKeys = ['host', 'hlsRoot', 'admin'];
const duplicated = Object.keys(cfg).filter((key) => !bootstrapKeys.includes(key));
if (duplicated.length) failures.push(`config.json يحمل حقولاً مكررة مع data.settings: ${duplicated.join(', ')}`);

// 4) حقول قسم الإعدادات: S_KEYS في admin.js ↔ id="s_*" في admin.html ↔ بيانات data.json
const S_KEYS = ['siteName', 'siteNameLatin', 'logo', 'phone', 'theme', 'ticker', 'tickerEnabled', 'x264Preset',
  'port', 'nginxPort',
  'x264Threads', 'x264QualityMode', 'hlsTime', 'gopSeconds', 'hlsListSize', 'hlsDeleteThreshold', 'startupQueueDelayMs', 'startupConcurrency', 'autoRestartCrashed', 'maxRestarts', 'restartBackoffMs', 'hideCosmeticLogs',
  'playerMaxBufferLength', 'playerBackBufferLength', 'playerLiveSyncDuration', 'capLevelToPlayerSize',
  'cpuSaverDefault', 'ffmpegPath', 'ffprobePath', 'nginxPath', 'streamUserAgent', 'autoStartOnDemand', 'idleStopEnabled', 'idleStopMinutes',
  'sourceFailStopMinutes', 'blockedStopMinutes'];
const adminHtml = fs.existsSync(filePath('web/admin.html')) ? readText('web/admin.html') : '';
const adminJs = fs.existsSync(filePath('web/admin.js')) ? readText('web/admin.js') : '';
const declaredMatch = /const S_KEYS = \[([\s\S]*?)\];/.exec(adminJs);
const declared = declaredMatch ? [...declaredMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
if (!declared.length) failures.push('لم يتم العثور على قائمة S_KEYS في web/admin.js');
for (const key of S_KEYS) if (!declared.includes(key)) failures.push(`web/admin.js لا يقرأ أو يحفظ الحقل ${key}`);
for (const key of declared) if (!S_KEYS.includes(key)) failures.push(`حقل غير معروف في S_KEYS: ${key}`);
for (const key of S_KEYS) if (!adminHtml.includes(`id="s_${key}"`)) failures.push(`لوحة الإدارة تفتقد الحقل s_${key}`);
for (const key of S_KEYS) if (!(key in (data.settings || {}))) failures.push(`بيانات الإعدادات تفتقد المفتاح ${key}`);
// 4.1) الاتجاه المعاكس: كل حقل إعدادات في اللوحة يجب أن يكون في S_KEYS ليُعرض من data.json
const htmlSettingsKeys = [...new Set([...adminHtml.matchAll(/id="s_([A-Za-z0-9_]+)"/g)].map((match) => match[1]))];
for (const key of htmlSettingsKeys) if (!S_KEYS.includes(key)) failures.push(`حقل في اللوحة لا يُقرأ من data.json: s_${key}`);
// 4.2) اللوحة تقرأ وتحفظ الإعدادات عبر /api/settings وحدها (لا تخزين محلي ولا ملف آخر)
if (!/async function loadSettings[\s\S]{0,500}?api\('\/settings'\)/.test(adminJs)) failures.push('web/admin.js لا يقرأ الإعدادات من /api/settings');
if (!/async function saveSettings[\s\S]{0,900}?api\('\/settings', \{ method: 'POST'/.test(adminJs)) failures.push('web/admin.js لا يحفظ الإعدادات في /api/settings عبر POST');
if (/amaan_settings|settings\.json/.test(adminJs)) failures.push('web/admin.js ما زال يستخدم مصدر إعدادات قديماً');

// 5) عناصر لوحة PrinceLive الأساسية
const adminIds = ['view-dashboard', 'view-sources', 'view-channels', 'view-settings',
  'dashGrid', 'onairStrip', 'sourcesTable', 'channelsTable', 'statusTable', 'sysStats', 'sysMsgBar',
  'logBody', 'modalOverlay', 'modalBody', 'modalSave', 'modalError', 'toast', 'brandName', 'logoutBtn', 'restoreFileInput'];
for (const id of adminIds) if (!adminHtml.includes(`id="${id}"`)) failures.push(`لوحة الإدارة تفتقد العنصر ${id}`);

// 6) عقد صفحة المشاهدة مع الخادم
const viewerHtml = fs.existsSync(filePath('web/index.html')) ? readText('web/index.html') : '';
const viewerJs = fs.existsSync(filePath('web/viewer.js')) ? readText('web/viewer.js') : '';
const serverJs = fs.existsSync(filePath('server.js')) ? readText('server.js') : '';
// 6.1) الإعدادات تُقدَّم وتُحفظ من data.json فقط (settings: data.settings + writeData)
if (!serverJs.includes("'/api/settings' && req.method === 'GET'")) failures.push('server.js لا يقدّم /api/settings');
if (!/settings: data\.settings/.test(serverJs)) failures.push('server.js لا يقرأ الإعدادات من data.settings');
if (!/data\.settings\[key\] = /.test(serverJs)) failures.push('server.js لا يحدّث الإعدادات في data.settings');
for (const asset of ['/viewer.js', '/viewer.css', '/vendor/hls.min.js']) if (!viewerHtml.includes(asset)) failures.push(`صفحة المشاهدة لا تحمّل ${asset}`);
const viewerEndpoints = ['/api/public/settings', '/api/public/channels', '/api/public/channel-health', '/api/public/watch', '/api/public/heartbeat'];
const serverPublicEndpoints = [...viewerEndpoints, '/api/public/leave'];
for (const endpoint of viewerEndpoints) if (!viewerJs.includes(endpoint)) failures.push(`صفحة المشاهدة لا تستدعي ${endpoint}`);
for (const endpoint of serverPublicEndpoints) if (!serverJs.includes(`'${endpoint}'`)) failures.push(`server.js لا يعرّف ${endpoint}`);
if (!viewerJs.includes('viewerId') || !serverJs.includes('body.viewerId')) failures.push('حقل نبضة المشاهد غير متوافق بين viewer.js و server.js');

// 7) سلامة بيانات القنوات والمصادر
const sourceIds = new Set((data.sources || []).map((source) => source.id));
const channelIds = new Set();
for (const channel of data.channels || []) {
  if (!channel.id) failures.push(`القناة ${channel.name || '(بدون اسم)'} بلا معرّف`);
  if (channelIds.has(channel.id)) failures.push(`معرّف قناة مكرر: ${channel.id}`);
  channelIds.add(channel.id);
  if (channel.sourceId && !sourceIds.has(channel.sourceId)) failures.push(`مصدر القناة غير موجود: ${channel.name || channel.id}`);
  if (channel.url && channel.url !== `/hls/${channel.id}/index.m3u8`) failures.push(`مسار HLS غير متوافق للقناة ${channel.id}`);
}
for (const source of data.sources || []) if (!source.id || !source.type) failures.push(`إعداد المصدر ${source.name || '(بدون اسم)'} غير مكتمل`);

// 8) Nginx يمرّر الصفحة وواجهات API إلى خادم Node
if (serverJs && !readText('nginx/conf/nginx.conf').includes('proxy_pass http://127.0.0.1:')) failures.push('nginx.conf لا يمرّر الطلبات إلى خادم Node');
// 8b) مجلدات Nginx المؤقتة تُنشأ قبل أي فحص إعداد (وإلا فشل nginx -t بخطأ CreateDirectory على Windows)
for (const file of ['scripts/start.bat', 'scripts/restart-nginx.bat', 'scripts/check.bat']) {
  if (!readText(file).includes('nginx-dirs.bat')) failures.push(`${file} لا ينشئ مجلدات Nginx المؤقتة قبل الفحص`);
}

// 9) قيم حقول الإعدادات تُعرض صحيحة: النوع، وخيارات القوائم، وحدود min/max
const settingsView = (/<section id="view-settings"[\s\S]*?<\/section>/.exec(adminHtml) || [''])[0];
const fieldRe = /<(input|textarea|select)([^>]*)>/gi;
let fieldMatch;
while ((fieldMatch = fieldRe.exec(settingsView))) {
  const tag = fieldMatch[1].toLowerCase();
  const attrs = fieldMatch[2];
  const idMatch = /id="(s_[^"]*)"/.exec(attrs);
  if (!idMatch) continue;
  const key = idMatch[1].slice(2);
  const value = (data.settings || {})[key];
  const type = tag === 'input' ? ((/type="([^"]*)"/.exec(attrs) || [])[1] || 'text') : tag;
  if (type === 'checkbox') { if (typeof value !== 'boolean') failures.push(`الحقل ${key} اختيار لكن القيمة ليست منطقية`); continue; }
  if (tag === 'select') {
    const tail = settingsView.slice(fieldRe.lastIndex);
    const options = [...tail.slice(0, tail.indexOf('</select>')).matchAll(/<option(?:[^>]*value="([^"]*)")?[^>]*>([^<]*)/gi)]
      .map((option) => option[1] !== undefined ? option[1] : option[2].trim());
    if (!options.includes(String(value))) failures.push(`الحقل ${key}: القيمة "${value}" ليست من خيارات القائمة`);
    continue;
  }
  if (type === 'number' || type === 'range') {
    const number = Number(value);
    const min = (/min="([^"]*)"/.exec(attrs) || [])[1];
    const max = (/max="([^"]*)"/.exec(attrs) || [])[1];
    if (!Number.isFinite(number)) failures.push(`الحقل ${key}: قيمة غير رقمية`);
    else if (min !== undefined && number < Number(min)) failures.push(`الحقل ${key}: القيمة ${number} أقل من الحد min=${min}`);
    else if (max !== undefined && number > Number(max)) failures.push(`الحقل ${key}: القيمة ${number} أكبر من الحد max=${max}`);
    continue;
  }
  if (value === undefined) failures.push(`الحقل ${key}: لا توجد قيمة مخزنة ليُعرض`);
}

// 10) سكربتات Windows: مصدر منافذ واحد، عمليات PrinceLive فقط، وسجلات محفوظة
const scriptsDir = path.join(root, 'scripts');
const batScripts = fs.existsSync(scriptsDir)
  ? fs.readdirSync(scriptsDir).filter((name) => /\.bat$/i.test(name)).map((name) => `scripts/${name}`)
  : [];
const requiredScripts = ['start.bat', 'stop.bat', 'check.bat', 'devices.bat', 'firewall.bat', 'allow-lan.bat',
  'restart-nginx.bat', 'stop-nginx.bat', 'nginx-dirs.bat', 'nginx-stop.bat', 'check-v8.bat',
  'ports.js', 'procs.js', 'test-stop.js', 'verify-v8.js', 'devices.js'];
for (const name of requiredScripts) if (!fs.existsSync(filePath(`scripts/${name}`))) failures.push(`سكربت مفقود: scripts/${name}`);
// 10.1) كل ملف يقرأ المنافذ يجب أن يعتمد scripts\ports.js وحده (بلا افتراضي ثابت ثانٍ)
const portReaders = ['scripts/start.bat', 'scripts/stop.bat', 'scripts/check.bat', 'scripts/firewall.bat', 'scripts/restart-nginx.bat'];
for (const file of portReaders) {
  if (!fs.existsSync(filePath(file))) continue;
  const text = readText(file);
  if (!text.includes('scripts\\ports.js')) failures.push(`${file} لا يقرأ المنافذ من scripts\\ports.js`);
  const hardcoded = /(?:API_PORT|FW_PORT|NODE_PORT|NGINX_PORT)="?\s*(?:3001|80)\b/.exec(text.replace(/set\s+"/g, 'set "'));
  if (hardcoded) failures.push(`${file} يضع منفذاً افتراضياً ثابتاً (${hardcoded[1]}) بدل مصدر المنافذ الوحيد`);
}
// 10.2) لا إيقاف بالاسم: أي taskkill يجب أن يكون بمعرّف عملية محقّق
for (const file of batScripts) {
  const text = readText(file);
  if (/taskkill[^\r\n]*\/IM\b/i.test(text)) failures.push(`${file}: taskkill /IM يوقف كل عمليات الاسم نفسه وليس عمليات PrinceLive فقط`);
  if (/del\s+\/q\s+"?logs\\/i.test(text) || /rd\s+\/s\s+\/q\s+"?logs\b/i.test(text) || /del\s+\/q\s+"?nginx\\logs/i.test(text)) {
    failures.push(`${file}: يحذف سجلات التشغيل عند الإيقاف`);
  }
}
// 10.3) تمييز العمليات يمر عبر scripts\procs.js في كل سكربت يوقف أو يفحص
//       (nginx-stop.bat هو المسار المشترك لإيقاف Nginx، ويستخدم procs.js بنفسه)
for (const file of ['scripts/start.bat', 'scripts/stop.bat', 'scripts/stop-nginx.bat', 'scripts/restart-nginx.bat', 'scripts/check.bat', 'scripts/nginx-stop.bat']) {
  if (!fs.existsSync(filePath(file))) continue;
  const text = readText(file);
  if (!text.includes('procs.js') && !text.includes('nginx-stop.bat')) failures.push(`${file} لا يتحقق من ملكية العملية قبل إيقافها`);
}
// 10.4) start.bat يتحقق من استجابة الخادم ويرجع رمز فشل بدل إعلان نجاح كامل
if (fs.existsSync(filePath('scripts/start.bat'))) {
  const startBat = readText('scripts/start.bat');
  if (!startBat.includes('/api/status')) failures.push('scripts/start.bat لا يتحقق من استجابة /api/status');
  if (!/exit \/b 1/.test(startBat)) failures.push('scripts/start.bat لا يُرجع رمز فشل عند تعثر التشغيل');
  if (!/did NOT start completely/i.test(startBat)) failures.push('scripts/start.bat لا يميّز التشغيل الجزئي عن التشغيل الكامل');
}
// 10.5) الخادم يكتب معرّف عمليته ليستخدمه stop.bat
if (serverJs && !/server\.pid/.test(serverJs)) failures.push('server.js لا يكتب run\\server.pid اللازم لتمييز عملية PrinceLive');
// 10.6) المشروع Windows فقط: مجلدات التشغيل والالتقاط تحمل .bat و.js فقط
for (const dir of ['scripts', 'lib/capture']) {
  for (const file of fs.readdirSync(filePath(dir))) {
    if (!/\.(bat|js)$/i.test(file)) failures.push(`ملف غير مدعوم في ${dir}: ${file}`);
  }
}
// 10.7) أداة الأجهزة: devices.bat يفوّض إلى scripts/devices.js
if (fs.existsSync(filePath('scripts/devices.bat')) && !readText('scripts/devices.bat').includes('scripts\\devices.js')) {
  failures.push('scripts/devices.bat لا يستخدم أداة الأجهزة المشتركة scripts\\devices.js');
}

if (failures.length) {
  console.error('PrinceLive verification FAILED');
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('PrinceLive verification PASSED');
console.log(`Sources: ${data.sources.length}; channels: ${data.channels.length}; settings fields: ${S_KEYS.length}`);
console.log('JavaScript syntax, JSON schema, PrinceLive settings fields, admin sections, viewer API contract, and data integrity are valid.');
