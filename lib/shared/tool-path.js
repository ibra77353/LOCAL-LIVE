'use strict';
// مسار أداة خارجية (ffmpeg/ffprobe) كما يكتبه المستخدم: المسار المطلق يُترك،
// والنسبي يُبحث عنه في جذر المشروع أولاً (مع .exe على ويندوز) ثم يُترك لـ PATH.
const fs = require('fs');
const path = require('path');

function resolveToolPath(toolName, root) {
  const value = String(toolName || '').trim();
  if (!value || path.isAbsolute(value)) return value;
  for (const name of [value, `${value}.exe`]) {
    const candidate = path.join(root, name);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return value;
}

module.exports = { resolveToolPath };
