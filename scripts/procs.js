'use strict';
// تمييز عمليات PrinceLive عن أي عملية Node.js أو Nginx أخرى على الجهاز.
// تستخدمه سكربتات start/stop/restart-nginx/stop-nginx قبل إيقاف أي عملية، حتى لا
// يُغلق خادم أو Nginx يخص برنامجاً آخر يعمل على نفس الجهاز.
//
// الأوامر:
//   node scripts\procs.js node-pid            ← معرّف عملية خادم PrinceLive أو لا شيء
//   node scripts\procs.js nginx-pids          ← معرّفات Nginx التابعة للمشروع، سطر لكل معرّف
//   node scripts\procs.js port-owner <port>   ← من يستمع على المنفذ: "PID <pid> <name>"
//   node scripts\procs.js verify-node <pid>   ← exit 0 إن كانت العملية خادم المشروع
//   node scripts\procs.js verify-nginx <pid>  ← exit 0 إن كانت العملية Nginx المشروع
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function normalizePath(value) {
  return String(value || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

// هل سطر أوامر العملية يشغّل server.js الموجود في جذر هذا المشروع؟
// المطابقة على المسار المطلق فقط: أي خادم آخر يعمل باسم server.js من مجلد مختلف
// يُعدّ عملية غريبة ولا يُوقَف. scripts\start.bat يشغّل الخادم بالمسار المطلق
// (%ROOT%\server.js) حتى يعمل هذا التمييز دائماً.
function isOwnServerCommandLine(cmdline, root) {
  const line = normalizePath(String(cmdline || '').replace(/"/g, ''));
  if (!line || !/server\.js/.test(line)) return false;
  const rootDir = normalizePath(root);
  if (!rootDir) return false;
  return line.includes(`${rootDir}\\server.js`);
}

// هل ملف Nginx هذا هو نسخة المشروع (nginx\nginx.exe) وليس Nginx لنظام آخر؟
function isOwnNginxPath(exePath, root) {
  const exe = normalizePath(exePath);
  const expected = `${normalizePath(root)}\\nginx\\nginx.exe`;
  return !!exe && exe === expected;
}

function listProcessesWindows() {
  const script = [
    'Get-CimInstance Win32_Process',
    "| Where-Object { $_.Name -eq 'node.exe' -or $_.Name -eq 'nginx.exe' }",
    '| ForEach-Object { "$($_.ProcessId)|$($_.Name)|$($_.ExecutablePath)|$($_.CommandLine)" }'
  ].join(' ');
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.split(/\r?\n/).map(line => {
    const [pid, name, exePath, ...rest] = line.split('|');
    const id = Number(pid);
    if (!Number.isInteger(id) || id <= 0) return null;
    return { pid: id, name: String(name || ''), path: String(exePath || ''), cmdline: rest.join('|') };
  }).filter(Boolean);
}

// على غير ويندوز نقرأ /proc حتى تبقى نفس قواعد التمييز قابلة للاختبار محلياً.
function listProcessesPosix() {
  let entries = [];
  try { entries = fs.readdirSync('/proc'); } catch { return []; }
  const out = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline = '';
    try { cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch { continue; }
    let exePath = '';
    try { exePath = fs.readlinkSync(`/proc/${entry}/exe`); } catch {}
    let name = '';
    try { name = fs.readFileSync(`/proc/${entry}/comm`, 'utf8').trim(); } catch { name = path.basename(exePath || ''); }
    if (!/^(node|nginx)/i.test(name)) continue;
    out.push({ pid: Number(entry), name, path: exePath, cmdline });
  }
  return out;
}

function listProcesses() {
  return process.platform === 'win32' ? listProcessesWindows() : listProcessesPosix();
}

function readPidFile(root, name) {
  try {
    const value = Number(String(fs.readFileSync(path.join(root, 'run', name), 'utf8')).trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

// معرّف العملية المستمعة على منفذ TCP محدد مع اسم البرنامج، أو null.
function portOwner(port) {
  const target = Number(port);
  if (!Number.isInteger(target) || target <= 0) return null;
  if (process.platform === 'win32') {
    const result = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (result.status !== 0 || !result.stdout) return null;
    for (const line of result.stdout.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 5 || !/LISTENING/i.test(cols[3])) continue;
      if (!cols[1].endsWith(`:${target}`)) continue;
      const pid = Number(cols[4]);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const proc = listProcesses().find(p => p.pid === pid);
      return { pid, name: proc ? proc.name : '' };
    }
    return null;
  }
  const result = spawnSync('ss', ['-ltnp'], { encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0 || !result.stdout) return null;
  const line = result.stdout.split(/\r?\n/).find(row => new RegExp(`:${target}\\s`).test(row) && /LISTEN/i.test(row));
  if (!line) return null;
  const pidMatch = /pid=(\d+)/.exec(line);
  if (!pidMatch) return null;
  const pid = Number(pidMatch[1]);
  const proc = listProcesses().find(p => p.pid === pid);
  return { pid, name: proc ? proc.name : '' };
}

// عملية خادم PrinceLive: مسار مطلق لـ server.js داخل المشروع، أو معرّف مسجّل في
// run\server.pid (ملف يكتبه خادم المشروع نفسه) مع سطر أوامر يشغّل server.js.
function isServerProcess(proc, root = ROOT) {
  if (!proc || !/^node/i.test(proc.name)) return false;
  if (isOwnServerCommandLine(proc.cmdline, root)) return true;
  const fromFile = readPidFile(root, 'server.pid');
  return fromFile === proc.pid && /server\.js/i.test(String(proc.cmdline || ''));
}

function ownServerProcesses(root = ROOT) {
  return listProcesses().filter(p => isServerProcess(p, root));
}

function ownNginxProcesses(root = ROOT) {
  return listProcesses().filter(p => /^nginx/i.test(p.name) && isOwnNginxPath(p.path, root));
}

// عملية الخادم الواحدة: نفضّل من يستمع على منفذ API، ثم ما في run\server.pid.
function findServerPid(root = ROOT, port) {
  const candidates = ownServerProcesses(root).map(p => p.pid);
  if (!candidates.length) return null;
  const owner = portOwner(port);
  if (owner && candidates.includes(owner.pid)) return owner.pid;
  const fromFile = readPidFile(root, 'server.pid');
  if (fromFile && candidates.includes(fromFile)) return fromFile;
  return candidates[0];
}

function main(argv) {
  const command = String(argv[0] || '').toLowerCase();
  if (command === 'node-pid') {
    const portArg = Number(argv[1]) || null;
    const pid = findServerPid(ROOT, portArg);
    if (pid) process.stdout.write(`${pid}\n`);
    return 0;
  }
  if (command === 'nginx-pids') {
    for (const proc of ownNginxProcesses(ROOT)) process.stdout.write(`${proc.pid}\n`);
    return 0;
  }
  if (command === 'port-owner') {
    const owner = portOwner(Number(argv[1]));
    if (owner) process.stdout.write(`PID ${owner.pid} ${owner.name || 'unknown'}\n`);
    return 0;
  }
  if (command === 'verify-node' || command === 'verify-nginx') {
    const pid = Number(argv[1]);
    const proc = listProcesses().find(p => p.pid === pid);
    if (!proc) { process.stdout.write('NOT RUNNING\n'); return 1; }
    const own = command === 'verify-node' ? isServerProcess(proc, ROOT) : isOwnNginxPath(proc.path, ROOT);
    process.stdout.write(own ? 'PRINCELIVE\n' : 'FOREIGN\n');
    return own ? 0 : 1;
  }
  process.stderr.write('usage: node scripts\\procs.js node-pid | nginx-pids | port-owner <port> | verify-node <pid> | verify-nginx <pid>\n');
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  ROOT,
  normalizePath,
  isOwnServerCommandLine,
  isOwnNginxPath,
  listProcesses,
  portOwner,
  findServerPid,
  ownNginxProcesses
};
