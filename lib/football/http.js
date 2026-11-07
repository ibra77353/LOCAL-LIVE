'use strict';
/* طلب JSON موحّد لواجهات الدوريات الخارجية: مهلة، فكّ ضغط gzip، وترويسة متصفح
   لأن بعض المصادر (ESPN) ترفض طلبات الأدوات الآلية بترويسة Wget/node. */

const https = require('https');
const zlib = require('zlib');

const TIMEOUT_MS = 12000;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

function fetchJson(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: TIMEOUT_MS,
      headers: Object.assign({ 'User-Agent': BROWSER_UA, Accept: 'application/json' }, extraHeaders)
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`واجهة الدوريات ردّت بالرمز ${res.statusCode}`));
        let body = Buffer.concat(chunks);
        if (res.headers['content-encoding'] === 'gzip') {
          try { body = zlib.gunzipSync(body); }
          catch { return reject(new Error('ردّ غير صالح من واجهة الدوريات')); }
        }
        try { resolve(JSON.parse(body.toString('utf8'))); }
        catch { reject(new Error('ردّ غير صالح من واجهة الدوريات')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('انتهت مهلة الاتصال بواجهة الدوريات')));
    req.on('error', reject);
  });
}

module.exports = { fetchJson, TIMEOUT_MS, BROWSER_UA };
