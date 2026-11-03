ملفات مشروع البرنس لايف — النسخة المعدّلة

config.json: إعدادات الأجهزة والبث. القيم المعتمدة: 640×360، 20 FPS، فيديو 500k، حد أقصى 500k، buffer 1000k، صوت AAC 96k.
server.js: خادم Node.js الذي يدير API وFFmpeg وينشئ HLS في srv/hls/index.m3u8.

start.bat: يشغّل Node.js وNginx (بعد اختبار إعداد Nginx).
stop.bat: يوقف بث FFmpeg فقط، ويترك واجهة Node.js وNginx يعملان.
restart-nginx.bat: يختبر إعداد Nginx ثم يعيد تحميله أو يشغّله إذا كان متوقفًا.
stop-nginx.bat: يوقف Nginx فقط.
check.bat: يفحص وجود Node.js وملفات المشروع وصحة config.json وإعداد Nginx والمنافذ.
devices.bat: يعرض أجهزة DirectShow باستخدام مسار FFmpeg من config.json.

ضع جميع هذه الملفات بجانب server.js وconfig.json في C:\PrinceLive-Windows. يفترض أن nginx\nginx.exe وnginx\conf\nginx.conf موجودان. ابدأ بتشغيل check.bat ثم start.bat. افتح http://127.0.0.1:3001.
ملاحظة: الملفات لم تُختبر فعليًا على جهازك؛ يجب التحقق من المسارات الفعلية قبل الاستخدام.
