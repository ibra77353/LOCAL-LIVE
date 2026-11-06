'use strict';
// عدّادات كارت الشبكة تُقرأ من النظام مباشرةً (بلا netstat): تحليل /proc/net/dev
// على لينكس وواجهة القراءة الموحّدة التي تعيد null بدل خطأ عند تعذّرها.
const test = require('node:test');
const assert = require('node:assert');
const { readReceivedBytes, sumProcNetDev } = require('../../lib/shared/net-counters');

test('sumProcNetDev يجمع البايتات المستلمة لكل واجهة ويتخطى سطري الترويسة', () => {
  const sample = [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo: 1024 10 0 0 0 0 0 0 1024 10 0 0 0 0 0 0',
    '  eth0: 2048 20 0 0 0 0 0 0 4096 40 0 0 0 0 0 0'
  ].join('\n');
  assert.equal(sumProcNetDev(sample), 1024 + 2048);
  assert.equal(sumProcNetDev(''), 0);
});

test('readReceivedBytes يعيد رقماً غير سالب أو null بلا رفع خطأ', async () => {
  const value = await new Promise((resolve) => readReceivedBytes(resolve));
  assert.ok(value === null || (Number.isFinite(value) && value >= 0), `قيمة غير صالحة: ${value}`);
  if (process.platform !== 'win32') assert.ok(value !== null, 'عدّادات /proc/net/dev يجب أن تكون متاحة');
});
