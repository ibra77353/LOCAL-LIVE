# PrinceLive API Server v8 — مرشح إصدار 8.0.1

منصة بث محلي متعددة القنوات تعتمد Node.js وFFmpeg وHLS، مع لوحة أدمن وواجهة مشاهد منفصلتين.

**رابط الحزمة النظيفة (ZIP):** [PrinceLive-API-Server.zip](PrinceLive-API-Server.zip) — نسخة جاهزة للتشغيل على Windows 10 بلا ملفات تشغيل (سجلات، مقاطع HLS، رموز، `node_modules`، و`ffmpeg.exe`/`ffprobe.exe`)، وتضم الكود الحالي كاملاً بما فيه `lib/capture/`، وتبدأ بـ`data.json` نظيف: الإعدادات فقط دون مصادر أو قنوات تجريبية.

> تُبنى الحزمة من ملفات المشروع نفسها: `server.js` و`lib/**` و`web/**` و`scripts/**` و`nginx/**` مع `README-AR.md` و`config.json` و`data.json` و`package.json`. إن عدّلت `data.json` أو أي ملف من هذه الملفات فعلياً، أعد بناء الحزمة حتى لا تتخلّف عنها.

## ما تتضمنه هذه النسخة

- إدارة عدة مصادر التقاط (DirectShow على Windows، V4L2 على Linux) وHTTP/HLS وRTSP.
- إنشاء قناة تلقائياً عند إضافة مصدر جديد.
- إدارة قنوات متعددة، لكل قناة عملية FFmpeg ومجلد HLS مستقل.
- إعدادات مستقلة لكل قناة: الجودة وFPS وBitrate ووضع الترميز (Bitrate/CRF) ومستوى CRF وautoStart وalwaysOn، مع وراثة القيم الافتراضية من إعدادات الخادم.
- لوحة إعدادات للنظام تشمل الترميز وHLS والمشغل وإعادة التشغيل والخمول والمسارات والمنافذ.
- اكتشاف أجهزة الالتقاط واستخراج قدراتها واختبار الفيديو والصوت قبل اعتماد الإعداد (DirectShow أو V4L2/ALSA).
- واجهة مشاهد تعرض القنوات المفعلة وتبدّل بينها.
- واجهات API إدارية محمية بالمصادقة.

## طبقة الالتقاط (Capture Abstraction Layer)

كل تفاصيل الالتقاط معزولة في `lib/capture/`، ولا يبني `server.js` أي وسيط FFmpeg خاص بجهاز التقاط بنفسه:

| الملف | الدور |
| --- | --- |
| `lib/capture/index.js` | الواجهة الموحّدة واختيار المحرك حسب نظام التشغيل |
| `lib/capture/dshow.js` | محرك Windows (DirectShow) — نفس منطق الإصدار السابق بلا تغيير |
| `lib/capture/v4l2.js` | محرك Linux: Video4Linux2 للفيديو + ALSA للصوت |
| `lib/capture/capabilities.js` | تجميع قدرات الجهاز والتوصية (مشترك بين المحركين) |
| `lib/capture/screen.js` | التقاط الشاشة: gdigrab على Windows وx11grab على Linux |

- **نطاق الدعم (ثلاثة أنظمة فقط):** Windows 10/11 ← DirectShow، Ubuntu/Debian ← V4L2 + ALSA، Docker Linux ← V4L2 + ALSA (مع تمرير `--device /dev/video0 --device /dev/snd` إلى الحاوية). الأنظمة الثلاثة مسجّلة في `capture.supportedTargets()`، و`/api/stats` يعرض المحرك النشط (`captureEngine`).
- **اختيار المحرك:** `win32 → DirectShow`، و`linux → V4L2` فقط. أي نظام آخر (macOS/BSD وغيرها) غير مدعوم ولا يُعامل كمحرك V4L2: طلب الالتقاط يرفع خطأً واضحاً، و`/api/stats` تُبلّغ `captureEngine: "unsupported"`. سلوك Windows لم يتغيّر إطلاقاً.
- **تعداد الأجهزة:** على Windows عبر `-list_devices` في FFmpeg؛ وعلى Linux بقراءة `/dev/video*` و`/sys/class/video4linux/*/name` وبطاقات الصوت من `/proc/asound/cards` دون تشغيل FFmpeg.
- **الصوت:** DirectShow يحمل الصوت مع الفيديو في إدخال واحد (`video=...:audio=...`)، أما V4L2 فلا يحمل صوتاً، فتُضاف طبقة ALSA كإدخال ثانٍ (`-f alsa -i plughw:N`) مع `-map 1:a:0?`. الطبقة تُبلّغ الخادم بفهرس إدخال الصوت (`audioInputIndex`) بدل أن يعرف التفاصيل.
- **إضافة نظام جديد:** ملف محرك يوفّر الدوال نفسها (`discover`, `capabilitiesArgs`, `inputPlan`, `testVideoArgs`, `testAudioArgs`) + سطر تسجيل في `ENGINES` داخل `lib/capture/index.js`.

