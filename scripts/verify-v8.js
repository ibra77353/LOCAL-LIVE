'use strict';
// Project stability check after the new PrinceLive admin panel and viewer page.
// Verifies: file integrity and syntax, settings fields matching between panel and data,
// the core panel elements, the endpoint contract between viewer page and server, and data integrity.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const failures = [];
const filePath = (file) => path.join(root, file);
const readText = (file) => fs.readFileSync(filePath(file), 'utf8').replace(/^\uFEFF/, '');

// 1) Core files required to run
const required = [
  'server.js', 'config.json', 'data.json',
  'web/admin.html', 'web/admin.js', 'web/admin.css',
  'web/index.html', 'web/viewer.js', 'web/viewer.css', 'web/vendor/hls.min.js',
  'nginx/conf/nginx.conf', 'scripts/nginx-dirs.bat', 'nginx/temp/.gitkeep'
];
for (const file of required) if (!fs.existsSync(filePath(file))) failures.push(`missing file: ${file}`);

// 2) JavaScript syntax
for (const file of ['server.js', 'web/admin.js', 'web/viewer.js']) {
  if (!fs.existsSync(filePath(file))) continue;
  const result = spawnSync(process.execPath, ['--check', filePath(file)], { encoding: 'utf8' });
  if (result.status !== 0) failures.push(`JavaScript syntax check failed: ${file}\n${result.stderr}`);
}

// 3) JSON file validity and schema
const parsed = {};
for (const file of ['config.json', 'data.json']) {
  try { parsed[file] = JSON.parse(readText(file)); }
  catch (e) { failures.push(`invalid JSON: ${file}: ${e.message}`); }
}
const data = parsed['data.json'] || { sources: [], channels: [], settings: {} };
const cfg = parsed['config.json'] || {};
if (!Array.isArray(data.sources) || !Array.isArray(data.channels) || !data.settings) failures.push('data.json schema is incomplete');
if (!Number.isFinite(Number(data.settings.port))) failures.push('data.json is missing a valid numeric port in settings.port');

// 3.1) Single state file: settings.json is no longer used, config.json is bootstrap only
if (fs.existsSync(filePath('settings.json'))) failures.push('settings.json still exists although data.json is the only settings source');
const bootstrapKeys = ['host', 'hlsRoot', 'admin'];
const duplicated = Object.keys(cfg).filter((key) => !bootstrapKeys.includes(key));
if (duplicated.length) failures.push(`config.json carries fields duplicated with data.settings: ${duplicated.join(', ')}`);

// 4) Settings fields: S_KEYS in admin.js <-> id="s_*" in admin.html <-> data.json
const S_KEYS = ['siteName', 'siteNameLatin', 'logo', 'phone', 'theme', 'ticker', 'tickerEnabled', 'x264Preset',
  'port', 'nginxPort',
  'x264Threads', 'hlsTime', 'hlsListSize', 'hlsDeleteThreshold', 'gopSeconds', 'outputWidth', 'outputHeight', 'outputFps', 'startupQueueDelayMs', 'startupConcurrency', 'autoRestartCrashed', 'maxRestarts', 'restartBackoffMs', 'hideCosmeticLogs',
  'encodingMode', 'crfValue', 'defaultBitrate',
  'playerMaxBufferLength', 'playerBackBufferLength', 'playerLiveSyncDuration', 'capLevelToPlayerSize',
  'cpuSaverDefault', 'ffmpegPath', 'ffprobePath', 'nginxPath', 'streamUserAgent', 'autoStartOnDemand', 'idleStopEnabled', 'idleStopMinutes',
  'sourceFailStopMinutes', 'blockedStopMinutes', 'logoImage', 'logoPosition', 'logoSizePct', 'logoOpacityPct'];
