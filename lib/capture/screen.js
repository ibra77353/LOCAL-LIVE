'use strict';
// التقاط الشاشة: gdigrab على Windows وx11grab على Linux فقط.
// نقل حرفي للفرع الذي كان داخل buildArgs في server.js، دون تغيير أي وسيط.
// أي نظام آخر غير مدعوم ولا يُعامَل كـ Linux.

function inputArgs(source, platform = process.platform) {
  const screenFps = String(Number(source.fps) || 15);
  if (platform === 'win32') return ['-f', 'gdigrab', '-framerate', screenFps, '-i', 'desktop'];
  if (platform === 'linux') return ['-f', 'x11grab', '-framerate', screenFps, '-i', String(process.env.DISPLAY || ':0.0')];
  throw new Error(`التقاط الشاشة غير مدعوم على «${platform}». المدعوم: win32، linux`);
}

module.exports = { inputArgs };
