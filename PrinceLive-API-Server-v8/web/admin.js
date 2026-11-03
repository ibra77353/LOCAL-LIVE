'use strict';

const $ = id => document.getElementById(id);
let captureModes = [];

function sourceInputSignature(form) {
  return JSON.stringify({
    type:getField(form,'type'), streamUrl:getField(form,'streamUrl'),
    videoDevice:getField(form,'videoDevice'), audioDevice:getField(form,'audioDevice'),
    videoSize:getField(form,'videoSize'), fps:getField(form,'fps'), pixelFormat:getField(form,'pixelFormat')
  });
}
function sourceAudioSignature(form) {
  return JSON.stringify({audioDevice:getField(form,'audioDevice')});
}

async function api(url, method = 'GET', body) {
  const options = { method, cache: 'no-store', headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || data.message || `HTTP ${response.status}`);
  return data;
}

function showMessage(message, isError = false, target = 'action-message') {
  const el = $(target);
  if (!el) return;
  if (target === 'action-message') {
    el.replaceChildren();
    const dot = document.createElement('span'); dot.className = 'message-dot';
    el.append(dot, document.createTextNode(' ' + message));
  } else el.textContent = message;
  el.style.color = isError ? '#ff9c90' : '';
}

function setField(form, name, value) {
  const field = form.elements.namedItem(name);
  if (!field) return;
  if (field.type === 'checkbox') field.checked = !!value;
  else field.value = value == null ? '' : String(value);
}
function getField(form, name) {
  const field = form.elements.namedItem(name);
  if (field.type === 'checkbox') return field.checked;
  if (field.type === 'number') return field.value === '' ? undefined : Number(field.value);
  return field.value;
}

