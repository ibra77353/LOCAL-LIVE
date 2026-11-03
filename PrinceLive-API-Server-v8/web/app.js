'use strict';

const $ = id => document.getElementById(id);
const video = $('video');
let hls = null;
let currentPlaylist = '';
let playerLoaded = false;
let retryTimer = null;
let retryCount = 0;
let cpuSaver = false;
let settings = {};
let channelId = '';
let channels = [];
const viewerId = (() => { try { return crypto.randomUUID().replace(/-/g,''); } catch { return 'v' + Math.random().toString(36).slice(2) + Date.now().toString(36); } })();

async function api(url, method = 'GET', body) {
  const options = { method, cache: 'no-store', headers: {} };
  if (body !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function setPlaceholder(show) { $('placeholder').hidden = !show; }
function destroyPlayer() {
  if (hls) { hls.destroy(); hls = null; }
  video.pause(); video.removeAttribute('src'); video.load(); currentPlaylist = ''; playerLoaded = false;
}
function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; refresh(); }, cpuSaver ? 7000 : 3000);
}
function loadPlayer() {
  const src = `/hls/${encodeURIComponent(channelId)}/index.m3u8?t=` + Date.now();
  currentPlaylist = src; playerLoaded = true;
  if (hls) { hls.destroy(); hls = null; }
  if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = src; video.play().catch(() => {}); return; }
  if (window.Hls && Hls.isSupported()) {
    hls = new Hls({
      liveSyncDuration: Number(settings.playerLiveSyncDuration) || 4,
      maxBufferLength: cpuSaver ? 8 : (Number(settings.playerMaxBufferLength) || 20),
      backBufferLength: cpuSaver ? 0 : (Number(settings.playerBackBufferLength) || 10),
      capLevelToPlayerSize: settings.capLevelToPlayerSize !== false,
      enableWorker: true
    });
    hls.loadSource(src); hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => { retryCount = 0; video.play().catch(() => {}); });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && retryCount < 3) { retryCount++; hls.startLoad(); }
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && retryCount < 3) { retryCount++; hls.recoverMediaError(); }
      else { destroyPlayer(); setPlaceholder(true); scheduleRetry(); }
    });
  } else { playerLoaded = false; $('state').textContent = 'المتصفح لا يدعم HLS؛ استخدم متصفحًا حديثًا.'; }
}
async function loadPublicConfig() {
  try {
    const result = await api('/api/public/settings');
    settings = result.settings || {};
    if (settings.siteName) { document.title = settings.siteName + ' | BRINCE Live'; $('siteName').textContent = settings.siteName; }
    if (settings.ticker) $('ticker').textContent = settings.ticker;
    $('ticker').hidden = settings.tickerEnabled === false;
    if (settings.logo) { const logo = document.querySelector('.brand-logo'); if (logo) logo.src = settings.logo.startsWith('/') ? settings.logo : '/' + settings.logo; }
    if (settings.phone) { const footer = document.querySelector('main footer'); if (footer) footer.textContent = `البرنس لايف · للتواصل: ${settings.phone} · البث عبر الشبكة المحلية.`; }
    if (settings.cpuSaverDefault && !sessionStorage.getItem('cpuSaverUserChoice')) setCpuSaver(true);
  } catch {}
  try {
    const result = await api('/api/public/channels');
    channels = result.channels || [];
    const list=$('channel-list'); list.replaceChildren();
    for(const channel of channels){const button=document.createElement('button');button.type='button';button.className='channel-chip';button.textContent=channel.name;button.addEventListener('click',()=>selectChannel(channel.id));list.append(button);}
    if(channels.length) selectChannel(channels[0].id);
  } catch {}
}
function selectChannel(id){
  const channel=channels.find(x=>x.id===id); if(!channel)return;
  if(channelId===id && playerLoaded)return;
  channelId=id; destroyPlayer();
  const title=$('current-channel-name'); if(title)title.textContent=channel.name||'البث المباشر';
  const quality=document.querySelector('.quality'); if(quality)quality.textContent=`${channel.quality||'360p'} · HLS`;
  const placeholder=$('placeholder'); placeholder.style.backgroundImage='';
  if(channel.cover){placeholder.style.backgroundImage=`linear-gradient(rgba(4,13,24,.75),rgba(4,13,24,.88)),url("${String(channel.cover).replace(/["\\]/g,'')}")`;placeholder.style.backgroundSize='cover';}
  document.querySelectorAll('.channel-chip').forEach((b,i)=>b.classList.toggle('active',channels[i]?.id===id));
  requestWatch(); refresh();
}
async function requestWatch() { try { await api('/api/public/watch','POST',{ id: channelId, viewerId }); } catch {} }
async function heartbeat() { try { await api('/api/public/heartbeat','POST',{ viewerId, channelId }); } catch {} }
function setCpuSaver(enabled) {
  cpuSaver = !!enabled;
  $('cpuSaver').setAttribute('aria-pressed', String(cpuSaver));
  $('cpuSaver').textContent = cpuSaver ? 'توفير الموارد: مفعّل' : 'توفير الموارد';
  if (hls && playerLoaded) {
    const pos = video.currentTime;
    destroyPlayer(); loadPlayer();
    video.addEventListener('loadedmetadata', () => { if (Number.isFinite(pos)) video.currentTime = pos; }, { once: true });
  }
}
async function refresh() {
  try {
    const status = await api('/api/status?channelId='+encodeURIComponent(channelId));
    if (status.siteName) { document.title = status.siteName + ' | BRINCE Live'; const name = $('siteName'); if (name) name.textContent = status.siteName; }
    if (status.ticker) { const ticker = $('ticker'); if (ticker) ticker.textContent = ticker.hidden ? '' : status.ticker; }
    const playlistFresh = status.playlistExists && status.playlistAgeMs < 15000;
    $('state').textContent = status.running ? (playlistFresh ? 'البث المباشر يعمل' : 'جارٍ تجهيز البث…') : 'البث متوقف حاليًا';
    $('source').textContent = status.audioEnabled ? 'بث مباشر بالصوت والصورة' : 'بث مباشر — الصوت غير متاح حاليًا';
    if (status.running && playlistFresh) { setPlaceholder(false); if (!playerLoaded || !currentPlaylist) loadPlayer(); }
    else { setPlaceholder(true); if ((!status.running || !playlistFresh) && playerLoaded) destroyPlayer(); if (status.running) scheduleRetry(); }
  } catch { $('state').textContent = 'تعذر الاتصال بخادم البث'; setPlaceholder(true); scheduleRetry(); }
}
$('reload').addEventListener('click', () => { destroyPlayer(); retryCount = 0; refresh(); });
$('placeholder').addEventListener('click', async () => { await requestWatch(); setTimeout(refresh, 1200); });
$('placeholder').addEventListener('keydown', async event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); await requestWatch(); setTimeout(refresh, 1200); } });
$('mute').addEventListener('click', () => { video.muted = !video.muted; $('mute').textContent = video.muted ? 'إلغاء كتم الصوت' : 'كتم الصوت'; });
$('fullscreen').addEventListener('click', async () => {
  try {
    const target = document.querySelector('.video-wrap');
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (target.requestFullscreen) await target.requestFullscreen();
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
  } catch {}
});
$('cpuSaver').addEventListener('click', () => { setCpuSaver(!cpuSaver); try { sessionStorage.setItem('cpuSaverUserChoice','1'); } catch {} });
video.addEventListener('play', requestWatch);
video.addEventListener('playing', () => { setPlaceholder(false); $('state').textContent = 'البث المباشر يعمل'; });
video.addEventListener('error', () => { if (playerLoaded) scheduleRetry(); });
window.addEventListener('pagehide', () => {
  try { navigator.sendBeacon('/api/public/leave', new Blob([JSON.stringify({ viewerId })], { type: 'application/json' })); } catch {}
});
loadPublicConfig().finally(() => { if(channelId){refresh(); heartbeat();} else {$('state').textContent='لا توجد قنوات متاحة حالياً';setPlaceholder(true);} });
setInterval(refresh, 5000);
setInterval(heartbeat, 15000);
