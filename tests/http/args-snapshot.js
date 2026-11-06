'use strict';
// يلتقط وسائط FFmpeg الفعلية التي يبنيها الخادم لكل نوع مصدر، عبر المسار الحقيقي
// (نفس نقطة النهاية POST /api/channels/:id/start والسجل)، ويطبعها JSON منظّماً.
//
// الغرض: مقارنة الناتج قبل استخراج طبقة الالتقاط وبعده — يجب أن يكون متطابقاً.
// التشغيل: node tests\http\args-snapshot.js > args.json

const fs = require('fs');
const path = require('path');
const { startTestServer } = require('./lib/harness');
const { createClient } = require('./lib/client');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SCENARIOS = [
  {
    key: 'usb_full',
    source: { name: 'USB Full', type: 'usb', videoDevice: 'USB Video Test Device', audioDevice: 'USB Audio Test Device', videoSize: '1280x720', fps: 30, vcodec: 'mjpeg' },
    channel: { quality: '360p', fps: 25, bitrate: '500k' },
  },
  {
    key: 'usb_safe_mode',
    source: { name: 'USB Safe', type: 'usb', videoDevice: 'USB Video Test Device', videoSize: '1920x1080', fps: 60, captureSafeMode: true },
    channel: { quality: '480p', fps: 20 },
  },
  {
    key: 'usb_pixel_format',
    source: { name: 'USB Pixel', type: 'usb', videoDevice: 'USB Video Test Device', videoSize: '640x480', fps: 15, pixelFormat: 'yuyv422' },
    channel: { quality: '240p', fps: 15 },
  },
  {
    key: 'usb_codec_as_pixel_format',
    source: { name: 'USB Codec', type: 'usb', videoDevice: 'USB Video Test Device', pixelFormat: 'mjpeg' },
    channel: { quality: '720p', fps: 30, bitrate: '2000k' },
  },
  {
    key: 'network_copy',
    source: { name: 'Net Copy', type: 'http', url: 'http://127.0.0.1:9/live.m3u8' },
    channel: { quality: 'copy', fps: 25 },
  },
  {
    key: 'network_transcode',
    source: { name: 'Net Transcode', type: 'hls', url: 'http://127.0.0.1:9/live.m3u8' },
    channel: { quality: '360p', fps: 20 },
  },
  {
    key: 'file_loop',
    source: { name: 'File Loop', type: 'file', path: path.join(process.cwd(), 'srv', 'uploads', 'sample.mp4') },
    channel: { quality: '480p', fps: 24 },
  },
  {
    key: 'screen_capture',
    source: { name: 'Screen', type: 'screen', fps: 15 },
    channel: { quality: '360p', fps: 15 },
  },
  {
    key: 'usb_copy_quality_rejected',
    source: { name: 'USB Copy', type: 'usb', videoDevice: 'USB Video Test Device' },
    channel: { quality: 'copy', fps: 25 },
  },
];

function extractArgs(logs) {
  const indexed = logs.lastIndexOf('FFmpeg args:');
  if (indexed < 0) return null;
  return logs.slice(indexed + 'FFmpeg args:'.length).split(/\r?\n/)[0].trim();
}

function normalize(text, server, channelId) {
  if (!text) return text;
  return String(text)
    .split(server.dir).join('<TMP>')
    .split(channelId).join('<CHANNEL_ID>')
    .replace(/ch_[0-9a-f]{8}/g, '<CHANNEL_ID>')
    .replace(/\\/g, '/');
}

async function snapshot(server, api) {
  const result = {};

  for (const scenario of SCENARIOS) {
    const sourceRes = await api.post('/api/sources', scenario.source);
    if (sourceRes.status !== 201) {
      result[scenario.key] = { setupError: sourceRes.status + ' ' + (sourceRes.json && sourceRes.json.error) };
      continue;
    }
    const sourceId = sourceRes.json.source.id;
    const channelRes = await api.post('/api/channels', Object.assign({ name: 'snap', sourceId }, scenario.channel));
    if (channelRes.status !== 201) {
      result[scenario.key] = { setupError: channelRes.status + ' ' + (channelRes.json && channelRes.json.error) };
      await api.del(`/api/sources/${sourceId}`);
      continue;
    }
    const channelId = channelRes.json.channel.id;

    const start = await api.post(`/api/channels/${channelId}/start`);
    let args = null;
    for (let i = 0; i < 40 && !args; i++) {
      const logs = await api.get('/api/logs');
      args = extractArgs(logs.json.logs || '');
      if (!args) await sleep(100);
    }
    await api.post(`/api/channels/${channelId}/stop`);

    result[scenario.key] = start.json && start.json.ok === false
      ? { startError: start.json.message }
      : { args: normalize(args, server, channelId) };

    await api.del(`/api/channels/${channelId}`);
    await api.del(`/api/sources/${sourceId}`);
  }

  return result;
}

(async () => {
  const outFile = process.argv[2];
  const server = await startTestServer({ port: 3902 });
  const api = createClient(server.baseUrl);
  try {
    const login = await api.post('/api/login', { user: server.user, pass: server.pass });
    if (login.status !== 200) throw new Error('تعذر تسجيل الدخول لنسخة الاختبار');
    const result = await snapshot(server, api);
    const text = JSON.stringify(result, null, 2);
    if (outFile) fs.writeFileSync(outFile, text + '\n', 'utf8');
    process.stdout.write(text + '\n');
  } finally {
    await server.stop();
  }
})().catch((err) => {
  console.error('فشل التقاط وسائط FFmpeg:', err.message);
  process.exit(1);
});