function askConfirmation(message, title = 'تأكيد العملية') {
  return new Promise(resolve => {
    const dialog = $('confirm-dialog');
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = message;
    const yes = $('confirm-yes');
    const finish = value => {
      yes.removeEventListener('click', onYes);
      dialog.removeEventListener('close', onClose);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onYes = () => finish(true);
    const onClose = () => finish(false);
    yes.addEventListener('click', onYes, { once: true });
    dialog.addEventListener('close', onClose, { once: true });
    dialog.showModal();
  });
}

async function loadSettings() {
  const form = $('settings-form');
  try {
    const { settings } = await api('/api/settings');
    for (const key of ['siteName','siteNameLatin','phone','logo','ticker','tickerEnabled','autoStartOnDemand','playerMaxBufferLength','playerBackBufferLength','playerLiveSyncDuration','cpuSaverDefault','capLevelToPlayerSize','ffmpegPath','ffprobePath','nginxPath','x264Preset','x264Threads','x264QualityMode','outputWidth','outputHeight','outputFps','gopSeconds','hlsTime','hlsListSize','hlsDeleteThreshold','port','nginxPort','startupQueueDelayMs','autoRestartCrashed','maxRestarts','restartBackoffMs','idleStopEnabled','idleStopMinutes']) setField(form, key, settings[key]);

  } catch (error) { showMessage(`تعذر تحميل الإعدادات: ${error.message}`, true, 'settings-message'); }
}

async function loadChannel(selectedId) {
  const form = $('channel-form');
  try {
    const [{channels},{sources}] = await Promise.all([api('/api/channels'),api('/api/sources')]);
    const select = $('channel-select'), sourceSelect=$('channel-source-select');
    select.replaceChildren(); sourceSelect.replaceChildren();
    for(const source of sources||[]){const o=document.createElement('option');o.value=source.id;o.textContent=`${source.name} · ${source.type}`;sourceSelect.append(o);}
    for (const channel of channels || []) { const option=document.createElement('option'); option.value=channel.id; option.textContent=`${channel.name} · ${channel.id}`; select.append(option); }
    const channel=(channels||[]).find(x=>x.id===selectedId)||(channels||[])[0];
    if(!channel){form.dataset.channelId='';showMessage('لا توجد قنوات بعد. أضف مصدراً لإنشاء أول قناة تلقائياً.',false,'channel-message');return;}
    select.value=channel.id;
    for(const key of ['name','category','cover','quality','fps','bitrate','enabled','autoStart','alwaysOn','sortOrder','sourceId'])setField(form,key,channel[key]);
    form.dataset.channelId=channel.id;
  } catch(error){showMessage(`تعذر تحميل بيانات القناة: ${error.message}`,true,'channel-message');}
}

function fillDeviceSelect(select, devices, selectedValue, emptyLabel) {
  const previous = selectedValue == null ? select.value : String(selectedValue);
  select.replaceChildren();
  if (emptyLabel !== null) {
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = emptyLabel;
    select.append(empty);
  }
  const values = Array.isArray(devices) ? devices : [];
  if (previous && !values.includes(previous)) {
    const saved = document.createElement('option');
    saved.value = previous;
    saved.textContent = `${previous} (القيمة المحفوظة؛ لم تظهر في الفحص الأخير)`;
    select.append(saved);
  }
  for (const device of values) {
    const option = document.createElement('option');
    option.value = device;
    option.textContent = device;
    select.append(option);
  }
  if (previous) select.value = previous;
  else if (emptyLabel !== null) select.value = '';
}

function fillOptions(select, values, selectedValue, labelForEmpty) {
  const previous = selectedValue == null ? select.value : String(selectedValue);
  select.replaceChildren();
  const unique = [...new Set((values || []).map(v => String(v)).filter(Boolean))];
  if (!unique.length) {
    const option = document.createElement('option'); option.value = previous || ''; option.textContent = previous || labelForEmpty || 'غير متاح'; select.append(option);
  } else {
    for (const value of unique) { const option = document.createElement('option'); option.value = value; option.textContent = value; select.append(option); }
    if (previous && !unique.includes(previous)) { const saved = document.createElement('option'); saved.value = previous; saved.textContent = `${previous} (القيمة المحفوظة)`; select.append(saved); }
  }
  if (previous) select.value = previous;
}

function updateSourceTypeFields() {
  const form = $('source-form');
  const network = ['http-hls','rtsp'].includes(getField(form, 'type'));
  $('stream-url-field').hidden = !network;
  for (const id of ['video-device-field','audio-device-field','video-size-field','fps-field','pixel-format-field']) $(id).hidden = network;
  $('devices').hidden = network;
  $('auto-config').hidden = network;
  if($('source-auto-config'))$('source-auto-config').hidden=network;
  if($('source-devices'))$('source-devices').hidden=network;
  const urlInput = form.elements.namedItem('streamUrl');
  urlInput.required = network;
  form.elements.namedItem('videoDevice').required = !network;
  form.elements.namedItem('videoSize').required = !network;
  form.elements.namedItem('fps').required = !network;
  $('device-output').textContent = network
    ? 'مصدر شبكي: سيتم تمرير رابط HTTP/HLS إلى FFmpeg. لا تُستخدم قوائم DirectShow في هذا الوضع.'
    : 'مصدر USB محلي: افحص الأجهزة ثم اختر الإعدادات المدعومة.';
}

function updateCaptureModeOptions(){
  const form=$('source-form'); if(!captureModes.length)return;
  const size=getField(form,'videoSize'), pixel=getField(form,'pixelFormat');
  const matching=captureModes.filter(m=>(!size||m.videoSize===size)&&(!pixel||m.pixelFormat===pixel));
  const fpsValues=[...new Set(matching.map(m=>String(m.fps)))].sort((a,b)=>Number(a)-Number(b));
  if(fpsValues.length)fillOptions(form.elements.namedItem('fps'),fpsValues,fpsValues.includes(String(getField(form,'fps')))?String(getField(form,'fps')):fpsValues[fpsValues.length-1],'لا توجد معدلات لهذه الدقة');
}
async function autoConfigureCapture() {
  const button = $('auto-config'); const form = $('source-form');
  if (['http-hls','rtsp'].includes(getField(form, 'type'))) return showMessage('الضبط التلقائي للدقات خاص بمصادر USB؛ المصدر الشبكي يحدد صيغته من الرابط.', true, 'source-message');
  button.disabled = true; button.textContent = 'جارٍ تحليل قدرات القطعة…';
  $('device-output').hidden = false; $('device-output').textContent = 'يقرأ FFmpeg الدقات ومعدلات الإطارات وتنسيقات الفيديو المدعومة…';
  try {
    await refreshCaptureDevices(getField(form, 'videoDevice'), getField(form, 'audioDevice'));
    const videoDevice = getField(form, 'videoDevice');
    if (!videoDevice) throw new Error('لم يتم اكتشاف جهاز فيديو. تحقق من توصيل القطعة ثم أعد الفحص.');
    const audioDevice = getField(form, 'audioDevice');
    const result = await api(`/api/devices/capabilities?videoDevice=${encodeURIComponent(videoDevice)}${audioDevice ? `&audioDevice=${encodeURIComponent(audioDevice)}` : ''}`);
    const caps = result.capabilities || {};
    if (!caps.videoSizes?.length) throw new Error('لم يستطع FFmpeg استخراج قدرات الدقة لهذا الجهاز. جرّب جهازًا آخر أو تحقق من تعريف القطعة.');
    captureModes = caps.modes || [];
    const preferred = [...captureModes].sort((a,b)=>{
      const score=m=>((m.pixelFormat==='mjpeg'?100:0)+(m.videoSize==='1280x720'?80:0)+(m.fps===30?40:m.fps===25?35:m.fps<=30?20:0)+(Number(m.videoSize.split('x')[0])<=1920?10:0));
      return score(b)-score(a);
    });
    const candidates=preferred.length?preferred.slice(0,8):[{videoSize:caps.recommended?.videoSize||'1280x720',fps:Number(caps.recommended?.fps)||30,pixelFormat:caps.recommended?.pixelFormat||caps.pixelFormats?.[0]||'mjpeg'}];
    let accepted=null, failures=[];
    for(const candidate of candidates){
      setField(form,'videoSize',candidate.videoSize);setField(form,'fps',candidate.fps);setField(form,'pixelFormat',candidate.pixelFormat);
      try{await api('/api/devices/test','POST',{videoDevice,audioDevice,videoSize:candidate.videoSize,fps:candidate.fps,pixelFormat:candidate.pixelFormat});accepted=candidate;break;}
      catch(e){failures.push(`${candidate.pixelFormat} ${candidate.videoSize}@${candidate.fps}: ${e.message.slice(0,180)}`);}
    }
    if(!accepted)throw new Error('تم اكتشاف الأوضاع لكن فشل اختبار جميع التوليفات الأولية. '+failures.slice(0,3).join(' | '));
    fillOptions(form.elements.namedItem('videoSize'), caps.videoSizes, accepted.videoSize, 'لا توجد دقات مدعومة');
    fillOptions(form.elements.namedItem('pixelFormat'), caps.pixelFormats, accepted.pixelFormat, 'تلقائي');
    updateCaptureModeOptions();setField(form,'fps',accepted.fps);
    if (caps.audioDevices) fillDeviceSelect(form.elements.namedItem('audioDevice'), caps.audioDevices, audioDevice, 'بدون صوت');
    $('device-output').textContent = `تم تحليل واختبار: ${videoDevice}
الدقات المكتشفة: ${caps.videoSizes.join(', ')}
معدلات الإطارات المكتشفة: ${caps.frameRates.join(', ')}
التنسيقات: ${caps.pixelFormats.join(', ') || 'لم يحددها FFmpeg'}
التوليفة التي اجتازت اختبار الالتقاط: ${accepted.pixelFormat} · ${accepted.videoSize} @ ${accepted.fps} FPS
${result.note || ''}`;
    form.dataset.videoTestSignature=sourceInputSignature(form);
    if(audioDevice) delete form.dataset.audioTestSignature;
    showMessage('نجح اختبار أفضل توليفة متاحة. راجع الإعدادات ثم احفظ المصدر.', false, 'source-message');
  } catch (error) {
    $('device-output').textContent = `تعذر الضبط التلقائي: ${error.message}`;
    showMessage(`تعذر الضبط التلقائي: ${error.message}`, true, 'source-message');
  } finally { button.disabled = false; button.innerHTML = '<span>✦</span> ضبط تلقائي للقطعة المناسبة'; }
}

async function refreshCaptureDevices(selectedVideo, selectedAudio) {
  const result = await api('/api/devices');
  const form = $('source-form');
  fillDeviceSelect(form.elements.namedItem('videoDevice'), result.devices?.video || [], selectedVideo, 'اختر جهاز الفيديو…');
  fillDeviceSelect(form.elements.namedItem('audioDevice'), result.devices?.audio || [], selectedAudio, 'بدون صوت');
  $('device-output').hidden = false;
  $('device-output').textContent = result.output || result.note || 'اكتمل فحص الأجهزة.';
  return result;
}

async function loadNetworkInterfaces() {
  const box = $('network-addresses');
  const message = $('network-message');
  if (!box) return;
  box.textContent = 'جارٍ اكتشاف عناوين IPv4…';
  try {
    const result = await api('/api/network/interfaces');
    box.replaceChildren();
    if (!result.interfaces?.length) {
      box.textContent = 'لم يتم العثور على عناوين IPv4 خارجية. تحقق من اتصال Ethernet أو Wi-Fi.';
      return;
    }
    for (const item of result.interfaces) {
      const row = document.createElement('div');
      row.className = 'network-address-row';
      const details = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = item.address;
      const meta = document.createElement('small');
      meta.textContent = `${item.name} · ${item.cidr || item.netmask}`;
      details.append(title, meta);
      const link = document.createElement('a');
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'فتح صفحة المشاهدة ↗';
      const copy = document.createElement('button');
      copy.type = 'button'; copy.className = 'btn btn-secondary'; copy.textContent = 'نسخ الرابط';
      copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(item.url); copy.textContent = 'تم النسخ'; } catch { message.textContent = item.url; } });
      row.append(details, link, copy);
      box.append(row);
    }
    message.textContent = `تم اكتشاف ${result.interfaces.length} عنوانًا. افتح الرابط الموافق للشبكة المتصل بها هاتفك.`;
  } catch (error) {
    box.textContent = `تعذر اكتشاف عناوين الشبكة: ${error.message}`;
    if (message) message.textContent = 'تأكد من تشغيل الخادم وتسجيل الدخول إلى الإدارة.';
  }
}

