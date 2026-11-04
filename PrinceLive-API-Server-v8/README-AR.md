# PrinceLive API Server v8 — مرشح إصدار 8.0.1

منصة بث محلي متعددة القنوات تعتمد Node.js وFFmpeg وHLS، مع لوحة أدمن وواجهة مشاهد منفصلتين.

**رابط الحزمة النظيفة (ZIP):** [PrinceLive-API-Server-v8-FINAL-MODALS.zip](../PrinceLive-API-Server-v8-FINAL-MODALS.zip) — نسخة جاهزة للتشغيل على Windows 10 بلا ملفات تشغيل (سجلات، مقاطع HLS، رموز، `node_modules`، و`ffmpeg.exe`/`ffprobe.exe`).

## ما تتضمنه هذه النسخة

- إدارة عدة مصادر USB/DirectShow وHTTP/HLS وRTSP.
- إنشاء قناة تلقائياً عند إضافة مصدر جديد.
- إدارة قنوات متعددة، لكل قناة عملية FFmpeg ومجلد HLS مستقل.
- إعدادات مستقلة لكل قناة: الجودة وFPS وBitrate وautoStart وalwaysOn.
- لوحة إعدادات للنظام تشمل الترميز وHLS والمشغل وإعادة التشغيل والخمول والمسارات والمنافذ.
- اكتشاف أجهزة DirectShow واستخراج قدراتها واختبار الفيديو والصوت قبل اعتماد الإعداد.
- واجهة مشاهد تعرض القنوات المفعلة وتبدّل بينها.
- واجهات API إدارية محمية بالمصادقة.

## متطلبات التشغيل

- Windows 10/11 64-bit.
- Node.js 18 أو أحدث.
- FFmpeg build يدعم DirectShow وlibx264 وHLS.
- FFprobe (موصى به للتحقق من توافق codecs).
- Nginx for Windows إذا أردت تقديم الواجهة والبث عبر منفذ Nginx.
- كرت التقاط USB أو مصدر HTTP/HLS أو RTSP متاح للخادم.

## الإعداد الأولي

1. فك ضغط الحزمة في مجلد مستقل، ولا تستبدل ملفات إصدار سابق مباشرة.
2. الإعدادات كلها في `data.json` (قسم `settings`): اضبط `ffmpegPath` و`ffprobePath` و`nginxPath` من لوحة الإدارة أو مباشرةً من الملف. ملف `config.json` للتمهيد فقط (`host` و`hlsRoot` و`admin`)؛ أما `port` و`nginxPort` فمصدرهما الوحيد `settings` في `data.json`.
3. غيّر كلمة المرور بعد أول دخول من لوحة الإدارة: **الإعدادات ← الأمان ← تغيير كلمة المرور** (تُحفظ مشفّرة بـ scrypt في كائن `admin` داخل `config.json`).
4. راجع المنفذين `port` و`nginxPort` وعنوان `host`.
5. تأكد من وجود `nginx/conf/nginx.conf` وأن `proxy_pass` يشير إلى منفذ Node.js.
6. شغّل `scripts/start.bat` أو نفّذ `node server.js` من مجلد المشروع.
7. افتح `http://localhost/admin/` وسجّل الدخول.
8. أضف مصدراً، افحصه واختبره، ثم احفظه. ينشئ النظام قناة مرتبطة به تلقائياً.
9. جدار الحماية: `scripts\start.bat` يفحص القاعدة عند كل تشغيل، وإن لم تكن موجودة يشغّل `scripts\firewall.bat` تلقائياً (نافذة صلاحيات واحدة) لفتح منفذ المشاهدة ولوحة الإدارة. يقرأ المنافذ الفعلية من `data.json` عبر `scripts\ports.js`. يدوياً: `firewall.bat` للسماح، `firewall.bat public` للشبكات العامة أيضاً، و`firewall.bat remove` للإلغاء.
9. عدّل القناة واختر الجودة وإعدادات التشغيل.
10. افتح واجهة المشاهد من `/`.

## إدارة المصادر والقنوات

- مصدر USB: اختر جهاز الفيديو والصوت، ثم استخدم اكتشاف القدرات والضبط التلقائي. يختبر النظام عدة توليفات قصيرة قبل اختيار أول توليفة تنجح.
- مصدر HTTP/HLS أو RTSP: أدخل الرابط واستخدم اختبار المصدر الشبكي قبل الحفظ.
- لكل قناة مجلد مستقل في `srv/hls/<channelId>`.
- رابط قائمة التشغيل: `/hls/<channelId>/index.m3u8`.
- لا يمكن تشغيل جهاز USB نفسه على قناتين في الوقت ذاته؛ ذلك يمنع تعارض الوصول إلى جهاز الالتقاط.
- حذف مصدر مرتبط بقناة مرفوض؛ احذف القناة أولاً.

## واجهات API الرئيسية

