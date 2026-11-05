'use strict';
// عميل HTTP صغير للاختبارات: يرسل JSON ويتذكّر كوكي جلسة اللوحة بين الطلبات.
// لا يعتمد على أي مكتبة خارجية مثل بقية المشروع.

function createClient(baseUrl) {
  let cookie = '';

  async function request(method, path, body, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(baseUrl + path, { method, headers, body: payload, redirect: 'manual' });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of setCookies) {
      const pair = line.split(';')[0];
      if (/^pl_admin=$/.test(pair)) cookie = '';
      else if (pair) cookie = pair;
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, headers: res.headers, text, json };
  }

  return {
    baseUrl,
    get: (p, opts) => request('GET', p, undefined, opts),
    post: (p, b, opts) => request('POST', p, b === undefined ? {} : b, opts),
    put: (p, b, opts) => request('PUT', p, b === undefined ? {} : b, opts),
    patch: (p, b, opts) => request('PATCH', p, b === undefined ? {} : b, opts),
    del: (p, opts) => request('DELETE', p, undefined, opts),
    clearCookie: () => { cookie = ''; },
    hasCookie: () => !!cookie,
    setCookie: (value) => { cookie = value; },
  };
}

module.exports = { createClient };