async function loadSource(selectedId) {
  const form=$('source-form');
  try{
    const {sources}=await api('/api/sources'); const list=$('source-select'); list.replaceChildren();
    for(const source of sources||[]){const o=document.createElement('option');o.value=source.id;o.textContent=`${source.name} · ${source.type}`;list.append(o);}
    const source=(sources||[]).find(x=>x.id===selectedId)||(sources||[])[0];
    if(!source){delete form.dataset.sourceId;showMessage('لا توجد مصادر. أضف مصدراً جديداً.',false,'source-message');return;}
    for(const key of ['name','type','streamUrl','videoSize','fps','pixelFormat','enabled'])setField(form,key,source[key]);
    form.dataset.sourceId=source.id;list.value=source.id;
    form.dataset.originalInputSignature=sourceInputSignature(form);
    form.dataset.originalAudioSignature=sourceAudioSignature(form);
    delete form.dataset.videoTestSignature; delete form.dataset.audioTestSignature;
    fillDeviceSelect(form.elements.namedItem('videoDevice'),[],source.videoDevice,'جارٍ تحميل أجهزة الفيديو…');
    fillDeviceSelect(form.elements.namedItem('audioDevice'),[],source.audioDevice,'بدون صوت'); updateSourceTypeFields();
    if(['http-hls','rtsp'].includes(getField(form,'type'))){$('device-output').hidden=false;$('device-output').textContent='مصدر شبكي HTTP/HLS.';}
    else try{await refreshCaptureDevices(source.videoDevice,source.audioDevice);}catch(e){$('device-output').hidden=false;$('device-output').textContent=`تعذر اكتشاف الأجهزة: ${e.message}`;}
  }catch(error){showMessage(`تعذر تحميل بيانات المصدر: ${error.message}`,true,'source-message');}
}