### عامة
- `GET /api/public/settings`
- `GET /api/public/channels`
- `POST /api/public/watch` مع `{ "id": "channelId" }`
- `POST /api/public/heartbeat`
- `POST /api/public/leave`
- `GET /api/status?channelId=<id>`

### إدارة — تتطلب المصادقة
- `GET/POST /api/sources`
- `PUT/DELETE /api/sources/:id`
- `POST /api/sources/test`
- `GET /api/channels`
- `POST /api/channels`
- `PUT/DELETE /api/channels/:id`
- `POST /api/channels/:id/start`
- `POST /api/channels/:id/stop`
- `POST /api/channels/:id/restart`
- `GET/PUT /api/settings`
- `GET /api/devices`
- `GET /api/devices/capabilities?videoDevice=<name>`
- `POST /api/devices/test`
- `POST /api/devices/test-audio`
- `GET /api/stats`
- `GET /api/logs`

## ملاحظات مهمة

- `theme` في `settings` يُطبَّق كصنف على `body` في صفحة المشاهدين واللوحة، والقيم المقبولة `default` و`worldcup` (الأخير معرّف في `web/viewer.css`)، وأي قيمة أخرى تُرفض عند الحفظ.
- `startupConcurrency` عدد القنوات التي تُشغَّل معاً عند الإقلاع (1 = تسلسلي، وهو الأنسب لكرت التقاط واحد)، ويبقى `startupQueueDelayMs` تأخيراً أولياً قبل أول دفعة.
- السجلات عند تشخيص فشل التشغيل من أجهزة خارجية: `logs/server.log` (أوامر تشغيل/إيقاف القنوات مع IP والجهاز والسبب)، و`nginx/logs/access.log` (كل الطلبات)، و`nginx/logs/stream.log` (طلبات HLS وحدها)، و`nginx/logs/error.log` (مستوى info).
- تغيير منافذ Node.js أو Nginx يتطلب إعادة تشغيل الخدمات. يتم تحديث إعداد proxy في `nginx/conf/nginx.conf` عند حفظ الإعدادات.
- إذا ظهر `nginx: [emerg] CreateDirectory() "...\nginx/temp/client_body_temp" failed` فهذا يعني أن مجلد `nginx\temp` غير موجود (يحدث عند نسخ الملفات دون المجلدات الفارغة). الحزمة تضم `nginx/temp/.gitkeep`، و`scripts\start.bat` و`restart-nginx.bat` و`check.bat` تستدعي `scripts\nginx-dirs.bat` الذي ينشئ المجلدات المؤقتة قبل أي فحص. للحل الفوري: أنشئ مجلد `nginx\temp` يدوياً ثم أعد `scripts\start.bat`.
- تغيير إعدادات الترميز يطبق على القنوات عند إعادة تشغيلها.
- وضع «نسخ المصدر» دون إعادة ترميز متاح فقط للمصادر الشبكية في هذه النسخة، وقد يفشل إذا كانت codecs غير متوافقة مع HLS MPEG-TS. اختر 240p/360p/480p/720p عند الحاجة إلى إعادة الترميز.
- عدد القنوات المتزامنة تحدده قدرة CPU وRAM وأجهزة الالتقاط وعرض الشبكة.
- الدخول إلى اللوحة يتم داخل الصفحة عبر `POST /api/login` ويُصدر كوكي جلسة HttpOnly موقّعاً صالحاً 12 ساعة (بحد أقصى 8 محاولات فاشلة لكل عنوان كل 10 دقائق)؛ ولا يوجد Basic Auth: الجلسة هي المصادقة الوحيدة، وسكربتات الجهاز (مثل `scripts/stop.bat`) تستخدم رمز التحكّم المحلي `run/control.token`. اللوحة مناسبة لشبكة محلية موثوقة فقط؛ لا تعرّضها مباشرة للإنترنت.
- هذه مرشح إصدار 8.0.1. ما زال يلزم اختبار الالتقاط الفعلي من أجهزة DirectShow وقواعد جدار الحماية على جهاز Windows حقيقي.


## فحص الحزمة
من مجلد المشروع نفّذ:
```bat
npm test
```
ينفذ هذا الأمر فحوصاً ثابتة للملفات وJSON والعلاقات الأساسية. لا يستبدل اختبار كرت USB والصوت وNginx الحقيقي على Windows.


بيانات الدخول الأولية: اسم المستخدم `admin` وكلمة المرور `admin123` (محفوظة مشفّرة بـ scrypt في `admin` داخل `config.json`). غيّرها بعد أول دخول من **الإعدادات ← الأمان**.

الحزمة تضم نسخة Nginx لويندوز داخل مجلد `nginx/`، لكنها **لا تضم `ffmpeg.exe` ولا `ffprobe.exe`** حتى لا تُستبدل نسخة موجودة عندك؛ ضع `ffmpeg.exe` و`ffprobe.exe` في جذر المشروع بجانب `server.js`. يبحث الخادم عن `ffmpeg` بجانب `server.js` أولاً ثم في `PATH`، ولذلك يعمل التشغيل مباشرةً دون تعديل المسارات.