const adminHtml = fs.existsSync(filePath('web/admin.html')) ? readText('web/admin.html') : '';
const adminJs = fs.existsSync(filePath('web/admin.js')) ? readText('web/admin.js') : '';
const declaredMatch = /const S_KEYS = \[([\s\S]*?)\];/.exec(adminJs);
const declared = declaredMatch ? [...declaredMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
if (!declared.length) failures.push('could not find the S_KEYS list in web/admin.js');
for (const key of S_KEYS) if (!declared.includes(key)) failures.push(`web/admin.js does not read or save the field ${key}`);
for (const key of declared) if (!S_KEYS.includes(key)) failures.push(`unknown field in S_KEYS: ${key}`);
for (const key of S_KEYS) if (!adminHtml.includes(`id="s_${key}"`)) failures.push(`admin panel is missing the field s_${key}`);
for (const key of S_KEYS) if (!(key in (data.settings || {}))) failures.push(`settings data is missing the key ${key}`);
// 4.1) Reverse direction: every settings field in the panel must be in S_KEYS to render from data.json
const htmlSettingsKeys = [...new Set([...adminHtml.matchAll(/id="s_([A-Za-z0-9_]+)"/g)].map((match) => match[1]))];
for (const key of htmlSettingsKeys) if (!S_KEYS.includes(key)) failures.push(`panel field is not read from data.json: s_${key}`);
// 4.2) The panel reads and saves settings through /api/settings only (no local storage, no other file)
if (!/async function loadSettings[\s\S]{0,500}?api\('\/settings'\)/.test(adminJs)) failures.push('web/admin.js does not read settings from /api/settings');
if (!/async function saveSettings[\s\S]{0,900}?api\('\/settings', \{ method: 'PUT'/.test(adminJs)) failures.push('web/admin.js does not save settings to /api/settings');
if (/amaan_settings|settings\.json/.test(adminJs)) failures.push('web/admin.js still uses an old settings source');

// 5) Core PrinceLive admin panel elements
const adminIds = ['view-dashboard', 'view-sources', 'view-channels', 'view-settings',
  'dashGrid', 'onairStrip', 'sourcesTable', 'channelsTable', 'statusTable', 'sysStats', 'sysMsgBar',
  'logBody', 'modalOverlay', 'modalBody', 'modalSave', 'modalError', 'toast', 'brandName', 'logoutBtn', 'restoreFileInput'];
for (const id of adminIds) if (!adminHtml.includes(`id="${id}"`)) failures.push(`admin panel is missing the element ${id}`);

// 6) Viewer page contract with the server
const viewerHtml = fs.existsSync(filePath('web/index.html')) ? readText('web/index.html') : '';
const viewerJs = fs.existsSync(filePath('web/viewer.js')) ? readText('web/viewer.js') : '';
const serverJs = fs.existsSync(filePath('server.js')) ? readText('server.js') : '';
// 6.1) Settings are served and saved from data.json only (settings: data.settings + writeData)
if (!serverJs.includes("'/api/settings' && req.method === 'GET'")) failures.push('server.js does not serve /api/settings');
if (!/settings: data\.settings/.test(serverJs)) failures.push('server.js does not read settings from data.settings');
if (!/data\.settings\[key\] = /.test(serverJs)) failures.push('server.js does not update settings in data.settings');
for (const asset of ['/viewer.js', '/viewer.css', '/vendor/hls.min.js']) if (!viewerHtml.includes(asset)) failures.push(`viewer page does not load ${asset}`);
const viewerEndpoints = ['/api/public/settings', '/api/public/channels', '/api/public/channel-health', '/api/public/watch', '/api/public/heartbeat'];
const serverPublicEndpoints = [...viewerEndpoints, '/api/public/leave'];
for (const endpoint of viewerEndpoints) if (!viewerJs.includes(endpoint)) failures.push(`viewer page does not call ${endpoint}`);
for (const endpoint of serverPublicEndpoints) if (!serverJs.includes(`'${endpoint}'`)) failures.push(`server.js does not define ${endpoint}`);
if (!viewerJs.includes('viewerId') || !serverJs.includes('body.viewerId')) failures.push('viewer heartbeat field is inconsistent between viewer.js and server.js');

// 7) Channel and source data integrity
const sourceIds = new Set((data.sources || []).map((source) => source.id));
const channelIds = new Set();
for (const channel of data.channels || []) {
  if (!channel.id) failures.push(`channel ${channel.name || '(no name)'} has no id`);
  if (channelIds.has(channel.id)) failures.push(`duplicate channel id: ${channel.id}`);
  channelIds.add(channel.id);
  if (channel.sourceId && !sourceIds.has(channel.sourceId)) failures.push(`channel source does not exist: ${channel.name || channel.id}`);
  if (channel.url && channel.url !== `/hls/${channel.id}/index.m3u8`) failures.push(`HLS path is inconsistent for channel ${channel.id}`);
}
for (const source of data.sources || []) if (!source.id || !source.type) failures.push(`source ${source.name || '(no name)'} configuration is incomplete`);

// 8) Nginx forwards the page and the API endpoints to the Node server
if (serverJs && !readText('nginx/conf/nginx.conf').includes('proxy_pass http://127.0.0.1:')) failures.push('nginx.conf does not forward requests to the Node server');
// 8b) Nginx temp folders are created before any config check (otherwise nginx -t fails with CreateDirectory on Windows)
for (const file of ['scripts/start.bat', 'scripts/restart-nginx.bat', 'scripts/check.bat']) {
  if (!readText(file).includes('nginx-dirs.bat')) failures.push(`${file} does not create the Nginx temp folders before the check`);
}

// 9) Settings values render correctly: type, list options, and min/max limits
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
  if (type === 'checkbox') { if (typeof value !== 'boolean') failures.push(`field ${key} is a checkbox but the value is not boolean`); continue; }
  if (tag === 'select') {
    const tail = settingsView.slice(fieldRe.lastIndex);
    const options = [...tail.slice(0, tail.indexOf('</select>')).matchAll(/<option(?:[^>]*value="([^"]*)")?[^>]*>([^<]*)/gi)]
      .map((option) => option[1] !== undefined ? option[1] : option[2].trim());
    if (!options.includes(String(value))) failures.push(`field ${key}: value "${value}" is not one of the list options`);
    continue;
  }
  if (type === 'number' || type === 'range') {
    const number = Number(value);
    const min = (/min="([^"]*)"/.exec(attrs) || [])[1];
    const max = (/max="([^"]*)"/.exec(attrs) || [])[1];
    if (!Number.isFinite(number)) failures.push(`field ${key}: value is not numeric`);
    else if (min !== undefined && number < Number(min)) failures.push(`field ${key}: value ${number} is below min=${min}`);
    else if (max !== undefined && number > Number(max)) failures.push(`field ${key}: value ${number} is above max=${max}`);
    continue;
  }
  if (value === undefined) failures.push(`field ${key}: no stored value to render`);
}

// 10) Windows scripts: single port source, PrinceLive processes only, and logs preserved
const scriptsDir = path.join(root, 'scripts');
const batScripts = fs.existsSync(scriptsDir)
  ? fs.readdirSync(scriptsDir).filter((name) => /\.bat$/i.test(name)).map((name) => `scripts/${name}`)
  : [];
const requiredScripts = ['start.bat', 'stop.bat', 'check.bat', 'devices.bat', 'firewall.bat', 'allow-lan.bat',
  'restart-nginx.bat', 'stop-nginx.bat', 'nginx-dirs.bat', 'nginx-stop.bat', 'check-v8.bat',
  'ports.js', 'procs.js', 'test-stop.js', 'verify-v8.js', 'devices.js',
  'start.sh', 'stop.sh', 'check.sh', 'devices.sh'];
for (const name of requiredScripts) if (!fs.existsSync(filePath(`scripts/${name}`))) failures.push(`missing script: scripts/${name}`);
// 10.1) Every file that reads ports must rely on scripts\ports.js alone (no second hardcoded default)
const portReaders = ['scripts/start.bat', 'scripts/stop.bat', 'scripts/check.bat', 'scripts/firewall.bat', 'scripts/restart-nginx.bat'];
for (const file of portReaders) {
  if (!fs.existsSync(filePath(file))) continue;
  const text = readText(file);
  if (!text.includes('scripts\\ports.js')) failures.push(`${file} does not read ports from scripts\\ports.js`);
  const hardcoded = /(?:API_PORT|FW_PORT|NODE_PORT|NGINX_PORT)="?\s*(?:3001|80)\b/.exec(text.replace(/set\s+"/g, 'set "'));
  if (hardcoded) failures.push(`${file} sets a hardcoded default port (${hardcoded[1]}) instead of the single port source`);
}
// 10.2) No stopping by name: every taskkill must use a verified process id
for (const file of batScripts) {
  const text = readText(file);
  if (/taskkill[^\r\n]*\/IM\b/i.test(text)) failures.push(`${file}: taskkill /IM stops every process with that name, not only PrinceLive ones`);
  if (/del\s+\/q\s+"?logs\\/i.test(text) || /rd\s+\/s\s+\/q\s+"?logs\b/i.test(text) || /del\s+\/q\s+"?nginx\\logs/i.test(text)) {
    failures.push(`${file}: deletes run logs on stop`);
  }
}
// 10.3) Process ownership goes through scripts\procs.js in every script that stops or checks
//       (nginx-stop.bat is the shared Nginx stop path and uses procs.js itself)
for (const file of ['scripts/start.bat', 'scripts/stop.bat', 'scripts/stop-nginx.bat', 'scripts/restart-nginx.bat', 'scripts/check.bat', 'scripts/nginx-stop.bat']) {
  if (!fs.existsSync(filePath(file))) continue;
  const text = readText(file);
  if (!text.includes('procs.js') && !text.includes('nginx-stop.bat')) failures.push(`${file} does not verify process ownership before stopping it`);
}
// 10.4) start.bat verifies the server response and returns a failure code instead of declaring full success
if (fs.existsSync(filePath('scripts/start.bat'))) {
  const startBat = readText('scripts/start.bat');
  if (!startBat.includes('/api/status')) failures.push('scripts/start.bat does not verify the /api/status response');
  if (!/exit \/b 1/.test(startBat)) failures.push('scripts/start.bat does not return a failure code when start fails');
  if (!/did NOT start completely/i.test(startBat)) failures.push('scripts/start.bat does not distinguish a partial start from a full start');
}
// 10.5) The server writes its process id for stop.bat to use
if (serverJs && !/server\.pid/.test(serverJs)) failures.push('server.js does not write run\\server.pid needed to identify the PrinceLive process');
// 10.6) Win-Lix package: Linux scripts present, LF line endings, shebang, and start.sh checks the server
for (const file of ['scripts/start.sh', 'scripts/stop.sh', 'scripts/check.sh', 'scripts/devices.sh']) {
  if (!fs.existsSync(filePath(file))) continue;
  const text = readText(file);
  if (!text.startsWith('#!/bin/sh')) failures.push(`${file} does not start with #!/bin/sh`);
  if (text.includes('\r')) failures.push(`${file} contains CRLF line endings, which break on Linux`);
}
if (fs.existsSync(filePath('scripts/start.sh')) && !readText('scripts/start.sh').includes('/api/status')) {
  failures.push('scripts/start.sh does not verify the /api/status response');
}
// 10.7) One device tool on both systems: devices.bat delegates to scripts/devices.js
if (fs.existsSync(filePath('scripts/devices.bat')) && !readText('scripts/devices.bat').includes('scripts\\devices.js')) {
  failures.push('scripts/devices.bat does not use the shared device tool scripts\\devices.js');
}

if (failures.length) {
  console.error('PrinceLive verification FAILED');
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('PrinceLive verification PASSED');
console.log(`Sources: ${data.sources.length}; channels: ${data.channels.length}; settings fields: ${S_KEYS.length}`);
console.log('JavaScript syntax, JSON schema, PrinceLive settings fields, admin sections, viewer API contract, and data integrity are valid.');