async function refreshStatus() {
  try {
    const [status,statsResult,channelResult]=await Promise.all([api('/api/status'),api('/api/stats'),api('/api/channels')]);
    const stats=statsResult.stats||{}, channels=channelResult.channels||[];
    $('running').textContent=`${stats.channels?.running||0} / ${stats.channels?.total||0} قناة تعمل`;
    const strip=$('live-strip');strip.classList.toggle('live',(stats.channels?.running||0)>0);
    $('live-label').textContent=(stats.channels?.running||0)>0?`ON AIR · ${stats.channels.running} قناة`:'OFF AIR · لا توجد قنوات تعمل';
    $('playlist').textContent=`${stats.channels?.running||0} قائمة HLS نشطة`;
    $('restarts').textContent=String(channels.reduce((n,c)=>n+(c.restarts||0),0));
    $('source').textContent=`مصادر: ${stats.devices?.total||0} | CPU: ${stats.cpuPercent==null?'—':stats.cpuPercent+'%'} | ذاكرة الخادم: ${stats.memoryMb??'—'} MB | المشاهدون: ${stats.viewers??0} | HLS: ${formatBytes(stats.hlsBytes||0)}`;
    const list=$('channel-status-list'); if(list){list.replaceChildren();for(const c of channels){const row=document.createElement('div');row.className='channel-status-row';const info=document.createElement('div');const name=document.createElement('strong');name.textContent=c.name;const meta=document.createElement('small');meta.textContent=`${c.status} · ${c.quality} · ${c.viewers||0} مشاهد`;info.append(name,meta);const actions=document.createElement('div');actions.className='channel-status-actions';for(const [action,label] of [['start','تشغيل'],['stop','إيقاف']]){const b=document.createElement('button');b.type='button';b.className='btn btn-secondary';b.textContent=label;b.addEventListener('click',async()=>{try{await api(`/api/channels/${encodeURIComponent(c.id)}/${action}`,'POST',{});await refreshStatus();}catch(e){showMessage(e.message,true);}});actions.append(b);}row.append(info,actions);list.append(row);}}
    try {const logData=await api('/api/logs');$('logs').textContent=logData.logs||'لا توجد رسائل بعد.';}catch{$('logs').textContent='تعذر تحميل السجل.';}
  } catch(error){showMessage(`تعذر جلب حالة الخادم: ${error.message}`,true);}
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024*1024) return `${(value/1024).toFixed(1)} KB`;
  return `${(value/1024/1024).toFixed(1)} MB`;
}