### التشغيل على Linux

```bash
sudo apt install ffmpeg        # يجب أن يحوي دعم v4l2 وalsa
PORT=3000 HOST=0.0.0.0 node server.js
```

- اختر جهاز الفيديو من القائمة كـ `/dev/video0`، وجهاز الصوت كـ `plughw:1` أو `default`.
- تأكد من صلاحية قراءة الجهاز للمستخدم المشغّل (عضوية مجموعة `video` أو `audio` عند الحاجة).
- الكشف يعمل بلا جهاز: `GET /api/devices` يعيد `engine` ورسالة توضّح ما وُجد.

## متطلبات التشغيل

- Windows 10/11 64-bit، أو Linux مع `v4l2` و`alsa` (انظر «التشغيل على Linux»).
- Node.js 18 أو أحدث.
- FFmpeg build يدعم DirectShow (Windows) أو v4l2/alsa (Linux)، مع libx264 وHLS.
- FFprobe (موصى به للتحقق من توافق codecs).
- Nginx ليقدّم الواجهة والبث على منفذ `nginxPort` (80 افتراضياً) أمام خادم Node: `nginx.exe` على Windows، وحزمة `nginx` داخل حاوية Docker على المنفذ 80 داخلياً. إن لم يستمع أي خدمة على ذلك المنفذ يظهر تحذير في اللوحة (`nginxBinding` في `/api/status`).
- كرت التقاط USB (أو `/dev/video*` على Linux) أو مصدر HTTP/HLS أو RTSP متاح للخادم.

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

## التشغيل والإيقاف

كل ملفات التشغيل في `scripts\`، وتُشغَّل بالنقر المزدوج أو من موجّه الأوامر، وتقرأ المنافذ من المصدر نفسه الذي يقرأه الخادم.

| الملف | الوظيفة |
| --- | --- |
| `scripts\start.bat` | تشغيل خادم Node ثم Nginx والتحقق من جاهزيتهما فعلياً |
| `scripts\stop.bat` | إيقاف القنوات ثم Nginx ثم خادم Node |
| `scripts\check.bat` | فحص Node وملفات المشروع والمنافذ وملاك العمليات |
| `scripts\restart-nginx.bat` / `stop-nginx.bat` | إعادة تشغيل Nginx أو إيقافه وحده |
| `scripts\firewall.bat` / `allow-lan.bat` | فتح منفذي المشاهدة والإدارة في جدار الحماية (`remove` للإلغاء) |

- مصدر المنافذ الوحيد هو `data.json` (`settings.port` و`settings.nginxPort`) عبر `scripts\ports.js`، وكل ملفات BAT (start/stop/check/firewall/restart-nginx) تقرأ منه، فيستخدم التشغيل والإيقاف المنفذ نفسه دائماً. متغير البيئة `PORT` يبقى له الأولوية كما في `server.js`.
- `start.bat` لا يعلن نجاح التشغيل إلا بعد أن يجيب `/api/status` فعلياً ويستمع Nginx على منفذ المشاهدة؛ وإذا تعذّر تشغيل إحدى الخدمتين يطبع السبب ويعيد رمز خروج `1`.
- `stop.bat` لا يوقف إلا عمليات PrinceLive: خادم Node.js يُعرَف بمسار `%ROOT%\server.js` أو بملف `run/server.pid`، وNginx بمسار `nginx\nginx.exe` داخل المشروع (عبر `scripts\procs.js`). أي عملية أخرى تستخدم نفس المنفذ تُترك كما هي ويُطبع تنبيه باسمها.
- الإيقاف العادي لا يحذف السجلات: `logs\server.log` و`nginx\logs\*.log` تبقى للمراجعة. تُنظَّف فقط مقاطع HLS القديمة في `srv\hls` حتى لا يُعرض بث متوقف.

### التشغيل على Windows

1. تأكد من Node.js 18+ في `PATH`، ومن وجود `ffmpeg.exe` (و`ffprobe.exe` مستحسن) بجانب `server.js`، ومن أن منفذَي `settings.port` و`settings.nginxPort` غير مستخدمين.
2. انقر `scripts\start.bat`. الخطوات التي ينفّذها بالترتيب:
   - يقرأ المنفذين من `data.json` عبر `scripts\ports.js`، ويتحقق من وجود `server.js` و`config.json` وNode.js.
   - ينشئ المجلدات الناقصة: `logs` و`run` و`srv\hls` و`srv\uploads`.
   - إن لم تكن قاعدة `PrinceLive HTTP <nginxPort>` موجودة في جدار الحماية، يستدعي `scripts\firewall.bat` تلقائياً (نافذة UAC واحدة) لفتح منفذ المشاهدة ومنفذ لوحة الإدارة.
   - يشغّل الخادم في نافذة مصغّرة باسم **Prince Live API** (`node server.js`) وينتظر استجابة `GET /api/status` حتى 30 ثانية.
   - ينفّذ `nginx -t`، ويشغّل Nginx إن لم يكن يعمل، ثم ينتظر استماعه على منفذ المشاهدة حتى 10 ثوانٍ.
   - يطبع العنوانين ويعيد رمز خروج `0`، أو يطبع سبب الفشل ويعيد `1`.
3. بعد النجاح: `http://127.0.0.1:<nginxPort>/` لواجهة المشاهدين، و`http://127.0.0.1:<nginxPort>/admin/` للوحة الإدارة، و`http://127.0.0.1:<port>` وصول مباشر إلى خادم Node.
4. للوصول من أجهزة الشبكة المحلية نفّذ `scripts\allow-lan.bat` (يفوّض إلى `firewall.bat` لفتح المنفذين على الشبكة الخاصة)، ثم افتح `http://<IP-الجهاز>:<nginxPort>/`. وللإلغاء لاحقاً: `firewall.bat remove`.
5. للتشخيص فقط يمكن تشغيل الخادم يدوياً: `node server.js` من جذر المشروع؛ في هذه الحالة لا يبدأ Nginx تلقائياً، وشغّله بـ `nginx\nginx.exe -p "%CD%\nginx/" -c conf/nginx.conf`.

