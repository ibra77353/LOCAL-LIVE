'use strict';
// انتظار مشترك لاختبارات HTTP: يفحص شرطاً حتى يتحقق أو تنتهي المهلة.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 8000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(stepMs);
  }
  return last;
}

module.exports = { sleep, waitFor };