$('start').addEventListener('click', async () => {
  $('start').disabled = true;
  try { const id=$('channel-form').dataset.channelId; if(!id)throw new Error('اختر قناة أولاً'); const result=await api(`/api/channels/${encodeURIComponent(id)}/start`,'POST',{});showMessage(result.message||'تم إرسال أمر التشغيل.'); }
  catch (error) { showMessage(`فشل تشغيل القناة: ${error.message}`, true); }
  finally { $('start').disabled = false; refreshStatus(); }
});
$('stop').addEventListener('click', async () => {
  $('stop').disabled = true;
  try { const id=$('channel-form').dataset.channelId; if(!id)throw new Error('اختر قناة أولاً'); const result=await api(`/api/channels/${encodeURIComponent(id)}/stop`,'POST',{});showMessage(result.message||'تم إرسال أمر الإيقاف.'); }
  catch (error) { showMessage(`فشل إيقاف القناة: ${error.message}`, true); }
  finally { $('stop').disabled = false; refreshStatus(); }
});
$('auto-config').addEventListener('click', autoConfigureCapture);

// أزرار تشغيل/إيقاف/إعادة تشغيل القناة المحددة كانت موجودة في الواجهة بلا أي
// مستمع نقر، فلم تكن تعمل إطلاقاً. تُنفَّذ الآن على القناة المحددة في نموذج القناة.
async function runChannelAction(action, doneMessage) {
  const id = $('channel-form').dataset.channelId;
  if (!id) return showMessage('اختر قناة أولاً.', true);
  const button = $('channel-' + action);
  if (button) button.disabled = true;
  try {
    const result = await api(`/api/channels/${encodeURIComponent(id)}/${action}`, 'POST', {});
    showMessage(result.message || doneMessage);
  } catch (error) { showMessage(`فشل تنفيذ الأمر: ${error.message}`, true); }
  finally { if (button) button.disabled = false; refreshStatus(); }
}
$('channel-start')?.addEventListener('click', () => runChannelAction('start', 'تم إرسال أمر تشغيل القناة.'));
$('channel-stop')?.addEventListener('click', () => runChannelAction('stop', 'تم إرسال أمر إيقاف القناة.'));
$('channel-restart')?.addEventListener('click', () => runChannelAction('restart', 'تم طلب إعادة تشغيل القناة.'));

