'use strict';
// فحص استقرار المشروع بعد اعتماد لوحة AmaanLive وصفحة المشاهدة الجديدة.
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
  'nginx/conf/nginx.conf'
];
for (const file of required) if (!fs.existsSync(filePath(file))) failures.push(`ملف مفقود: ${file}`);

// 2) صيغة JavaScript
for (const file of ['server.js', 'web/admin.js', 'web/viewer.js']) {
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
  'x264Threads', 'x264QualityMode', 'hlsTime', 'hlsListSize', 'hlsDeleteThreshold', 'gopSeconds', 'outputWidth', 'outputHeight', 'outputFps', 'startupQueueDelayMs', 'startupConcurrency', 'autoRestartCrashed', 'maxRestarts', 'restartBackoffMs', 'hideCosmeticLogs',
  'playerMaxBufferLength', 'playerBackBufferLength', 'playerLiveSyncDuration', 'capLevelToPlayerSize',
  'cpuSaverDefault', 'ffmpegPath', 'ffprobePath', 'nginxPath', 'streamUserAgent', 'autoStartOnDemand', 'idleStopEnabled', 'idleStopMinutes',
  'sourceFailStopMinutes', 'blockedStopMinutes', 'logoImage', 'logoPosition', 'logoSizePct', 'logoOpacityPct'];
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
if (!/async function saveSettings[\s\S]{0,900}?api\('\/settings', \{ method: 'PUT'/.test(adminJs)) failures.push('web/admin.js لا يحفظ الإعدادات في /api/settings');
if (/amaan_settings|settings\.json/.test(adminJs)) failures.push('web/admin.js ما زال يستخدم مصدر إعدادات قديماً');

// 5) عناصر لوحة AmaanLive الأساسية
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

if (failures.length) {
  console.error('AmaanLive verification FAILED');
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('AmaanLive verification PASSED');
console.log(`Sources: ${data.sources.length}; channels: ${data.channels.length}; settings fields: ${S_KEYS.length}`);
console.log('JavaScript syntax, JSON schema, AmaanLive settings fields, admin sections, viewer API contract, and data integrity are valid.');
