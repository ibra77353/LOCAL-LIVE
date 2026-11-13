'use strict';
// التقاط الشاشة على Windows عبر gdigrab (المشروع Windows فقط).
// نقل حرفي للفرع الذي كان داخل buildArgs في server.js، دون تغيير أي وسيط.

function inputArgs(source) {
  const screenFps = String(Number(source.fps) || 15);
  return ['-f', 'gdigrab', '-framerate', screenFps, '-i', 'desktop'];
}

module.exports = { inputArgs };