$('source-form').elements.namedItem('type').addEventListener('change', updateSourceTypeFields);
$('test-audio')?.addEventListener('click',async()=>{const form=$('source-form');if(!getField(form,'audioDevice'))return showMessage('اختر جهاز صوت أولاً.',true,'source-message');const b=$('test-audio');b.disabled=true;try{const r=await api('/api/devices/test-audio','POST',{audioDevice:getField(form,'audioDevice')});form.dataset.audioTestSignature=sourceAudioSignature(form);showMessage(r.result?.output||'نجح اختبار الصوت.',false,'source-message');}catch(e){showMessage(e.message,true,'source-message');}finally{b.disabled=false;}});
$('source-form').elements.namedItem('videoSize').addEventListener('change',updateCaptureModeOptions);
$('source-form').elements.namedItem('pixelFormat').addEventListener('change',updateCaptureModeOptions);
$('source-form').elements.namedItem('fps').addEventListener('change',updateCaptureModeOptions);
$('source-auto-config')?.addEventListener('click',autoConfigureCapture);
$('source-devices')?.addEventListener('click',async()=>{try{await refreshCaptureDevices(getField($('source-form'),'videoDevice'),getField($('source-form'),'audioDevice'));showMessage('تم تحديث الأجهزة المكتشفة.',false,'source-message');}catch(e){showMessage(e.message,true,'source-message');}});

$('test-source')?.addEventListener('click',async()=>{
  const form=$('source-form'); if(['http-hls','rtsp'].includes(getField(form,'type'))){const button=$('test-source');button.disabled=true;try{const r=await api('/api/sources/test','POST',{streamUrl:getField(form,'streamUrl')});form.dataset.videoTestSignature=sourceInputSignature(form);showMessage(r.result?.output||'نجح اختبار المصدر الشبكي.',false,'source-message');}catch(e){showMessage(e.message,true,'source-message');}finally{button.disabled=false;}return;}
  const button=$('test-source');button.disabled=true;button.textContent='جارٍ اختبار الالتقاط لمدة 3 ثوانٍ…';
  try{const result=await api('/api/devices/test','POST',{videoDevice:getField(form,'videoDevice'),audioDevice:getField(form,'audioDevice'),videoSize:getField(form,'videoSize'),fps:getField(form,'fps'),pixelFormat:getField(form,'pixelFormat')});form.dataset.videoTestSignature=sourceInputSignature(form);showMessage(result.result?.output||'نجح اختبار المصدر.',false,'source-message');}
  catch(e){showMessage(`فشل اختبار المصدر: ${e.message}`,true,'source-message');}
  finally{button.disabled=false;button.textContent='اختبار المصدر قبل الحفظ';}
});

