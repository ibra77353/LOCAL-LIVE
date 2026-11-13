'use strict';
// عدّادات كارت الشبكة تُقرأ من النظام مباشرةً بدل تحليل مخرجات netstat:
// - ويندوز: Get-NetAdapterStatistics من PowerShell، وهي عدّادات الكارت نفسها
//   بصيغة رقمية ثابتة لا تتأثر بلغة النظام ولا تتوقف عند تنسيق جدول netstat.
// - غير ويندوز: /proc/net/dev مباشرة من النظام (بيئة التطوير/التحقق فقط).
// أي تعذّر يعيد null بدل رفع خطأ، فتعرض اللوحة «—» وتُكمل العيّنة التالية.

const fs = require('fs');
const { execFile } = require('child_process');

// نجمع ReceivedBytes لكل الكروت في رقم واحد، كما كان netstat -e يعرض إجمالياً.
const POWERSHELL_ARGS = [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
  '(Get-NetAdapterStatistics | Measure-Object -Property ReceivedBytes -Sum).Sum'
];

// مجموع البايتات المستلمة من نص /proc/net/dev: العمود الأول بعد النقطتين هو
// Received bytes لكل واجهة (سطرا الترويسة بلا نقطتين فيُتخطّيان).
function sumProcNetDev(text) {
  let total = 0;
  for (const line of String(text || '').split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const received = Number(line.slice(colon + 1).trim().split(/\s+/)[0]);
    if (Number.isFinite(received)) total += received;
  }
  return total;
}

function readProcNetDevReceived(cb) {
  fs.readFile('/proc/net/dev', 'utf8', (err, text) => {
    if (err || !text) return cb(null);
    cb(sumProcNetDev(text));
  });
}

function readWindowsReceived(cb) {
  execFile('powershell.exe', POWERSHELL_ARGS, { encoding: 'utf8', windowsHide: true, timeout: 8000 }, (err, stdout) => {
    if (err || !stdout) return cb(null);
    const total = Number(String(stdout).trim());
    cb(Number.isFinite(total) && total >= 0 ? total : null);
  });
}

// يعيد مجموع البايتات المستلمة عبر كل كروت الشبكة، أو null إذا لم يتوفر عدّاد.
function readReceivedBytes(cb) {
  if (process.platform === 'win32') return readWindowsReceived(cb);
  return readProcNetDevReceived(cb);
}

module.exports = { readReceivedBytes, sumProcNetDev };
