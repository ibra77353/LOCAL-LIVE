'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const required = [
  'server.js','config.json','data.json','web/admin.html','web/admin.js',
  'web/index.html','web/app.js','web/vendor/hls.min.js','nginx/conf/nginx.conf'
];
const failures=[];
for (const file of required) if (!fs.existsSync(path.join(root,file))) failures.push(`ملف مفقود: ${file}`);
for (const file of ['server.js','web/admin.js','web/app.js']) {
  const result=spawnSync(process.execPath,['--check',path.join(root,file)],{encoding:'utf8'});
  if(result.status!==0) failures.push(`فشل فحص JavaScript: ${file}\n${result.stderr}`);
}
for (const file of ['config.json','data.json']) {
  try { JSON.parse(fs.readFileSync(path.join(root,file),'utf8').replace(/^\uFEFF/,'')); }
  catch(e){ failures.push(`JSON غير صالح: ${file}: ${e.message}`); }
}
const data=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8').replace(/^\uFEFF/,''));
if(!Array.isArray(data.sources)||!Array.isArray(data.channels)||!data.settings) failures.push('مخطط data.json غير مكتمل');
for(const channel of data.channels||[]) {
  if(!channel.id||!channel.sourceId) failures.push(`القناة ${channel.name||'(بدون اسم)'} لا تحتوي id/sourceId`);
  if(!(data.sources||[]).some(source=>source.id===channel.sourceId)) failures.push(`مصدر القناة غير موجود: ${channel.id}`);
}
const admin=fs.readFileSync(path.join(root,'web/admin.html'),'utf8');
for(const id of ['settings-form','source-form','channel-form','source-dialog','channel-dialog']) if(!admin.includes(`id="${id}"`)) failures.push(`واجهة الإدارة تفتقد ${id}`);
for(const forbidden of ['IPTV','Xtream Codes','كأس العالم 2026','الإعلانات','الجدولة','اشتراك MH']) if(admin.includes(forbidden)) failures.push(`واجهة الإدارة ما زالت تحتوي صفحة محذوفة: ${forbidden}`);
if(failures.length){console.error('V8 verification FAILED\n'+failures.join('\n'));process.exit(1);}
console.log('V8 verification PASSED');
console.log(`Sources: ${data.sources.length}; channels: ${data.channels.length}`);
console.log('JavaScript syntax, JSON, channel-source relationships, and core UI sections are valid.');