$('devices').addEventListener('click', async () => {
  const form = $('source-form');
  if (['http-hls','rtsp'].includes(getField(form, 'type'))) return showMessage('المصدر الشبكي لا يحتاج إلى فحص أجهزة USB.', false, 'source-message');
  $('devices').disabled = true; $('device-output').hidden = false; $('device-output').textContent = 'جارٍ فحص أجهزة الالتقاط…';
  try {
    await refreshCaptureDevices(getField(form, 'videoDevice'), getField(form, 'audioDevice'));
    showMessage('تم تحديث قوائم أجهزة الفيديو والصوت.', false, 'source-message');
  } catch (error) {
    $('device-output').textContent = `فشل فحص الأجهزة: ${error.message}`;
    showMessage(`فشل فحص الأجهزة: ${error.message}`, true, 'source-message');
  } finally { $('devices').disabled = false; }
});

$('source-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.dataset.sourceId;
  const payload = { type: getField(form, 'type'), name: getField(form, 'name'), enabled: getField(form, 'enabled') };
  if (['http-hls','rtsp'].includes(payload.type)) payload.streamUrl = getField(form, 'streamUrl');
  else for (const key of ['videoDevice','audioDevice','videoSize','fps','pixelFormat']) payload[key] = getField(form,key);
  const currentInputSignature=sourceInputSignature(form);
  const inputChanged=!id || currentInputSignature!==form.dataset.originalInputSignature;
  if(inputChanged && form.dataset.videoTestSignature!==currentInputSignature) {
    return showMessage('اختبر المصدر بالإعدادات الحالية قبل الحفظ. إذا غيّرت الدقة أو FPS أو التنسيق، أعد الاختبار.',true,'source-message');
  }
  if(inputChanged && payload.type==='usb' && payload.audioDevice &&
     form.dataset.audioTestSignature!==sourceAudioSignature(form)) {
    return showMessage('اختبر جهاز الصوت المحدد قبل حفظ المصدر.',true,'source-message');
  }
  try {
    const result = id
      ? await api(`/api/sources/${encodeURIComponent(id)}`,'PUT',payload)
      : await api('/api/sources','POST',payload);
    if (result.source?.id) form.dataset.sourceId = result.source.id;
    showMessage(id ? 'تم حفظ المصدر.' : 'تم حفظ المصدر وإنشاء قناة مرتبطة به تلقائياً.', false, 'source-message');
    await loadSource(result.source?.id || id);
    await loadChannel(result.channel?.id);
    $('source-dialog').close();
    refreshStatus();
  } catch (error) { showMessage(`لم يتم حفظ المصدر: ${error.message}`, true, 'source-message'); }
});

updateSourceTypeFields();

$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = {};
  for (const key of ['siteName','siteNameLatin','phone','logo','ticker','tickerEnabled','autoStartOnDemand','playerMaxBufferLength','playerBackBufferLength','playerLiveSyncDuration','cpuSaverDefault','capLevelToPlayerSize','ffmpegPath','ffprobePath','nginxPath','x264Preset','x264Threads','x264QualityMode','outputWidth','outputHeight','outputFps','gopSeconds','hlsTime','hlsListSize','hlsDeleteThreshold','port','nginxPort','startupQueueDelayMs','autoRestartCrashed','maxRestarts','restartBackoffMs','idleStopEnabled','idleStopMinutes']) payload[key] = getField(form,key);
  try {
    await api('/api/settings','PUT',payload);
    showMessage('تم حفظ الإعدادات بنجاح.', false, 'settings-message');
    $('settings-dialog').close();
    refreshStatus();
  } catch (error) { showMessage(`لم يتم الحفظ: ${error.message}`, true, 'settings-message'); }
});