### الإيقاف على Windows

انقر `scripts\stop.bat`. ترتيب الإيقاف:

1. يقرأ المنفذين من `data.json`، ثم يطلب `POST /api/stop` من الخادم بترويسة رمز التحكّم المحلي `run\control.token` (مهلة 15 ثانية) لإيقاف كل القنوات وتفريغ مقاطع HLS.
2. يوقف Nginx الخاص بالمشروع فقط عبر `scripts\nginx-stop.bat`.
3. يوقف عملية Node الخاصة بالمشروع (عبر `run\server.pid` أو سطر أوامر يحتوي `server.js`) بـ `taskkill /T /F` ثم يعيد الفحص للتأكد من انتهائها.
4. ينظّف `srv\hls` ويحتفظ بالسجلات، ثم يطبع `Prince Live stopped` ورمز خروج `0`، أو `Prince Live did NOT stop completely` ورمز `1`.

- إن ظهرت رسالة تطلب صلاحيات مسؤول فشغّل `stop.bat` كمسؤول؛ إيقاف عملية Node أو Nginx بدأتها جلسة أخرى يحتاج صلاحية أعلى.
- إذا كان المنفذ مشغولاً ببرنامج آخر لم يبدأه المشروع فسيطبع اسمه ولا يوقفه.

### فحص الحالة قبل التشغيل وبعده

`scripts\check.bat` يطبع: إصدار Node، ووجود `server.js` و`config.json`، وصلاحية JSON وقيم `host` والمنافذ ومسارات FFmpeg وNginx وأبعاد الخرج وعدد المصادر والقنوات، ونتيجة `nginx -t`، وحالة استماع المنفذين، وملاك العمليات (Prince Live أم برنامج آخر).

### إعادة تشغيل Nginx أو إيقافه وحده

- `scripts\stop-nginx.bat`: يوقف Nginx الخاص بالمشروع فقط.
- `scripts\restart-nginx.bat`: يفحص الإعدادات أولاً، ثم يوقف نسخة المشروع ويعيد تشغيلها. لا يستخدم `nginx -s reload` لأن ملف الـpid قد يحمل معرّف عملية أخرى.

### بعد تغيير الإعدادات

