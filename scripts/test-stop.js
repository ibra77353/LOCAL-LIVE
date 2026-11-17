'use strict';
// Test that mirrors exactly what scripts/stop.bat does:
//   1) read the port from data.json (same source as ports.js)
//   2) read the local control token from run/control.token
//   3) send POST /api/stop with the X-Control-Token header and verify the result
// We also verify a request without the token is rejected with 401, otherwise the test proves nothing.
// Usage: node scripts/test-stop.js [port]   - exit code: 0 pass, 1 fail.
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const TOKEN_FILE = path.join(ROOT, 'run', 'control.token');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

const settings = readJson('data.json').settings || {};
// Same priority order as server.js (PORT then data.settings.port) so the script tests the port
// the server actually listens on, not a different default.
const PORT = Number(process.argv[2]) || Number(process.env.PORT || settings.port) || 3001;

function stopRequest(token) {
  return new Promise(resolve => {
    const headers = { 'Content-Length': 0 };
    if (token) headers['X-Control-Token'] = token;
    const req = http.request({ host: HOST, port: PORT, path: '/api/stop', method: 'POST', headers, timeout: 5000 }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch {}
        resolve({ status: res.statusCode, body, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('connection timed out')));
    req.on('error', err => resolve({ error: err.message }));
    req.end();
  });
}

(async () => {
  const failures = [];
  console.log(`1) Port in use: ${PORT} (from data.json and config.json as in ports.js)`);

  let token = '';
  try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
  if (!token) {
    console.error(`FAIL: could not read run/control.token - start the server first (scripts\\start.bat).`);
    process.exit(1);
  }
  console.log(`2) Local control token read from run/control.token (${token.length} chars)`);

  const anonymous = await stopRequest('');
  if (anonymous.error) {
    console.error(`FAIL: the server does not respond on ${HOST}:${PORT} - ${anonymous.error}`);
    process.exit(1);
  }
  console.log(`3) Request without token: HTTP ${anonymous.status}`);
  if (anonymous.status !== 401) failures.push(`request without a token was not rejected with 401 (got ${anonymous.status}); the control token is not enforced`);

  const authed = await stopRequest(token);
  if (authed.error) {
    console.error(`FAIL: could not send the stop request - ${authed.error}`);
    process.exit(1);
  }
  console.log(`4) Request with token: HTTP ${authed.status} ${authed.body}`);
  if (authed.status !== 200) failures.push(`stop request with token failed: HTTP ${authed.status}`);
  if (!authed.json || authed.json.ok !== true) failures.push('stop response does not contain ok:true');
  else if (!Array.isArray(authed.json.results)) failures.push('stop response does not contain a results array');

  if (failures.length) {
    console.error('STOP TEST FAILED');
    for (const line of failures) console.error(`- ${line}`);
    process.exit(1);
  }
  console.log('STOP TEST PASSED');
  console.log('The local token works, a request without it is rejected, and the stop-all-channels command was accepted by the server.');
})();
