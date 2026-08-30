import { commonCSS, themeInitScript, siteMeta, clerkHead } from '../lib/theme.js';
import { commonAuthJS, headerMarkup } from '../lib/auth.js';
import { icon } from '../lib/icons.js';
import { skeletonEpGrid } from '../lib/skeletons.js';

export function watchPage(pk, cu, anilistId, anivexaApi, streamProxy) {
  const PROXY = streamProxy || 'https://stream-proxy.muldera.workers.dev/?url=';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">${themeInitScript()}
<title>The Ledger — Watch #${anilistId}</title>${siteMeta("Watch this anime on The Ledger.")}
${clerkHead(pk, cu)}<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js"></script>
<style>${commonCSS()}
.watch-layout { display:grid; grid-template-columns:1fr 300px; gap:24px; }
@media(max-width:900px) { .watch-layout { grid-template-columns:1fr; } }
.watch-main { min-width:0; } .watch-sidebar { display:flex; flex-direction:column; gap:16px; }
.watch-card { border:none; border-radius:10px; background:var(--paper-dim); padding:16px; }
.watch-card h3 { font-family:inherit; font-weight:600; font-size:0.72rem; letter-spacing:1.5px; text-transform:uppercase; color:var(--accent); border-bottom:1px solid var(--rule); padding-bottom:6px; margin-bottom:10px; }
.provider-tabs { display:flex; gap:4px; flex-wrap:wrap; margin-bottom:10px; }
.provider-tab { padding:5px 10px; border:1px solid var(--rule); background:var(--paper); font-family:inherit; font-weight:600; font-size:0.68rem; letter-spacing:1px; text-transform:uppercase; color:var(--ink-soft); cursor:pointer; }
.provider-tab:hover { border-color:var(--accent); } .provider-tab.active { background:var(--accent); color:#fff; border-color:var(--accent); }
.provider-tab.tab-empty { opacity:.4; }
.audio-toggle { display:flex; gap:4px; margin-bottom:10px; }
.audio-toggle button { flex:1; padding:6px; border:1px solid var(--rule); background:var(--paper); font-family:inherit; font-weight:600; font-size:0.68rem; letter-spacing:1px; text-transform:uppercase; color:var(--ink-soft); cursor:pointer; }
.audio-toggle button.active { background:var(--accent); color:var(--paper); border-color:var(--accent); }
.ep-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(36px,1fr)); gap:4px; max-height:240px; overflow-y:auto; }
.ep-grid::-webkit-scrollbar { width:5px; } .ep-grid::-webkit-scrollbar-track { background:var(--paper-dim); } .ep-grid::-webkit-scrollbar-thumb { background:var(--rule); }
.ep-btn { padding:6px 2px; border:1px solid var(--rule); background:var(--paper); font-family:inherit; font-weight:600; font-size:0.72rem; font-weight:bold; text-align:center; cursor:pointer; color:var(--ink); }
.ep-btn:hover { border-color:var(--accent); background:var(--accent-soft); } .ep-btn.active { background:var(--accent); color:var(--paper); border-color:var(--accent); } .ep-btn.filler { opacity:.45; }
.server-row { display:flex; gap:6px; flex-wrap:wrap; margin-top:14px; }
.server-btn { padding:5px 10px; border:1px solid var(--rule); background:var(--paper); font-family:inherit; font-weight:600; font-size:0.68rem; letter-spacing:1px; text-transform:uppercase; color:var(--ink-soft); cursor:pointer; display:flex; align-items:center; gap:4px; }
.server-btn:hover { border-color:var(--accent); color:var(--ink); } .server-btn.active { border-color:var(--accent); color:#fff; background:var(--accent); } .server-btn .dot { width:5px; height:5px; border-radius:50%; background:#fff; }
.now-playing { font-size:0.85rem; line-height:1.6; color:var(--ink-soft); } .now-playing strong { color:var(--ink); }
.watch-info { margin-bottom:16px; } .watch-info h1 { font-size:1.6rem; font-weight:400; margin-bottom:4px; } .watch-info .meta { font-family:inherit; font-weight:600; font-size:0.72rem; letter-spacing:1px; text-transform:uppercase; color:var(--ink-soft); display:flex; flex-wrap:wrap; gap:12px; } .watch-info .meta .badge { border:1px solid var(--accent); color:var(--accent); padding:1px 8px; }
</style></head><body>
${headerMarkup('Watch · Record #' + anilistId, false)}
<div class="auth-gate" id="auth-gate"><h1>Sign in required</h1><p>Sign in to watch.</p><div class="auth-buttons"><button class="btn" id="gate-signin">Sign In</button><button class="btn" id="gate-signup">Sign Up</button></div></div>
<div class="app" id="app"><main><a href="/detail/${anilistId}" class="back-link">← Back to Details</a><div class="watch-layout"><div class="watch-main">
<div class="player-wrap" id="playerWrap"><div class="player-overlay" id="overlay"><div class="spinner"></div></div><video id="video" playsinline crossorigin="anonymous"></video><button class="skip-btn" id="skipBtn"><span id="skipBtnLabel">Skip Intro</span> ${icon('chevronRight')}</button>
<div class="pc-bar" id="pcBar">
  <div class="pc-seek" id="pcSeek"><div class="pc-buffered" id="pcBuffered"></div><div class="pc-progress" id="pcProgress"></div><div class="pc-seek-handle" id="pcHandle"></div></div>
  <div class="pc-row">
    <button class="pc-btn" id="pcPlay" title="Play/Pause">${icon('play')}</button>
    <button class="pc-btn" id="pcSkipBack" title="-10s">${icon('back10')}</button>
    <button class="pc-btn" id="pcSkipFwd" title="+10s">${icon('fwd10')}</button>
    <div class="pc-vol"><button class="pc-btn" id="pcMute" title="Mute">${icon('volume')}</button><input type="range" id="pcVolume" min="0" max="1" step="0.05" value="1"></div>
    <span class="pc-time" id="pcTime">0:00 / 0:00</span>
    <div class="pc-spacer"></div>
    <div class="pc-menu-wrap"><button class="pc-btn" id="pcCaptionsBtn" title="Subtitles">${icon('captions')}</button><div class="pc-menu pc-menu-wide" id="pcCaptionsMenu"></div></div>
    <div class="pc-menu-wrap"><button class="pc-btn" id="pcDownloadBtn" title="Downloads">${icon('download')}</button><div class="pc-menu pc-menu-wide" id="pcDownloadMenu"></div></div>
    <div class="pc-menu-wrap"><button class="pc-btn pc-label" id="pcSpeedBtn">1x</button><div class="pc-menu" id="pcSpeedMenu"></div></div>
    <div class="pc-menu-wrap"><button class="pc-btn pc-label" id="pcQualityBtn">Auto</button><div class="pc-menu" id="pcQualityMenu"></div></div>
    <button class="pc-btn" id="pcFullscreen" title="Fullscreen">${icon('fullscreen')}</button>
  </div>
</div>
</div>
<div class="watch-info" id="watchInfo" style="display:none;"><h1 id="epTitle">Episode —</h1><div class="meta"><span>Record #<span id="alId">—</span></span><span id="malSpan" style="display:none;">MAL #<span id="malId">—</span></span><span class="badge" id="audioBadge">—</span><span>Provider: <span id="provName">—</span></span></div><div class="server-row" id="serverRow"></div></div>
<div class="error" id="errBox" style="display:none;"></div></div><div class="watch-sidebar">
<div class="watch-card" id="epCard"><h3>Episodes</h3><div class="provider-tabs" id="provTabs"><div class="skel" style="height:24px;width:70%;"></div></div><div class="audio-toggle" id="audioToggle"><button data-audio="sub" class="active">Sub</button><button data-audio="dub">Dub</button></div><div class="ep-grid" id="epGrid">${skeletonEpGrid()}</div></div>
<div class="watch-card" id="nowCard" style="display:none;"><h3>Now Playing</h3><div class="now-playing" id="nowInfo"></div></div></div></div></main></div>
<script>
${commonAuthJS()}
const ANILIST_API = 'https://graphql.anilist.co'; const ANILIST_ID = ${anilistId}; const STREAM_PROXY = ${JSON.stringify(PROXY)};
const ICON_PLAY = ${JSON.stringify(icon('play'))}; const ICON_PAUSE = ${JSON.stringify(icon('pause'))};
const ICON_VOLUME = ${JSON.stringify(icon('volume'))}; const ICON_MUTE = ${JSON.stringify(icon('mute'))};
let providerCache = {}, currentProvider = null, currentAudio = 'sub', currentEpNum = null, watchData = null, currentStreamIndex = 0, hls = null, skipMode = null;
let mediaTitle = '', mediaCover = '', resumeChecked = false, progressTimer = null;
const video = document.getElementById('video'), overlay = document.getElementById('overlay'), skipBtn = document.getElementById('skipBtn'), playerWrap = document.getElementById('playerWrap');
function escapeHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function showOverlay(show) { overlay.classList.toggle('hidden', !show); }
function showError(msg) { const box = document.getElementById('errBox'); box.textContent = msg; box.style.display = 'block'; }
function hideError() { document.getElementById('errBox').style.display = 'none'; }
function proxyUrl(url) { if (!url) return url; return STREAM_PROXY + encodeURIComponent(url); }
const PROVIDER_SLUGS = { allmanga:'allmanga', reanime:'reanime', anikoto:'anikoto', animegg:'animegg', anineko:'anineko', anidbapp:'anidbapp', '2dhive':'2dhive', animenosub:'animenosub', anizone:'anizone', anibd:'anibd', senshi:'senshi', kaa:'kaa', animedunya:'animedunya' };
const PROVIDER_ORDER = ['anineko', 'anidbapp', 'allmanga', 'reanime', 'anikoto', 'animegg', '2dhive', 'animenosub', 'anizone', 'anibd', 'senshi', 'kaa', 'animedunya'];
function buildWatchUrl(provider, id, audio, ep) { const slug = PROVIDER_SLUGS[provider] || provider; return '/api/watch/' + slug + '/' + id + '/' + audio + '/' + slug + '-' + ep; }
async function fetchTitle() { try { const resp = await fetch(ANILIST_API, { method: 'POST', headers: { 'Content-Type':'application/json','Accept':'application/json' }, body: JSON.stringify({ query: 'query($id:Int){Media(id:$id){id title{romaji english} episodes coverImage{large}}}', variables: { id: ANILIST_ID } }) }); const json = await resp.json(); if (json.data && json.data.Media) { const m = json.data.Media; mediaTitle = m.title.english || m.title.romaji || 'Watch'; mediaCover = m.coverImage ? m.coverImage.large : ''; document.title = 'The Ledger — ' + mediaTitle; } } catch {} }
/* --- lazy per-provider episode loading: fetch AniNeko first, others only on demand --- */
function clientSkeletonGrid() { let s = ''; for (let i = 0; i < 24; i++) s += '<div class="skel" style="height:30px;"></div>'; return s; }
function extractProviderData(json, slug) {
  if (!json) return null;
  if (json[slug]) return json[slug];
  if (json.episodes || json.error) return json;
  const keys = Object.keys(json);
  if (keys.length === 1) return json[keys[0]];
  return json;
}
function readPreloadedProviderRaw(slug) {
  try { const raw = sessionStorage.getItem('ep_' + slug + '_' + ANILIST_ID); if (!raw) return null; const parsed = JSON.parse(raw); if (Date.now() - parsed.ts > 10 * 60 * 1000) return null; return parsed.data; } catch { return null; }
}
function cacheProviderRaw(slug, rawJson) { try { sessionStorage.setItem('ep_' + slug + '_' + ANILIST_ID, JSON.stringify({ data: rawJson, ts: Date.now() })); } catch {} }
async function fetchProviderEpisodes(slug) {
  if (providerCache[slug]) return providerCache[slug];
  let rawJson = readPreloadedProviderRaw(slug);
  if (!rawJson) {
    const res = await fetch('/api/episodes/' + slug + '/' + ANILIST_ID);
    if (res.status === 502) throw Object.assign(new Error('waking'), { waking: true });
    rawJson = await res.json(); if (!res.ok) throw new Error((rawJson && rawJson.error) || 'HTTP ' + res.status);
    cacheProviderRaw(slug, rawJson);
  }
  const data = extractProviderData(rawJson, slug);
  providerCache[slug] = data;
  return data;
}
function buildProviderTabsStatic() {
  const container = document.getElementById('provTabs'); container.innerHTML = '';
  PROVIDER_ORDER.forEach(slug => {
    const tab = document.createElement('button'); tab.className = 'provider-tab'; tab.dataset.slug = slug; tab.textContent = slug;
    tab.addEventListener('click', () => { if (currentProvider === slug && providerCache[slug]) return; loadProvider(slug, {}); });
    container.appendChild(tab);
  });
}
function setActiveTab(slug) { document.querySelectorAll('.provider-tab').forEach(t => t.classList.toggle('active', t.dataset.slug === slug)); }
function updateTabLabel(slug) {
  const tab = document.querySelector('.provider-tab[data-slug="' + slug + '"]'); if (!tab) return;
  const pd = providerCache[slug]; const sub = (pd && pd.episodes && pd.episodes.sub) ? pd.episodes.sub.length : 0; const dub = (pd && pd.episodes && pd.episodes.dub) ? pd.episodes.dub.length : 0;
  tab.innerHTML = slug + ((sub + dub) ? ' <span style="opacity:.6">' + (sub + dub) + '</span>' : '');
}
function markTabEmpty(slug) { const tab = document.querySelector('.provider-tab[data-slug="' + slug + '"]'); if (tab) tab.classList.add('tab-empty'); }
async function loadProvider(slug, opts) {
  currentProvider = slug; setActiveTab(slug); hideError();
  if (providerCache[slug]) { renderEpGrid(); return true; }
  document.getElementById('epGrid').innerHTML = clientSkeletonGrid();
  try {
    await fetchProviderEpisodes(slug);
    updateTabLabel(slug);
    const pd = providerCache[slug];
    const hasEps = pd && pd.episodes && ((pd.episodes.sub && pd.episodes.sub.length) || (pd.episodes.dub && pd.episodes.dub.length));
    if (!hasEps) { markTabEmpty(slug); if (!opts.silentEmpty) document.getElementById('epGrid').innerHTML = '<span style="font-size:0.72rem;color:var(--ink-soft);">No episodes from this provider.</span>'; return false; }
    renderEpGrid();
    return true;
  } catch (err) {
    if (err.waking) { showError('Waking up the API server. This can take up to 30 seconds on first load — please try again in a moment.'); }
    else { markTabEmpty(slug); document.getElementById('epGrid').innerHTML = '<span style="font-size:0.72rem;color:var(--ink-soft);">Could not load this provider.</span>'; }
    return false;
  }
}
async function initEpisodes() {
  showOverlay(true); hideError();
  buildProviderTabsStatic();
  for (const slug of PROVIDER_ORDER) {
    const ok = await loadProvider(slug, { silentEmpty: true });
    if (ok) { await maybeResume(); break; }
  }
  showOverlay(false);
}
function renderEpGrid() {
  const grid = document.getElementById('epGrid'); grid.innerHTML = '';
  const pd = providerCache[currentProvider];
  if (!pd || pd.error || !pd.episodes) { grid.innerHTML = '<span style="font-size:0.72rem;color:var(--ink-soft);">No episodes.</span>'; return; }
  const eps = pd.episodes[currentAudio] || [];
  if (!eps.length) { grid.innerHTML = '<span style="font-size:0.72rem;color:var(--ink-soft);">No ' + currentAudio + ' episodes.</span>'; return; }
  eps.forEach(ep => { const btn = document.createElement('button'); btn.className = 'ep-btn' + (currentEpNum === ep.number ? ' active' : '') + (ep.filler ? ' filler' : ''); btn.textContent = ep.number; btn.title = ep.title || 'Episode ' + ep.number; btn.addEventListener('click', () => { currentEpNum = ep.number; document.querySelectorAll('.ep-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); loadWatch(currentProvider, ANILIST_ID, currentAudio, ep.number); }); grid.appendChild(btn); });
}
document.querySelectorAll('#audioToggle button').forEach(btn => { btn.addEventListener('click', () => { currentAudio = btn.dataset.audio; document.querySelectorAll('#audioToggle button').forEach(b => b.classList.remove('active')); btn.classList.add('active'); renderEpGrid(); }); });
async function maybeResume() {
  if (resumeChecked || !window.Clerk || !Clerk.user) return; resumeChecked = true;
  try {
    const res = await fetch('/api/progress?user=' + encodeURIComponent(Clerk.user.id) + '&id=' + ANILIST_ID);
    const data = await res.json(); const item = data.item;
    if (item && item.type === 'anime' && item.episode_or_chapter) {
      const m = String(item.episode_or_chapter).match(/([\\d.]+)/); const epNum = m ? parseInt(m[1]) : NaN;
      const pd = providerCache[currentProvider];
      if (epNum && pd && pd.episodes && pd.episodes[currentAudio]) {
        const match = pd.episodes[currentAudio].find(e => e.number === epNum);
        if (match) { currentEpNum = epNum; document.querySelectorAll('.ep-btn').forEach(b => b.classList.toggle('active', parseInt(b.textContent) === epNum)); loadWatch(currentProvider, ANILIST_ID, currentAudio, epNum, item.position_seconds); return; }
      }
    }
  } catch {}
}
async function loadWatch(provider, id, audio, ep, resumeAt) {
  showOverlay(true); hideError();
  try { const res = await fetch(buildWatchUrl(provider, id, audio, ep)); const data = await res.json(); if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    watchData = data; currentStreamIndex = 0; renderInfo(data, provider); renderServers(data); renderSubs(data); renderDls(data); renderNowPlaying(data, provider, ep); playStream(0, resumeAt);
    document.getElementById('epCard').style.display = 'block';
  } catch (err) { showError(escapeHtml(err.message)); showOverlay(false); }
}
function renderInfo(data, provider) {
  document.getElementById('watchInfo').style.display = 'block'; document.getElementById('epTitle').textContent = 'Episode ' + (data.episode || '—'); document.getElementById('alId').textContent = data.anilistId || '—'; document.getElementById('provName').textContent = provider;
  if (data.malId) { document.getElementById('malId').textContent = data.malId; document.getElementById('malSpan').style.display = 'inline'; }
  document.getElementById('audioBadge').textContent = data.audio || currentAudio;
}
function friendlyServerName(i) { return i === 0 ? 'HD-1' : 'Server ' + (i + 1); }
function renderServers(data) {
  const row = document.getElementById('serverRow'); row.innerHTML = '';
  if (!data.streams || !data.streams.length) { row.innerHTML = '<span style="font-size:0.72rem;color:var(--ink-soft);">No streams.</span>'; return; }
  data.streams.forEach((stream, i) => { const btn = document.createElement('button'); btn.className = 'server-btn' + (i === 0 ? ' active' : ''); btn.innerHTML = (stream.isActive ? '<span class="dot"></span>' : '') + '<span>' + friendlyServerName(i) + '</span>'; btn.addEventListener('click', () => { document.querySelectorAll('.server-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); currentStreamIndex = i; playStream(i); }); row.appendChild(btn); });
}
function playStream(index, resumeAt) {
  if (!watchData || !watchData.streams || !watchData.streams[index]) return;
  const stream = watchData.streams[index]; showOverlay(true);
  if (hls) { hls.destroy(); hls = null; } video.removeAttribute('src'); video.innerHTML = '';
  const existingIframe = document.querySelector('.player-wrap iframe'); if (existingIframe) existingIframe.remove(); video.style.display = 'block';
  playerWrap.classList.toggle('pc-embed', false); document.getElementById('pcBar').style.display = 'block';
  if (stream.type === 'hls' && stream.url) { playHLS(stream, resumeAt); } else if (stream.type === 'embed' && stream.embedUrl) { playEmbed(stream); } else if (stream.embedUrl) { playEmbed(stream); } else if (stream.url) { video.src = proxyUrl(stream.url); video.load(); showOverlay(false); if (resumeAt) video.currentTime = resumeAt; } else { showError('No playable URL for this server.'); showOverlay(false); }
  setupSkip(stream);
}
function buildQualityMenu() {
  const menu = document.getElementById('pcQualityMenu'); menu.innerHTML = '';
  const autoBtn = document.createElement('button'); autoBtn.textContent = 'Auto'; autoBtn.className = (hls && hls.currentLevel === -1) ? 'active' : '';
  autoBtn.addEventListener('click', () => { if (hls) hls.currentLevel = -1; document.getElementById('pcQualityBtn').textContent = 'Auto'; document.querySelectorAll('#pcQualityMenu button').forEach(b=>b.classList.remove('active')); autoBtn.classList.add('active'); menu.classList.remove('open'); });
  menu.appendChild(autoBtn);
  if (hls && hls.levels) { hls.levels.forEach((lvl, i) => { const b = document.createElement('button'); b.textContent = lvl.height + 'p'; b.addEventListener('click', () => { hls.currentLevel = i; document.getElementById('pcQualityBtn').textContent = lvl.height + 'p'; document.querySelectorAll('#pcQualityMenu button').forEach(x=>x.classList.remove('active')); b.classList.add('active'); menu.classList.remove('open'); }); menu.appendChild(b); }); }
}
function playHLS(stream, resumeAt) {
  if (stream.subtitles && stream.subtitles.length) { stream.subtitles.forEach(sub => { const track = document.createElement('track'); track.kind = 'subtitles'; track.label = sub.label || 'English'; track.srclang = sub.srclang || 'en'; track.src = sub.url; if (sub.default) track.default = true; video.appendChild(track); }); }
  const streamUrl = proxyUrl(stream.url);
  if (Hls.isSupported()) { hls = new Hls({ enableWorker:true, lowLatencyMode:true, backBufferLength:90 }); hls.loadSource(streamUrl); hls.attachMedia(video); hls.on(Hls.Events.MANIFEST_PARSED, () => { showOverlay(false); if (resumeAt) video.currentTime = resumeAt; video.play().catch(()=>{}); buildQualityMenu(); }); hls.on(Hls.Events.ERROR, (event, data) => { if (data.fatal) { switch (data.type) { case Hls.ErrorTypes.NETWORK_ERROR: hls.startLoad(); break; case Hls.ErrorTypes.MEDIA_ERROR: hls.recoverMediaError(); break; default: showError('HLS playback failed. Try another server.'); hls.destroy(); showOverlay(false); break; } } }); }
  else if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = streamUrl; video.addEventListener('loadedmetadata', () => { showOverlay(false); if (resumeAt) video.currentTime = resumeAt; video.play().catch(()=>{}); }, { once:true }); }
  else { showError('HLS not supported.'); showOverlay(false); }
}
function playEmbed(stream) { if (!stream.embedUrl) { showError('No embed URL.'); showOverlay(false); return; } video.style.display = 'none'; document.getElementById('pcBar').style.display = 'none'; const iframe = document.createElement('iframe'); iframe.src = stream.embedUrl; iframe.allow = 'fullscreen;autoplay;encrypted-media;picture-in-picture'; iframe.allowFullscreen = true; iframe.sandbox = 'allow-scripts allow-same-origin allow-presentation allow-forms'; document.getElementById('playerWrap').appendChild(iframe); showOverlay(false); }
const skipBtnLabel = document.getElementById('skipBtnLabel');
function setupSkip(stream) { skipBtn.classList.remove('visible'); skipMode = null; const intro = stream.intro || watchData.intro; const outro = stream.outro || watchData.outro; if (!intro && !outro) return; video.addEventListener('timeupdate', function check() { const t = video.currentTime; if (intro && t >= intro.start && t < intro.end - 2) { skipMode = 'intro'; skipBtnLabel.textContent = 'Skip Intro'; skipBtn.classList.add('visible'); } else if (outro && t >= outro.start && t < outro.end - 2) { skipMode = 'outro'; skipBtnLabel.textContent = 'Skip Outro'; skipBtn.classList.add('visible'); } else { skipBtn.classList.remove('visible'); } }, { passive:true }); }
skipBtn.addEventListener('click', () => { if (skipMode === 'intro') { const i = watchData.streams[currentStreamIndex]?.intro || watchData.intro; if (i) video.currentTime = i.end; } else if (skipMode === 'outro') { const o = watchData.streams[currentStreamIndex]?.outro || watchData.outro; if (o) video.currentTime = o.end; } skipBtn.classList.remove('visible'); });
function renderNowPlaying(data, provider, ep) { document.getElementById('nowCard').style.display = 'block'; const info = document.getElementById('nowInfo'); const pd = providerCache?.[provider]; const epInfo = pd?.episodes?.[data.audio || currentAudio]?.find(e => e.number === ep); info.innerHTML = '<div><strong>Episode ' + (data.episode || ep) + '</strong></div>' + (epInfo?.title ? '<div>' + escapeHtml(epInfo.title) + '</div>' : '') + '<div style="margin-top:4px;">Provider: <strong>' + escapeHtml(provider) + '</strong></div><div>Audio: <strong>' + (data.audio || currentAudio) + '</strong></div><div>Streams: <strong>' + (data.streams?.length || 0) + '</strong></div>'; }
function renderSubs(data) {
  const menu = document.getElementById('pcCaptionsMenu'); const all = [];
  if (data.subtitles) data.subtitles.forEach(s => all.push({ ...s, source:s.source||'API' }));
  if (data.streams) data.streams.forEach((st, i) => { if (st.subtitles) st.subtitles.forEach(s => { if (!all.find(x=>x.url===s.url)) all.push({ ...s, source:friendlyServerName(i) }); }); });
  if (!all.length) { menu.innerHTML = '<div class="pc-menu-empty">No subtitles found.</div>'; return; }
  menu.innerHTML = all.map(sub => '<div class="pc-menu-row"><span>' + escapeHtml(sub.label || sub.srclang || 'Unknown') + (sub.default ? ' •' : '') + '</span><span class="pc-menu-sub">' + escapeHtml(sub.source) + '</span></div>').join('');
}
function renderDls(data) {
  const menu = document.getElementById('pcDownloadMenu');
  if (!data.downloads || !data.downloads.length) { menu.innerHTML = '<div class="pc-menu-empty">No downloads found.</div>'; return; }
  menu.innerHTML = data.downloads.map(dl => { let host = 'link'; try { host = new URL(dl.url).hostname; } catch {} return '<a class="pc-menu-row pc-menu-link" href="' + dl.url + '" target="_blank" rel="noopener noreferrer"><span>' + escapeHtml(dl.label || 'Download') + '</span><span class="pc-menu-sub">' + escapeHtml(host) + '</span></a>'; }).join('');
}
/* --- custom controls --- */
function fmtTime(t) { if (!isFinite(t) || t < 0) t = 0; const h = Math.floor(t/3600), m = Math.floor((t%3600)/60), s = Math.floor(t%60); return (h ? h + ':' + String(m).padStart(2,'0') : m) + ':' + String(s).padStart(2,'0'); }
const pcPlay = document.getElementById('pcPlay'), pcSeek = document.getElementById('pcSeek'), pcProgress = document.getElementById('pcProgress'), pcBuffered = document.getElementById('pcBuffered'), pcHandle = document.getElementById('pcHandle'), pcTime = document.getElementById('pcTime'), pcMute = document.getElementById('pcMute'), pcVolume = document.getElementById('pcVolume'), pcFullscreen = document.getElementById('pcFullscreen'), pcSpeedBtn = document.getElementById('pcSpeedBtn'), pcSpeedMenu = document.getElementById('pcSpeedMenu'), pcQualityBtn = document.getElementById('pcQualityBtn'), pcQualityMenu = document.getElementById('pcQualityMenu'), pcCaptionsBtn = document.getElementById('pcCaptionsBtn'), pcCaptionsMenu = document.getElementById('pcCaptionsMenu'), pcDownloadBtn = document.getElementById('pcDownloadBtn'), pcDownloadMenu = document.getElementById('pcDownloadMenu');
[0.5,0.75,1,1.25,1.5,2].forEach(sp => { const b = document.createElement('button'); b.textContent = sp + 'x'; if (sp===1) b.classList.add('active'); b.addEventListener('click', () => { video.playbackRate = sp; pcSpeedBtn.textContent = sp + 'x'; document.querySelectorAll('#pcSpeedMenu button').forEach(x=>x.classList.remove('active')); b.classList.add('active'); pcSpeedMenu.classList.remove('open'); }); pcSpeedMenu.appendChild(b); });
const allPcMenus = [pcSpeedMenu, pcQualityMenu, pcCaptionsMenu, pcDownloadMenu];
function togglePcMenu(menu) { const wasOpen = menu.classList.contains('open'); allPcMenus.forEach(m => m.classList.remove('open')); if (!wasOpen) menu.classList.add('open'); }
pcSpeedBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePcMenu(pcSpeedMenu); });
pcQualityBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePcMenu(pcQualityMenu); });
pcCaptionsBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePcMenu(pcCaptionsMenu); });
pcDownloadBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePcMenu(pcDownloadMenu); });
document.addEventListener('click', () => allPcMenus.forEach(m => m.classList.remove('open')));
pcPlay.addEventListener('click', () => { if (video.paused) video.play().catch(()=>{}); else video.pause(); });
document.getElementById('pcSkipBack').addEventListener('click', () => { video.currentTime = Math.max(0, video.currentTime - 10); });
document.getElementById('pcSkipFwd').addEventListener('click', () => { video.currentTime = Math.min(video.duration || 1e9, video.currentTime + 10); });
video.addEventListener('play', () => { pcPlay.innerHTML = ICON_PAUSE; playerWrap.classList.add('pc-playing'); scheduleHide(); });
video.addEventListener('pause', () => { pcPlay.innerHTML = ICON_PLAY; playerWrap.classList.remove('pc-playing'); });
video.addEventListener('timeupdate', () => { if (!video.duration) return; const pct = (video.currentTime / video.duration) * 100; pcProgress.style.width = pct + '%'; pcHandle.style.left = pct + '%'; pcTime.textContent = fmtTime(video.currentTime) + ' / ' + fmtTime(video.duration); if (video.buffered.length) { const end = video.buffered.end(video.buffered.length - 1); pcBuffered.style.width = Math.min(100, (end / video.duration) * 100) + '%'; } });
let seeking = false;
function seekFromEvent(e) { const rect = pcSeek.getBoundingClientRect(); const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left; const pct = Math.min(1, Math.max(0, x / rect.width)); if (video.duration) video.currentTime = pct * video.duration; }
pcSeek.addEventListener('mousedown', (e) => { seeking = true; seekFromEvent(e); });
window.addEventListener('mousemove', (e) => { if (seeking) seekFromEvent(e); });
window.addEventListener('mouseup', () => { seeking = false; });
pcSeek.addEventListener('click', seekFromEvent);
pcMute.addEventListener('click', () => { video.muted = !video.muted; pcMute.innerHTML = video.muted ? ICON_MUTE : ICON_VOLUME; });
pcVolume.addEventListener('input', () => { video.volume = parseFloat(pcVolume.value); video.muted = video.volume === 0; pcMute.innerHTML = video.muted ? ICON_MUTE : ICON_VOLUME; });
pcFullscreen.addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen(); else playerWrap.requestFullscreen().catch(()=>{}); });
let hideTimer = null;
function scheduleHide() { playerWrap.classList.add('pc-show'); clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (!video.paused) playerWrap.classList.remove('pc-show'); }, 2800); }
playerWrap.addEventListener('mousemove', scheduleHide);
playerWrap.addEventListener('mouseleave', () => { if (!video.paused) playerWrap.classList.remove('pc-show'); });
video.addEventListener('click', () => { if (video.paused) video.play().catch(()=>{}); else video.pause(); });
video.addEventListener('waiting', () => showOverlay(true)); video.addEventListener('playing', () => showOverlay(false)); video.addEventListener('canplay', () => showOverlay(false)); video.addEventListener('error', () => { showOverlay(false); });
/* --- progress saving --- */
function saveProgress() {
  if (!window.Clerk || !Clerk.user || !video.duration || !currentEpNum) return;
  fetch('/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: Clerk.user.id, anilistId: ANILIST_ID, type: 'anime', title: mediaTitle, coverImage: mediaCover, episodeOrChapter: 'Ep. ' + currentEpNum, positionSeconds: video.currentTime, durationSeconds: video.duration }) }).catch(() => {});
}
video.addEventListener('play', () => { if (progressTimer) clearInterval(progressTimer); progressTimer = setInterval(saveProgress, 10000); });
video.addEventListener('pause', saveProgress);
window.addEventListener('beforeunload', saveProgress);
function onAuthenticated() { fetchTitle(); initEpisodes(); }
</script></body></html>`;
}
