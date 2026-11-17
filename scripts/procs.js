'use strict';
// Distinguishes PrinceLive processes from any other Node.js or Nginx process on the machine.
// Used by the start/stop/restart-nginx/stop-nginx scripts before stopping anything, so that
// a server or Nginx that belongs to another program on the machine is never closed.
//
// Commands:
//   node scripts\procs.js node-pid            <- PID of the PrinceLive server, or nothing
//   node scripts\procs.js nginx-pids          <- PIDs of this project's Nginx, one per line
//   node scripts\procs.js ffmpeg-pids         <- PIDs of this project's FFmpeg (orphans), one per line
//   node scripts\procs.js port-owner <port>   <- who listens on the port: "PID <pid> <name>"
//   node scripts\procs.js verify-node <pid>   <- exit 0 if the process is this project's server
//   node scripts\procs.js verify-nginx <pid>  <- exit 0 if the process is this project's Nginx
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Paths can arrive in different Unicode forms (composed / decomposed) on non-ASCII names,
// so both sides of every comparison are normalised to NFC before matching.
function normalizePath(value) {
  return String(value || '').normalize('NFC').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

// Does the process command line run server.js located in this project's root?
// Matching is on the absolute path only: any other server.js started from a different folder
// counts as a foreign process and is not stopped. scripts\start.bat starts the server with its
// absolute path (%ROOT%\server.js) so this distinction always works.
function isOwnServerCommandLine(cmdline, root) {
  const line = normalizePath(String(cmdline || '').replace(/"/g, ''));
  if (!line || !/server\.js/.test(line)) return false;
  const rootDir = normalizePath(root);
  if (!rootDir) return false;
  return line.includes(`${rootDir}\\server.js`);
}

// Is this Nginx file the project's copy (nginx\nginx.exe) and not another system's Nginx?
function isOwnNginxPath(exePath, root) {
  const exe = normalizePath(exePath);
  const expected = `${normalizePath(root)}\\nginx\\nginx.exe`;
  return !!exe && exe === expected;
}

// Is this FFmpeg binary the copy that ships inside the project folder?
function isOwnFfmpegPath(exePath, root) {
  const exe = normalizePath(exePath);
  const rootDir = normalizePath(root);
  if (!exe || !rootDir) return false;
  return exe.startsWith(`${rootDir}\\`) && /\\ffmpeg(\.exe)?$/.test(exe);
}

// Does the command line write into this project's srv folder (HLS output) or use the project's
// FFmpeg? A system-wide FFmpeg that belongs to another program matches neither rule and is
// never stopped, even when the user configured ffmpegPath outside the project.
function isOwnFfmpegCommandLine(cmdline, root) {
  const line = normalizePath(String(cmdline || '').replace(/"/g, ''));
  const rootDir = normalizePath(root);
  if (!line || !rootDir) return false;
  if (!/ffmpeg/i.test(line)) return false;
  return line.includes(`${rootDir}\\ffmpeg.exe`) || line.includes(`${rootDir}\\srv\\`);
}

function listProcessesWindows() {
  // Windows PowerShell writes to a pipe in the console code page (OEM: 850, 1256, ...), not
  // UTF-8, so a project path holding non-ASCII characters (accented or non-Latin user and
  // folder names) came back garbled and the ownership match against this project's own path
  // never succeeded. Both the
  // console encoding and $OutputEncoding are switched to UTF-8 before the query, which matches
  // the 'utf8' decoding of spawnSync below. A leading BOM is dropped for the same reason.
  const script = [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
    '$OutputEncoding=[System.Text.Encoding]::UTF8;',
    'Get-CimInstance Win32_Process',
    "| Where-Object { $_.Name -eq 'node.exe' -or $_.Name -eq 'nginx.exe' -or $_.Name -eq 'ffmpeg.exe' }",
    '| ForEach-Object { "$($_.ProcessId)|$($_.Name)|$($_.ExecutablePath)|$($_.CommandLine)" }'
  ].join(' ');
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (result.status !== 0 || !result.stdout) return [];
  return String(result.stdout).replace(/^\uFEFF/, '').split(/\r?\n/).map(line => {
    const [pid, name, exePath, ...rest] = line.split('|');
    const id = Number(pid);
    if (!Number.isInteger(id) || id <= 0) return null;
    return { pid: id, name: String(name || ''), path: String(exePath || ''), cmdline: rest.join('|') };
  }).filter(Boolean);
}

// On non-Windows systems we read /proc so the same ownership rules stay testable locally.
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
    if (!/^(node|nginx|ffmpeg)/i.test(name)) continue;
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

// PID of the process listening on the given TCP port plus the program name, or null.
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

// PrinceLive server process: an absolute server.js path inside the project, or an id recorded in
// run\server.pid (a file the project's own server writes) with a command line running server.js.
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

// FFmpeg processes of this project. When the server is closed with a forced kill, its FFmpeg
// children can survive and keep writing into srv\hls; a normal stop.bat / stop.sh closes the
// streams through the API first and this list only has leftovers to clear.
function ownFfmpegProcesses(root = ROOT) {
  return listProcesses().filter(p => /^ffmpeg/i.test(p.name)
    && (isOwnFfmpegPath(p.path, root) || isOwnFfmpegCommandLine(p.cmdline, root)));
}

// The single server process: prefer whoever listens on the API port, then run\server.pid.
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
  if (command === 'ffmpeg-pids') {
    for (const proc of ownFfmpegProcesses(ROOT)) process.stdout.write(`${proc.pid}\n`);
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
  process.stderr.write('usage: node scripts\\procs.js node-pid | nginx-pids | ffmpeg-pids | port-owner <port> | verify-node <pid> | verify-nginx <pid>\n');
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  ROOT,
  normalizePath,
  isOwnServerCommandLine,
  isOwnNginxPath,
  isOwnFfmpegPath,
  isOwnFfmpegCommandLine,
  listProcesses,
  portOwner,
  findServerPid,
  ownNginxProcesses,
  ownFfmpegProcesses
};
