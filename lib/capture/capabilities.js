'use strict';
// تجميع قدرات جهاز الالتقاط من بيانات خام (دقات/معدلات إطارات/صيغ/أوضاع).
// مشترك بين DirectShow (Windows) وV4L2 (Linux) حتى تعطي اللوحة الشكل نفسه
// والتوصية نفسها على النظامين، ويبقى مخرج DirectShow مطابقاً لما كان في server.js.

// ترتيب الدقات: نفصل أولاً ما لا يتجاوز 1280x720 (الأخف على المعالج) ثم الأكبر مساحةً.
function sizeRank(value) {
  const [w, h] = value.split('x').map(Number);
  return { value, pixels: w * h, width: w, height: h };
}

const PREFERRED_FORMATS = ['mjpeg', 'yuyv422', 'uyvy422', 'nv12', 'yuv420p'];

function buildCapabilities(raw = {}) {
  const videoSizes = new Set(raw.videoSizes || []);
  const frameRates = new Set(raw.frameRates || []);
  const pixelFormats = new Set(raw.pixelFormats || []);
  const modes = Array.isArray(raw.modes) ? raw.modes : [];

  const ranked = [...videoSizes].map(sizeRank).sort((a, b) => {
    const aPreferred = a.width <= 1280 && a.height <= 720 ? 1 : 0;
    const bPreferred = b.width <= 1280 && b.height <= 720 ? 1 : 0;
    return bPreferred - aPreferred || b.pixels - a.pixels;
  });
  const fpsValues = [...frameRates].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const recommendedSize = ranked[0]?.value || '1280x720';
  const recommendedFps = fpsValues.filter(x => x <= 30).sort((a, b) => b - a)[0] || fpsValues[0] || 30;
  const recommendedFormat = PREFERRED_FORMATS.find(x => pixelFormats.has(x)) || [...pixelFormats][0] || '';
  const uniqueModes = [...new Map(modes.map(m => [`${m.pixelFormat}|${m.videoSize}|${m.fps}`, m])).values()];
  return {
    videoSizes: [...videoSizes].sort((a, b) => sizeRank(b).pixels - sizeRank(a).pixels),
    frameRates: fpsValues.map(String),
    pixelFormats: [...pixelFormats],
    modes: uniqueModes,
    recommended: { videoSize: recommendedSize, fps: recommendedFps, pixelFormat: recommendedFormat }
  };
}

module.exports = { buildCapabilities, sizeRank };