- تغيير `port` أو `nginxPort` أو مسارات `ffmpegPath`/`ffprobePath`/`nginxPath` يحتاج إعادة تشغيل كاملة: `scripts\stop.bat` ثم `scripts\start.bat` (حفظ الإعدادات يحدّث `nginx\conf\nginx.conf` تلقائياً).
- إعدادات الترميز تُطبَّق على القناة عند تشغيلها التالي، فلا تحتاج إعادة تشغيل الخدمة كلها.
- لا تشغّل نسختين من المشروع على المنفذ نفسه: `start.bat` يرفض البدء ويسمّي البرنامج الذي يحتل المنفذ.

### على Linux

ملفات BAT مخصّصة لـ Windows. على Linux شغّل `node server.js` (مع `PORT` و`HOST` عند الحاجة) وأوقفه بـ `Ctrl+C` أو `kill`، وشغّل Nginx من حزمة النظام عند الحاجة لتقديم الواجهة على المنفذ 80.

## إدارة المصادر والقنوات

- مصدر USB: اختر جهاز الفيديو والصوت، ثم استخدم اكتشاف القدرات والضبط التلقائي. يختبر النظام عدة توليفات قصيرة قبل اختيار أول توليفة تنجح.
- مصدر HTTP/HLS أو RTSP: أدخل الرابط واستخدم اختبار المصدر الشبكي قبل الحفظ.
- لكل قناة مجلد مستقل في `srv/hls/<channelId>`، وتُحذف مقاطعه وقوائمه عند إيقاف القناة، ولا تُخدم ملفات قناة متوقفة أو محذوفة (تُرجع 404).
- رابط قائمة التشغيل: `/hls/<channelId>/index.m3u8`.
- لا يمكن تشغيل جهاز USB نفسه على قناتين في الوقت ذاته؛ ذلك يمنع تعارض الوصول إلى جهاز الالتقاط.
- حذف مصدر مرتبط بقناة مرفوض؛ احذف القناة أولاً.

## إعدادات الترميز: الافتراضي العام وتجاوز كل قناة

الترميز يُضبط على مستويين: قيمة افتراضية عامة في **الإعدادات ← الترميز**، وتجاوز اختياري داخل **نافذة القناة**. القناة التي تبقى على «افتراضي» لا تحتفظ بنسخة من القيم، بل تقرأ القيم العامة لحظة تشغيلها؛ فأي تعديل لاحق في الإعدادات العامة يسري عليها عند التشغيل التالي دون فتح القناة.

### الإعدادات العامة (`data.json` ← `settings`)

| المفتاح | المعنى | القيم |
| --- | --- | --- |
| `encodingMode` | وضع الترميز الافتراضي لكل القنوات | `bitrate` أو `crf` |
| `crfValue` | مستوى CRF الافتراضي | `18` / `20` / `23` / `26` / `28` (الافتراضي `23`) |
| `defaultBitrate` | بِتريت افتراضي للقنوات التي لا تحدّد بِتريت | مثل `1500k`؛ فارغ = يُحسب من جودة الخرج |
| `outputWidth` / `outputHeight` | أبعاد الخرج حين تكون جودة القناة `auto` | `640`×`360` افتراضياً، وتُقرَّب دائماً لأقرب رقم زوجي |
| `outputFps` | FPS الافتراضي | `20` |
| `x264Preset` / `x264Threads` | إعدادات مشفّر x264 | `veryfast` / `2` |
| `gopSeconds` | طول GOP | `2` |

### الإعدادات الخاصة بالقناة (`data.json` ← `channels[]`)

| المفتاح | المعنى | الوراثة |
| --- | --- | --- |
| `encodingMode` | وضع الترميز لهذه القناة | `""` = يتبع `settings.encodingMode`؛ أو `bitrate` / `crf` |
| `crfValue` | مستوى CRF للقناة | `""` أو `null` = يتبع `settings.crfValue`، وتحفظه الواجهة فقط عند اختيار وضع `crf` |
| `bitrate` | بِتريت القناة (وفي وضع CRF يعمل كسقف أعلى) | `""` = يتبع `settings.defaultBitrate` ثم قيمة الجودة |
| `fps` | FPS القناة | `""` = يتبع `settings.outputFps` |
| `quality` | جودة الخرج | `auto` = أبعاد `outputWidth`/`outputHeight`، أو `240p`/`360p`/`480p`/`720p`، أو `copy` |

### ترتيب الأولوية الفعلي عند بناء أمر FFmpeg

