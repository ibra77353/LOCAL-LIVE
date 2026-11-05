'use strict';
// التقاط الشاشة: gdigrab على Windows وx11grab على بقية الأنظمة.
// نقل حرفي للفرع الذي كان داخل buildArgs في server.js، دون تغيير أي وسيط.

function inputArgs(source, platform = process.platform) {
  const screenFps = String(Number(source.fps) || 15);
  if (platform === 'win32') return ['-f', 'gdigrab', '-framerate', screenFps, '-i', 'desktop'];
  return ['-f', 'x11grab', '-framerate', screenFps, '-i', String(process.env.DISPLAY || ':0.0')];
}

module.exports = { inputArgs };