$('channel-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.dataset.channelId;
  if (!id) return showMessage('معرّف القناة غير متوفر.', true, 'channel-message');
  const payload = {};
  for (const key of ['name','category','cover','quality','fps','bitrate','enabled','autoStart','alwaysOn','sortOrder','sourceId']) payload[key] = getField(form,key);
  try {
    await api(`/api/channels/${encodeURIComponent(id)}`,'PUT',payload);
    showMessage('تم حفظ بيانات القناة. أعد تشغيل القناة لتطبيق إعدادات الجودة الجديدة.', false, 'channel-message');
    $('channel-dialog').close();
    refreshStatus();
  } catch (error) { showMessage(`لم يتم حفظ القناة: ${error.message}`, true, 'channel-message'); }
});


$('open-settings')?.addEventListener('click', async () => { await loadSettings(); $('settings-dialog').showModal(); });

$('new-source')?.addEventListener('click', () => {
  const form = $('source-form'); form.reset(); delete form.dataset.sourceId; delete form.dataset.originalInputSignature; delete form.dataset.videoTestSignature; delete form.dataset.audioTestSignature; $('source-dialog-title').textContent='إضافة مصدر';
  setField(form,'type','usb'); setField(form,'enabled',true);
  updateSourceTypeFields();
  showMessage('أدخل بيانات المصدر ثم احفظه. ستُنشأ قناة مرتبطة به تلقائياً.', false, 'source-message');
  $('source-dialog').showModal();
});
$('edit-source')?.addEventListener('click',()=>{if(!$('source-form').dataset.sourceId)return showMessage('لا يوجد مصدر محدد.',true,'source-message');$('source-dialog-title').textContent='تعديل مصدر';$('source-dialog').showModal();});
$('delete-source')?.addEventListener('click',async()=>{const id=$('source-form').dataset.sourceId;if(!id)return;if(!await askConfirmation('حذف المصدر المحدد؟ يجب حذف القناة المرتبطة به أولاً.','تأكيد حذف المصدر'))return;try{await api(`/api/sources/${encodeURIComponent(id)}`,'DELETE');await loadSource();await loadChannel();refreshStatus();showMessage('تم حذف المصدر.');}catch(e){showMessage(e.message,true,'source-message');}});
$('edit-channel')?.addEventListener('click',()=>{if(!$('channel-form').dataset.channelId)return showMessage('لا توجد قناة محددة.',true,'channel-message');$('channel-dialog').showModal();});
$('delete-channel')?.addEventListener('click',async()=>{const id=$('channel-form').dataset.channelId;if(!id)return; if(!await askConfirmation('هل تريد حذف القناة المحددة؟','تأكيد حذف القناة'))return;try{await api(`/api/channels/${encodeURIComponent(id)}`,'DELETE');await loadChannel();refreshStatus();showMessage('تم حذف القناة.',false,'channel-message');}catch(e){showMessage(e.message,true,'channel-message');}});
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>$(b.dataset.close).close()));
$('channel-select')?.addEventListener('change', event => loadChannel(event.target.value));
$('source-select')?.addEventListener('change', event => loadSource(event.target.value));
for (const action of ['start','stop','restart']) $('channel-'+action)?.addEventListener('click', async () => { const id=$('channel-form').dataset.channelId; if(!id)return; try{const r=await api(`/api/channels/${encodeURIComponent(id)}/${action}`,'POST',{});showMessage(r.message||'تم تنفيذ الأمر.',false,'channel-message');}catch(e){showMessage(e.message,true,'channel-message');} refreshStatus(); });

$('refresh-network')?.addEventListener('click', loadNetworkInterfaces);
loadNetworkInterfaces();
loadSettings();
loadChannel();
loadSource();
refreshStatus();
setInterval(refreshStatus, 3000);