1. **وضع الترميز:** وضع القناة إن كان `bitrate` أو `crf`، وإلا وضع الإعدادات العامة.
2. **مستوى CRF:** `channel.crfValue` إن كان ضمن القيم المسموحة، وإلا `settings.crfValue` (و`23` إن كانت القيمة المحفوظة غير صالحة).
3. **البِتريت:** `channel.bitrate` ← `settings.defaultBitrate` ← قيمة تلقائية حسب دقة الخرج (`2000k` لـ720p وأعلى، `1000k` لـ480p، `500k` لما دون ذلك). أي قيمة غير صالحة تُستبدل بالقيمة التالية في السلسلة ويُكتب تنبيه في `logs/server.log`.
4. **الأبعاد وFPS:** جودة القناة إن حُدِّدت، وإلا `outputWidth`/`outputHeight` و`outputFps` من الإعدادات؛ والأبعاد تُجبَر على أن تكون زوجية حتى لا يفشل `yuv420p` في x264.

### وضع CRF مع بِتريت

في وضع `crf` لا يُفرض معدّل بت ثابت، بل يعمل `bitrate` كسقف أعلى (VBV: `-maxrate` مع `-bufsize` يساوي ضعف القيمة)، فيبقى الحقل مؤثراً دون إلغاء ثبات الجودة. تركه فارغاً يعني CRF بلا سقف. وفي وضع `bitrate` يُستخدم البِتريت مباشرة في `-b:v`.

### متى تُطبَّق التغييرات

عند التشغيل التالي للقناة: احفظ القناة ثم أعد تشغيلها من زر التشغيل/إعادة التشغيل (أو أعد تشغيل الخادم). وضع «نسخ المصدر» (`copy`) لا يمرّ بعملية ترميز إطلاقاً، فلا تؤثر فيه أي من هذه الحقول.

### مثال من `data.json`

```json
"settings": {
  "encodingMode": "bitrate",
  "crfValue": 23,
  "defaultBitrate": "",
  "outputWidth": 640,
  "outputHeight": 360
},
"channels": [
  { "id": "ch_1", "encodingMode": "crf", "crfValue": 26, "bitrate": "1200k" },
  { "id": "ch_2", "encodingMode": "", "crfValue": "", "bitrate": "" }
]
```

- `ch_1`: ترميز CRF بمستوى 26 وسقف 1200k، متجاوزاً الوضع العام.
- `ch_2`: يورث وضع الإعدادات العامة ومستوى CRF والبِتريت منها.
- القيمة القديمة `x264QualityMode: true` ما زالت مقروءة احتياطياً وتُعامل كوضع `crf`، ويُزامَن حقل `x264QualityMode` في الإعدادات تلقائياً مع `encodingMode`.

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
- الدخول إلى اللوحة يتم داخل الصفحة عبر `POST /api/login` ويُصدر كوكي جلسة HttpOnly موقّعاً صالحاً 12 ساعة ويُبطَل فوراً عند `POST /api/logout` (بحد أقصى 8 محاولات فاشلة لكل عنوان كل 10 دقائق)؛ ولا يوجد Basic Auth: الجلسة هي المصادقة الوحيدة، وسكربتات الجهاز (مثل `scripts/stop.bat`) تستخدم رمز التحكّم المحلي `run/control.token`. اللوحة مناسبة لشبكة محلية موثوقة فقط؛ لا تعرّضها مباشرة للإنترنت.
- هذه مرشح إصدار 8.0.1. ما زال يلزم اختبار الالتقاط الفعلي من أجهزة DirectShow على Windows 10، ومن أجهزة V4L2/ALSA على Linux، وقواعد جدار الحماية على جهاز Windows حقيقي.


## فحص الحزمة
من مجلد المشروع نفّذ:
```bat
npm test
```
ينفذ هذا الأمر فحوصاً ثابتة للملفات وJSON والعلاقات الأساسية. لا يستبدل اختبار كرت USB والصوت وNginx الحقيقي على Windows.


بيانات الدخول الأولية: اسم المستخدم `admin` وكلمة المرور `admin123` (محفوظة مشفّرة بـ scrypt في `admin` داخل `config.json`). غيّرها بعد أول دخول من **الإعدادات ← الأمان**.

الحزمة تضم نسخة Nginx لويندوز داخل مجلد `nginx/`، لكنها **لا تضم `ffmpeg.exe` ولا `ffprobe.exe`** حتى لا تُستبدل نسخة موجودة عندك؛ ضع `ffmpeg.exe` و`ffprobe.exe` في جذر المشروع بجانب `server.js`. يبحث الخادم عن `ffmpeg` بجانب `server.js` أولاً ثم في `PATH`، ولذلك يعمل التشغيل مباشرةً دون تعديل المسارات.
