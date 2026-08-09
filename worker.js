export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const pk = env.CLERK_PUBLISHABLE_KEY || '';
    const cu = env.CLERK_FRONTEND_API_URL || '';
    const anivexaApi = env.ANIVEXA_API_URL || '';
    const streamProxy = env.STREAM_PROXY_URL || '';
    const parts = path.split('/').filter(Boolean);
    let anilistId = null;
    if (parts.length >= 2 && ['detail', 'watch', 'read'].includes(parts[0])) { anilistId = parts[1]; }
    if (parts[0] === 'api') { return handleApiProxy(request, anivexaApi); }
    if (parts[0] === 'md') { return handleMangaDexProxy(request); }
    let html;
    if (path === '/' || path === '/index.html') { html = indexPage(pk, cu); }
    else if (parts[0] === 'detail' && anilistId && /^\d+$/.test(anilistId)) { html = detailPage(pk, cu, anilistId); }
    else if (parts[0] === 'watch' && anilistId && /^\d+$/.test(anilistId)) { html = watchPage(pk, cu, anilistId, anivexaApi, streamProxy); }
    else if (parts[0] === 'read' && anilistId && /^\d+$/.test(anilistId)) { html = readPage(pk, cu, anilistId, anivexaApi, streamProxy); }
    else { return new Response('Not Found', { status: 404 }); }
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
  }
};
async function handleApiProxy(request, anivexaApi) {
  const url = new URL(request.url);
  const apiPath = url.pathname.replace(/^\/api/, '');
  const targetUrl = anivexaApi + apiPath + (url.search || '');
  const cacheKey = new Request(targetUrl, { method: 'GET' });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) { return new Response(cached.body, { status: cached.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300', 'X-Cache': 'HIT' } }); }
  try {
    const resp = await fetch(targetUrl, { headers: { 'Accept': 'application/json' } });
    const body = await resp.text();
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300', 'X-Cache': 'MISS' };
    const cacheResp = new Response(body, { status: resp.status, headers });
    cache.put(cacheKey, cacheResp.clone()).catch(() => {});
    return cacheResp;
  } catch (err) {
    return new Response(JSON.stringify({ error: 'API unavailable: ' + err.message }), { status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
}
async function handleMangaDexProxy(request) {
  const url = new URL(request.url);
  const mdPath = url.pathname.replace(/^\/md/, '');
  const targetUrl = 'https://api.mangadex.org' + mdPath + (url.search || '');
  try {
    const resp = await fetch(targetUrl, { headers: { 'Accept': 'application/json', 'User-Agent': 'TheLedger/1.0' } });
    const body = await resp.text();
    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('application/json') || resp.status >= 500) {
      return new Response(JSON.stringify({ result: 'error', errors: [{ detail: 'MangaDex returned HTTP ' + resp.status + '. The API may be temporarily unavailable.' }] }), { status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }
    return new Response(body, { status: resp.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'MangaDex unavailable: ' + err.message }), { status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
}
function clerkHead(pk, cu) {
  return `<script async crossorigin="anonymous" data-clerk-publishable-key="${pk}" type="text/javascript" src="${cu}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script>`;
}
function commonCSS() {
  return `:root { --paper:#f6f2ea; --paper-dim:#ece5d8; --ink:#201c16; --ink-soft:#5c5347; --rule:#d8cdb8; --accent:#a63d2f; --accent-soft:#e8d9c8; }
* { box-sizing:border-box; margin:0; padding:0; }
body { background:var(--paper); color:var(--ink); font-family:Georgia,'Iowan Old Style',serif; padding-bottom:80px; }
header { border-bottom:3px double var(--ink); padding:20px 24px; max-width:1100px; margin:0 auto; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; }
header h1 { font-size:1.6rem; font-weight:400; }
header .tagline { font-family:'Courier New',monospace; font-size:0.7rem; letter-spacing:1.5px; text-transform:uppercase; color:var(--ink-soft); }
.dateline { font-family:'Courier New',monospace; font-size:0.7rem; letter-spacing:1px; color:var(--ink-soft); text-transform:uppercase; margin-top:6px; }
.user-name { font-family:'Courier New',monospace; font-size:0.75rem; letter-spacing:1px; }
.btn { padding:8px 18px; border-radius:20px; border:1px solid var(--ink); background:none; color:var(--ink); font-family:'Courier New',monospace; font-size:0.75rem; letter-spacing:1px; text-transform:uppercase; cursor:pointer; text-decoration:none; display:inline-block; }
.btn:hover { background:var(--ink); color:var(--paper); }
.auth-gate { display:none; flex-direction:column; align-items:center; justify-content:center; min-height:70vh; gap:20px; padding:40px; text-align:center; }
.auth-gate h1 { font-size:1.8rem; font-weight:400; }
.auth-gate p { color:var(--ink-soft); max-width:400px; }
.auth-buttons { display:flex; gap:12px; }
.app { display:none; }
.app.active { display:block; }
nav.sections { max-width:1100px; margin:0 auto; display:flex; flex-wrap:wrap; gap:2px; border-bottom:1px solid var(--rule); background:var(--paper-dim); }
nav.sections button { flex:none; padding:12px 20px; background:none; border:none; border-right:1px solid var(--rule); font-family:'Courier New',monospace; font-size:0.72rem; letter-spacing:1.2px; text-transform:uppercase; color:var(--ink-soft); cursor:pointer; }
nav.sections button.active { background:var(--ink); color:var(--paper); }
.search-row, .filters { display:none; max-width:1100px; margin:20px auto 0; padding:0 24px; gap:10px; align-items:center; }
.search-row.visible, .filters.visible { display:flex; }
.search-row input, .search-row select, .filters select { padding:10px 12px; border:1px solid var(--ink); background:var(--paper); font-family:inherit; font-size:0.9rem; color:var(--ink); }
.search-row input { flex:1; max-width:420px; }
.search-row button { padding:10px 22px; background:var(--ink); color:var(--paper); border:none; font-family:'Courier New',monospace; font-size:0.78rem; letter-spacing:1px; text-transform:uppercase; cursor:pointer; }
main { max-width:1100px; margin:24px auto 0; padding:0 24px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(160px,1fr)); gap:0; border-top:1px solid var(--rule); border-left:1px solid var(--rule); }
.entry { border-right:1px solid var(--rule); border-bottom:1px solid var(--rule); padding:14px; cursor:pointer; text-decoration:none; color:inherit; display:block; transition:background 0.15s; }
.entry:hover { background:var(--accent-soft); }
.entry img { width:100%; aspect-ratio:2/3; object-fit:cover; filter:grayscale(15%) sepia(8%); border:1px solid var(--ink); }
.entry .num { font-family:'Courier New',monospace; font-size:0.68rem; color:var(--accent); margin-top:8px; }
.entry .name { font-size:0.92rem; line-height:1.3; margin-top:2px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; min-height:2.4em; }
.entry .meta { font-family:'Courier New',monospace; font-size:0.68rem; color:var(--ink-soft); margin-top:5px; text-transform:uppercase; }
.entry .score { color:var(--accent); font-weight:bold; }
.record-id { font-family:'Courier New',monospace; font-size:0.72rem; letter-spacing:1px; text-transform:uppercase; color:var(--accent); border:1px solid var(--accent); display:inline-block; padding:4px 10px; margin-bottom:18px; }
.back-link { font-family:'Courier New',monospace; font-size:0.72rem; letter-spacing:1px; text-transform:uppercase; color:var(--ink-soft); text-decoration:none; border:1px solid var(--ink); padding:6px 14px; display:inline-block; margin-bottom:20px; }
.back-link:hover { background:var(--ink); color:var(--paper); }
.hero { display:flex; gap:32px; flex-wrap:wrap; margin-bottom:28px; }
.hero img { width:220px; aspect-ratio:2/3; object-fit:cover; border:1px solid var(--ink); flex-shrink:0; }
.hero-info h1 { font-size:2rem; font-weight:400; line-height:1.2; margin-bottom:6px; }
.hero-info .native { color:var(--ink-soft); font-style:italic; margin-bottom:16px; }
.stat-row { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:18px; }
.stat { border:1px solid var(--rule); background:var(--paper-dim); padding:6px 14px; font-family:'Courier New',monospace; font-size:0.72rem; text-transform:uppercase; }
.stat.score { border-color:var(--accent); color:var(--accent); font-weight:bold; }
.genres, .studio { color:var(--ink-soft); font-size:0.9rem; margin-bottom:4px; }
.action-row { margin-top:18px; }
.section-label { font-family:'Courier New',monospace; font-size:0.72rem; letter-spacing:2px; text-transform:uppercase; color:var(--accent); border-bottom:1px solid var(--rule); padding-bottom:8px; margin:32px 0 14px; }
.description { font-size:1rem; line-height:1.75; white-space:pre-line; }
.loading, .error, .empty { text-align:center; padding:70px 20px; font-family:'Courier New',monospace; font-size:0.8rem; letter-spacing:1px; text-transform:uppercase; color:var(--ink-soft); }
.error { color:var(--accent); }
.placeholder { text-align:center; padding:100px 20px; }
.placeholder h2 { font-size:1.6rem; font-weight:400; margin-bottom:12px; }
.placeholder p { color:var(--ink-soft); font-family:'Courier New',monospace; font-size:0.8rem; letter-spacing:1px; text-transform:uppercase; }`;
}
function commonAuthJS() {
  return `
let clerkReady = false;
function doOpenSignIn() { if (window.Clerk) { try { Clerk.openSignIn(); } catch {} } }
function doOpenSignUp() { if (window.Clerk) { try { Clerk.openSignUp(); } catch {} } }
function attachGateButtons() {
  const si = document.getElementById('gate-signin');
  const su = document.getElementById('gate-signup');
  if (si) si.addEventListener('click', doOpenSignIn);
  if (su) su.addEventListener('click', doOpenSignUp);
}
function initClerk() {
  if (clerkReady || !window.Clerk) return;
  clerkReady = true;
  Clerk.load().then(() => { onClerkState(); Clerk.addListener(() => onClerkState()); }).catch(() => {
    const headerRight = document.getElementById('header-right');
    if (headerRight) headerRight.innerHTML = '<span class="loading">Sign in to continue</span>';
  });
}
function onClerkState() {
  const headerRight = document.getElementById('header-right');
  const authGate = document.getElementById('auth-gate');
  const app = document.getElementById('app');
  if (Clerk.user) {
    if (authGate) authGate.style.display = 'none';
    if (app) app.classList.add('active');
    if (headerRight) {
      const name = Clerk.user.username || Clerk.user.firstName || 'User';
      headerRight.innerHTML = '<span class="user-name">' + name + '</span> <button class="btn" id="so-btn">Sign Out</button>';
      const soBtn = document.getElementById('so-btn');
      if (soBtn) soBtn.addEventListener('click', () => Clerk.signOut());
    }
    if (typeof onAuthenticated === 'function') onAuthenticated();
  } else {
    if (authGate) authGate.style.display = 'flex';
    if (app) app.classList.remove('active');
    if (headerRight) headerRight.innerHTML = '<span class="loading">Sign in to continue</span>';
  }
}
const clerkInterval = setInterval(() => { if (window.Clerk) { clearInterval(clerkInterval); initClerk(); } }, 100);
document.addEventListener('DOMContentLoaded', attachGateButtons);
`;
}
function indexPage(pk, cu) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>The Ledger — Anime &amp; Manga Index</title>
${clerkHead(pk, cu)}<style>${commonCSS()}</style></head><body>
<header><div><h1>The Ledger</h1><div class="tagline">An Index of Anime &amp; Manga</div><div class="dateline" id="dateline"></div></div><div id="header-right"><span class="loading">Loading…</span></div></header>
<div class="auth-gate" id="auth-gate"><h1>Sign in required</h1><p>Sign in to browse the index — Top Ten, Popular, Seasonal, and Search.</p><div class="auth-buttons"><button class="btn" id="gate-signin">Sign In</button><button class="btn" id="gate-signup">Sign Up</button></div></div>
<div class="app" id="app">
<nav class="sections" id="nav-sections"><button class="active" data-mode="top">Top Ten</button><button data-mode="popular">Popular</button><button data-mode="random">Random Pull</button><button data-mode="seasonal">This Season</button><button data-mode="upcoming">On the Horizon</button><button data-mode="manga">Top Manga</button><button data-mode="search">Search the Index</button></nav>
<div class="search-row" id="search-row"><input type="text" id="search-input" placeholder="Search a title..."><select id="search-type"><option value="ANIME">Anime</option><option value="MANGA">Manga</option></select><button id="search-btn">Search</button></div>
<div class="filters" id="seasonal-filters"><select id="season-select"><option value="WINTER">Winter</option><option value="SPRING">Spring</option><option value="SUMMER">Summer</option><option value="FALL">Fall</option></select><select id="year-select"></select></div>
<main><div id="content" class="grid"></div></main></div>
<script>
${commonAuthJS()}
const ANILIST_API = 'https://graphql.anilist.co';
let content, navSections, searchRow, seasonalFilters; let authInit = false;
window.aniListIds = window.aniListIds || {};
function registerAniListId(title, id) { const varName = String(title).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); window.aniListIds[varName] = id; return varName; }
function escapeHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function currentSeason() { const now = new Date(); const month = now.getMonth()+1; const year = now.getFullYear(); let season; if (month<=3) season='WINTER'; else if (month<=6) season='SPRING'; else if (month<=9) season='SUMMER'; else season='FALL'; return { season, year }; }
function nextSeason() { const { season, year } = currentSeason(); const order=['WINTER','SPRING','SUMMER','FALL']; const idx=order.indexOf(season); const nextIdx=(idx+1)%4; const nextYear = nextIdx===0 ? year+1 : year; return { season: order[nextIdx], year: nextYear }; }
const QUERIES = {
  top: \`query { Page(page:1, perPage:10) { media(type:ANIME, sort:SCORE_DESC) { id title{romaji english} coverImage{large} averageScore episodes format } } }\`,
  popular: \`query { Page(page:1, perPage:20) { media(type:ANIME, sort:POPULARITY_DESC) { id title{romaji english} coverImage{large} averageScore episodes format } } }\`,
  randomPage: \`query($page:Int) { Page(page:$page, perPage:20) { media(type:ANIME, sort:POPULARITY_DESC) { id title{romaji english} coverImage{large} averageScore episodes format } } }\`,
  seasonal: \`query($season:MediaSeason, $year:Int) { Page(page:1, perPage:24) { media(type:ANIME, season:$season, seasonYear:$year, sort:POPULARITY_DESC) { id title{romaji english} coverImage{large} averageScore episodes format status } } }\`,
  upcoming: \`query($season:MediaSeason, $year:Int) { Page(page:1, perPage:24) { media(type:ANIME, season:$season, seasonYear:$year, sort:POPULARITY_DESC) { id title{romaji english} coverImage{large} averageScore episodes format status } } }\`,
  topManga: \`query { Page(page:1, perPage:20) { media(type:MANGA, sort:SCORE_DESC) { id title{romaji english} coverImage{large} averageScore chapters format } } }\`,
  search: \`query($search:String!, $type:MediaType) { Page(page:1, perPage:24) { media(search:$search, type:$type, sort:SEARCH_MATCH) { id title{romaji english} coverImage{large} averageScore episodes chapters format } } }\`,
};
async function anilist(query, variables = {}) {
  const resp = await fetch(ANILIST_API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ query, variables }) });
  if (!resp.ok) throw new Error('AniList error ' + resp.status);
  const json = await resp.json(); if (json.errors) throw new Error(json.errors[0].message); return json.data;
}
function renderGrid(media) {
  if (!media || media.length === 0) { content.innerHTML = '<div class="empty">No entries found.</div>'; return; }
  content.innerHTML = media.map((item, i) => renderEntry(item, i)).join('');
  media.forEach(item => { const title = item.title.english || item.title.romaji; registerAniListId(title, item.id); });
  content.querySelectorAll('.entry').forEach(el => { el.addEventListener('click', () => { window.location.href = '/detail/' + el.dataset.id; }); });
}
function renderEntry(item, index) {
  const title = item.title.english || item.title.romaji || 'Unknown';
  const score = item.averageScore ? (item.averageScore / 10).toFixed(1) : '—';
  const episodes = item.episodes ? item.episodes + ' ep' : item.chapters ? item.chapters + ' ch' : '';
  const format = item.format || ''; const num = String(index + 1).padStart(2, '0');
  return \`<a class="entry" data-id="\${item.id}"><img src="\${item.coverImage.large}" alt="\${escapeHtml(title)}" loading="lazy"><div class="num">No. \${num}</div><div class="name">\${escapeHtml(title)}</div><div class="meta">\${format} \${episodes ? '· ' + episodes : ''} · <span class="score">\${score}</span></div></a>\`;
}
let currentMode = 'top';
async function loadMode(mode) {
  currentMode = mode; searchRow.classList.toggle('visible', mode === 'search'); seasonalFilters.classList.toggle('visible', mode === 'seasonal' || mode === 'upcoming');
  navSections.querySelectorAll('button').forEach(b => { b.classList.toggle('active', b.dataset.mode === mode); });
  content.innerHTML = '<div class="loading">Loading…</div>';
  try { let data;
    if (mode === 'top') { data = await anilist(QUERIES.top); renderGrid(data.Page.media); }
    else if (mode === 'popular') { data = await anilist(QUERIES.popular); renderGrid(data.Page.media); }
    else if (mode === 'random') { const page = Math.floor(Math.random() * 10) + 1; data = await anilist(QUERIES.randomPage, { page }); renderGrid(data.Page.media); }
    else if (mode === 'seasonal') { const season = document.getElementById('season-select').value; const year = parseInt(document.getElementById('year-select').value); data = await anilist(QUERIES.seasonal, { season, year }); renderGrid(data.Page.media); }
    else if (mode === 'upcoming') { const { season, year } = nextSeason(); data = await anilist(QUERIES.upcoming, { season, year }); renderGrid(data.Page.media); }
    else if (mode === 'manga') { data = await anilist(QUERIES.topManga); renderGrid(data.Page.media); }
  } catch (e) { content.innerHTML = '<div class="error">Error: ' + escapeHtml(e.message) + '</div>'; }
}
async function doSearch() {
  const query = document.getElementById('search-input').value.trim(); const type = document.getElementById('search-type').value; if (!query) return;
  content.innerHTML = '<div class="loading">Searching…</div>';
  try { const data = await anilist(QUERIES.search, { search: query, type }); renderGrid(data.Page.media); } catch (e) { content.innerHTML = '<div class="error">Error: ' + escapeHtml(e.message) + '</div>'; }
}
function onAuthenticated() {
  if (authInit) return; authInit = true;
  content = document.getElementById('content'); navSections = document.getElementById('nav-sections'); searchRow = document.getElementById('search-row'); seasonalFilters = document.getElementById('seasonal-filters');
  const { year } = currentSeason(); const yearSelect = document.getElementById('year-select');
  for (let y = year + 1; y >= year - 10; y--) { const opt = document.createElement('option'); opt.value = y; opt.textContent = y; if (y === year) opt.selected = true; yearSelect.appendChild(opt); }
  document.getElementById('season-select').value = currentSeason().season;
  navSections.querySelectorAll('button').forEach(btn => { btn.addEventListener('click', () => loadMode(btn.dataset.mode)); });
  document.getElementById('search-btn').addEventListener('click', doSearch);
  document.getElementById('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  document.getElementById('season-select').addEventListener('change', () => { if (currentMode === 'seasonal') loadMode('seasonal'); });
  document.getElementById('year-select').addEventListener('change', () => { if (currentMode === 'seasonal') loadMode('seasonal'); });
  loadMode('top');
}
const dl = document.getElementById('dateline');
if (dl) dl.textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
</script></body></html>`;
}
function detailPage(pk, cu, anilistId) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>The Ledger — Record #${anilistId}</title>
${clerkHead(pk, cu)}<style>${commonCSS()}</style></head><body>
<header><div><h1>The Ledger</h1><div class="tagline">Record #${anilistId}</div></div><div id="header-right"><span class="loading">Loading…</span></div></header>
<div class="auth-gate" id="auth-gate"><h1>Sign in required</h1><p>Sign in to view this record.</p><div class="auth-buttons"><button class="btn" id="gate-signin">Sign In</button><button class="btn" id="gate-signup">Sign Up</button></div></div>
<div class="app" id="app"><main><div id="content"><div class="loading">Loading…</div></div></main></div>
<script>
${commonAuthJS()}
const ANILIST_API = 'https://graphql.anilist.co'; const ANILIST_ID = ${anilistId};
window.aniListIds = window.aniListIds || {};
function registerAniListId(title, id) { const varName = String(title).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); window.aniListIds[varName] = id; return varName; }
function escapeHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function cleanDescription(d) { return d ? d.replace(/<br\\s*\\/?>/gi,'\\n').replace(/<[^>]+>/g,'').trim() : ''; }
const DETAIL_QUERY = \`query($id:Int) { Media(id:$id) { id idMal title { romaji english native } coverImage { large extraLarge } averageScore episodes chapters volumes format status season seasonYear genres description duration studios(isMain:true) { nodes { name } } } }\`;
async function anilist(query, variables = {}) {
  const resp = await fetch(ANILIST_API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ query, variables }) });
  if (!resp.ok) throw new Error('AniList error ' + resp.status); const json = await resp.json(); if (json.errors) throw new Error(json.errors[0].message); return json.data;
}
async function loadDetail() {
  const content = document.getElementById('content'); content.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const data = await anilist(DETAIL_QUERY, { id: ANILIST_ID }); const m = data.Media;
    const title = m.title.english || m.title.romaji || 'Unknown'; registerAniListId(title, m.id);
    const score = m.averageScore ? (m.averageScore / 10).toFixed(1) : '—';
    const isManga = m.format === 'MANGA' || m.format === 'NOVEL' || m.format === 'ONE_SHOT';
    const actionBtn = isManga ? '<a href="/read/' + m.id + '" class="btn">Read Now</a>' : '<a href="/watch/' + m.id + '" class="btn">Watch Now</a>';
    let stats = ''; if (m.format) stats += '<div class="stat">' + m.format + '</div>';
    if (m.episodes) stats += '<div class="stat">' + m.episodes + ' Episodes</div>';
    if (m.chapters) stats += '<div class="stat">' + m.chapters + ' Chapters</div>';
    if (m.status) stats += '<div class="stat">' + m.status.replace(/_/g, ' ') + '</div>';
    if (m.seasonYear) stats += '<div class="stat">' + m.seasonYear + '</div>';
    let genres = ''; if (m.genres && m.genres.length) genres = '<div class="genres">' + m.genres.join(' · ') + '</div>';
    let studio = ''; if (m.studios && m.studios.nodes && m.studios.nodes.length) { studio = '<div class="studio">Studio: ' + m.studios.nodes.map(s => s.name).join(', ') + '</div>'; }
    content.innerHTML = \`<a href="/" class="back-link">← Back to Index</a><div class="record-id">Record #\${m.id}</div><div class="hero"><img src="\${m.coverImage.large}" alt="\${escapeHtml(title)}"><div class="hero-info"><h1>\${escapeHtml(title)}</h1>\${m.title.native ? '<div class="native">' + escapeHtml(m.title.native) + '</div>' : ''}<div class="stat-row"><div class="stat score">\${score} / 10</div>\${stats}</div>\${genres}\${studio}<div class="action-row">\${actionBtn}</div></div></div><div class="section-label">Synopsis</div><div class="description">\${cleanDescription(m.description)}</div>\`;
  } catch (e) { content.innerHTML = '<div class="error">Error: ' + escapeHtml(e.message) + '</div>'; }
}
function onAuthenticated() { loadDetail(); }
</script></body></html>`;
}
function watchPage(pk, cu, anilistId, anivexaApi, streamProxy) {
  const PROXY = streamProxy || 'https://stream-proxy.muldera.workers.dev/?url=';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>The Ledger — Watch #${anilistId}</title>
${clerkHead(pk, cu)}<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js"></script>
<style>${commonCSS()}
.player-wrap { position:relative; width:100%; aspect-ratio:16/9; background:#1a1814; border:1px solid var(--ink); margin-bottom:20px; }
.player-wrap video, .player-wrap iframe { width:100%; height:100%; border:none; display:block; }
.player-overlay { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(26,24,20,.85); z-index:10; transition:opacity .3s; }
.player-overlay.hidden { opacity:0; pointer-events:none; }
.spinner { width:40px; height:40px; border:3px solid var(--rule); border-top-color:var(--accent); border-radius:50%; animation:spin .8s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
.skip-btn { position:absolute; bottom:64px; right:16px; background:var(--accent); color:var(--paper); border:none; padding:6px 14px; font-family:'Courier New',monospace; font-size:0.72rem; letter-spacing:1px; text-transform:uppercase; cursor:pointer; z-index:5; opacity:0; transform:translateY(8px); transition:opacity .3s,transform .3s; }
.skip-btn.visible { opacity:1; transform:translateY(0); }
.watch-layout { display:grid; grid-template-columns:1fr 300px; gap:24px; }
@media(max-width:900px) { .watch-layout { grid-template-columns:1fr; } }
.watch-main { min-width:0; } .watch-sidebar { display:flex; flex-direction:column; gap:16px; }
.watch-card { border:1px solid var(--rule); background:var(--paper-dim); padding:14px; }
.watch-card h3 { font-family:'Courier New',monospace; font-size:0.72rem; letter-spacing:1.5px; text-transform:uppercase; color:var(--accent); border-bottom:1px solid var(--rule); padding-bottom:6px; margin-bottom:10px; }
.provider-tabs { display:flex; gap:4px; flex-wrap:wrap; margin-bottom:10px; }
.provider-tab { padding:5px 10px; border:1px solid var(--rule); background:var(--paper); font-family:'Courier New',monospace; font-size:0.68rem; letter-spacing:1px; text-transform:uppercase; color:var(--ink-soft); cursor:pointer; }
.provider-tab:hover { border-color:var(--ink); } .provider-tab.active { background:var(--ink); color:var(--paper); border-color:var(--ink); }
.audio-toggle { display:flex; gap:4px; margin-bottom:10px; }
.audio-toggle button { flex:1; padding:6px; border:1px solid var(--rule); background:var(--paper); font-family:'Courier New',monospace; font-size:0.68rem; letter-spacing:1px; text-transform:uppercase; color:var(--ink-soft); cursor:pointer; }
.audio-toggle button.active { background:var(--accent); color:var(--paper); border-color:var(--accent); }
.ep-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(36px,1fr)); gap:4px; max-height:240px; overflow-y:auto; }
.ep-grid::-webkit-scrollbar { width:5px; } .ep-grid::-webkit-scrollbar-track { background:var(--paper-dim); } .ep-grid::-webkit-scrollbar-thumb { background:var(--rule); }
.ep-btn { padding:6px 2px; border:1px solid var(--rule); background:var(--paper); font-family:'Courier New',monospace; font-size:0.72rem; font-weight:bold; text-align:center; cursor:pointer; color:var(--ink); }
.ep-btn:hover { border-color:var(--accent); background:var(--accent-soft); } .ep-btn.active { background:var(--accent); color:var(--paper); border-color:var(--accent); } .ep-btn.filler { opacity:.45; }
.server-row { display:flex; gap:6px; flex-wrap:wrap; margin-top:14px; }
.server-btn { padding:5px 10px; border:1px solid var(--rule); background:var(--paper); font-family:'Courier New',monospace; font-size:0.68rem; letter-spacing:1px; text-transform:uppercase; color:var(--ink-soft); cursor:pointer; display:flex; align-items:center; gap:4px; }
.server-btn:hover { border-color:var(--ink); color:var(--ink); } .server-btn.active { border-color:var(--accent); color:var(--accent); background:var(--accent-soft); } .server-btn .dot { width:5px; height:5px; border-radius:50%; background:var(--accent); }
.dl-list { display:flex; flex-direction:column; gap:6px; } .dl-item { display:flex; justify-content:space-between; padding:6px 10px; border:1px solid var(--rule); background:var(--paper); text-decoration:none; color:var(--ink); font-size:0.82rem; } .dl-item:hover { border-color:var(--accent); } .dl-item .host { font-family:'Courier New',monospace; font-size:0.68rem; color:var(--ink-soft); }
.sub-list { display:flex; flex-direction:column; gap:4px; } .sub-item { padding:5px 10px; border:1px solid var(--rule); background:var(--paper); font-size:0.8rem; display:flex; align-items:center; gap:6px; } .sub-item .lang { font-weight:bold; } .sub-item .src { font-family:'Courier New',monospace; font-size:0.66rem; color:var(--ink-soft); margin-left:auto; }
.now-playing { font-size:0.85rem; line-height:1.6; color:var(--ink-soft); } .now-playing strong { color:var(--ink); }
.watch-info { margin-bottom:16px; } .watch-info h1 { font-size:1.6rem; font-weight:400; margin-bottom:4px; } .watch-info .meta { font-family:'Courier New',monospace; font-size:0.72rem; letter-spacing:1px; text-transform:uppercase; color:var(--ink-soft); display:flex; flex-wrap:wrap; gap:12px; } .watch-info .meta .badge { border:1px solid var(--accent); color:var(--accent); padding:1px 8px; }
</style></head><body>
<header><div><h1>The Ledger</h1><div class="tagline">Watch · Record #${anilistId}</div></div><div id="header-right"><span class="loading">Loading…</span></div></header>
<div class="auth-gate" id="auth-gate"><h1>Sign in required</h1><p>Sign in to watch.</p><div class="auth-buttons"><button class="btn" id="gate-signin">Sign In</button><button class="btn" id="gate-signup">Sign Up</button></div></div>
<div class="app" id="app"><main><a href="/detail/${anilistId}" class="back-link">← Back to Details</a><div class="watch-layout"><div class="watch-main">
<div class="player-wrap" id="playerWrap"><div class="player-overlay" id="overlay"><div class="spinner"></div></div><video id="video" controls crossorigin="anonymous" playsinline></video><button class="skip-btn" id="skipBtn">Skip Intro →</button></div>
<div class="watch-info" id="watchInfo" style="display:none;"><h1 id="epTitle">Episode —</h1><div class="meta"><span>Record #<span id="alId">—</span></span><span id="malSpan" style="display:none;">MAL #<span id="malId">—</span></span><span class="badge" id="audioBadge">—</span><span>Provider: <span id="provName">—</span></span></div><div class="server-row" id="serverRow"></div></div>
<div class="error" id="errBox" style="display:none;"></div></div><div class="watch-sidebar">
<div class="watch-card" id="epCard" style="display:none;"><h3>Episodes</h3><div class="provider-tabs" id="provTabs"></div><div class="audio-toggle" id="audioToggle"><button data-audio="sub" class="active">Sub</button><button data-audio="dub">Dub</button></div><div class="ep-grid" id="epGrid"></div></div>
<div class="watch-card" id="nowCard" style="display:none;"><h3>Now Playing</h3><div class="now-playing" id="nowInfo"></div></div>
<div class="watch-card" id="subCard" style="display:none;"><h3>Subtitles</h3><div class="sub-list" id="subList"></div></div>
<div class="watch-card" id="dlCard" style="display:none;"><h3>Downloads</h3><div class="dl-list" id="dlList"></div></div></div></div></main></div>
<script>
${commonAuthJS()}
const ANILIST_API = 'https://graphql.anilist.co'; const ANILIST_ID = ${anilistId}; const STREAM_PROXY = ${JSON.stringify(PROXY)};
let episodesData = null, currentProvider = null, currentAudio = 'sub', currentEpNum = null, watchData = null, currentStreamIndex = 0, hls = null, skipMode = null;
const video = document.getElementById('video'), overlay = document.getElementById('overlay'), skipBtn = document.getElementById('skipBtn');
function escapeHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function showOverlay(show) { overlay.classList.toggle('hidden', !show); }
function showError(msg) { const box = document.getElementById('errBox'); box.textContent = msg; box.style.display = 'block'; }
function hideError() { document.getElementById('errBox').style.display = 'none'; }
function proxyUrl(url) { if (!url) return url; return STREAM_PROXY + encodeURIComponent(url); }
const PROVIDER_SLUGS = { allmanga:'allmanga', reanime:'reanime', anikoto:'anikoto', animegg:'animegg', anineko:'anineko', anidbapp:'anidbapp', '2dhive':'2dhive', animenosub:'animenosub', anizone:'anizone', anibd:'anibd', senshi:'senshi', kaa:'kaa', animedunya:'animedunya' };
function buildWatchUrl(provider, id, audio, ep) { const slug = PROVIDER_SLUGS[provider] || provider; return '/api/watch/' + slug + '/' + id + '/' + audio + '/' + slug + '-' + ep; }
async function fetchTitle() { try { const resp = await fetch(ANILIST_API, { method: 'POST', headers: { 'Content-Type':'application/json','Accept':'application/json' }, body: JSON.stringify({ query: 'query($id:Int){Media(id:$id){id title{romaji english} episodes}}', variables: { id: ANILIST_ID } }) }); const json = await resp.json(); if (json.data && json.data.Media) { const m = json.data.Media; document.title = 'The Ledger — ' + (m.title.english || m.title.romaji || 'Watch'); } } catch {} }
async function fetchEpisodes() {
  showOverlay(true); hideError();
  try { const res = await fetch('/api/episodes/' + ANILIST_ID);
    if (res.status === 502) { showError('Waking up the API server. This can take up to 30 seconds on first load — please try again in a moment.'); setTimeout(() => { hideError(); fetchEpisodes(); }, 10000); return; }
    const data = await res.json(); if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    episodesData = data; renderProviderTabs(data); document.getElementById('epCard').style.display = 'block';
  } catch (err) { showError('Episodes: ' + escapeHtml(err.message)); } finally { showOverlay(false); }
}
function renderProviderTabs(data) {
  const container = document.getElementById('provTabs'); container.innerHTML = ''; const valid = [];
  for (const [key, value] of Object.entries(data)) { if (value && !value.error && value.episodes) { const sub = value.episodes.sub ? value.episodes.sub.length : 0; const dub = value.episodes.dub ? value.episodes.dub.length : 0; if (sub > 0 || dub > 0) valid.push({ slug:key, sub, dub }); } }
  if (!valid.length) { container.innerHTML = '<span style="font-family:Courier New,monospace;font-size:0.72rem;color:var(--ink-soft);">No providers found.</span>'; return; }
  currentProvider = valid[0].slug;
  valid.forEach(p => { const tab = document.createElement('button'); tab.className = 'provider-tab' + (p.slug === currentProvider ? ' active' : ''); tab.innerHTML = p.slug + ' <span style="opacity:.6">' + (p.sub+p.dub) + '</span>'; tab.addEventListener('click', () => { currentProvider = p.slug; document.querySelectorAll('.provider-tab').forEach(t => t.classList.remove('active')); tab.classList.add('active'); renderEpGrid(); }); container.appendChild(tab); });
  renderEpGrid();
}
function renderEpGrid() {
  const grid = document.getElementById('epGrid'); grid.innerHTML = '';
  if (!episodesData || !currentProvider) return;
  const pd = episodesData[currentProvider];
  if (!pd || pd.error || !pd.episodes) { grid.innerHTML = '<span style="font-family:Courier New,monospace;font-size:0.72rem;color:var(--ink-soft);">No episodes.</span>'; return; }
  const eps = pd.episodes[currentAudio] || [];
  if (!eps.length) { grid.innerHTML = '<span style="font-family:Courier New,monospace;font-size:0.72rem;color:var(--ink-soft);">No ' + currentAudio + ' episodes.</span>'; return; }
  eps.forEach(ep => { const btn = document.createElement('button'); btn.className = 'ep-btn' + (currentEpNum === ep.number ? ' active' : '') + (ep.filler ? ' filler' : ''); btn.textContent = ep.number; btn.title = ep.title || 'Episode ' + ep.number; btn.addEventListener('click', () => { currentEpNum = ep.number; document.querySelectorAll('.ep-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); loadWatch(currentProvider, ANILIST_ID, currentAudio, ep.number); }); grid.appendChild(btn); });
}
document.querySelectorAll('#audioToggle button').forEach(btn => { btn.addEventListener('click', () => { currentAudio = btn.dataset.audio; document.querySelectorAll('#audioToggle button').forEach(b => b.classList.remove('active')); btn.classList.add('active'); renderEpGrid(); }); });
async function loadWatch(provider, id, audio, ep) {
  showOverlay(true); hideError();
  try { const res = await fetch(buildWatchUrl(provider, id, audio, ep)); const data = await res.json(); if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    watchData = data; currentStreamIndex = 0; renderInfo(data, provider); renderServers(data); renderSubs(data); renderDls(data); renderNowPlaying(data, provider, ep); playStream(0);
  } catch (err) { showError(escapeHtml(err.message)); showOverlay(false); }
}
function renderInfo(data, provider) {
  document.getElementById('watchInfo').style.display = 'block'; document.getElementById('epTitle').textContent = 'Episode ' + (data.episode || '—'); document.getElementById('alId').textContent = data.anilistId || '—'; document.getElementById('provName').textContent = provider;
  if (data.malId) { document.getElementById('malId').textContent = data.malId; document.getElementById('malSpan').style.display = 'inline'; }
  document.getElementById('audioBadge').textContent = data.audio || currentAudio;
}
function renderServers(data) {
  const row = document.getElementById('serverRow'); row.innerHTML = '';
  if (!data.streams || !data.streams.length) { row.innerHTML = '<span style="font-family:Courier New,monospace;font-size:0.72rem;color:var(--ink-soft);">No streams.</span>'; return; }
  data.streams.forEach((stream, i) => { const btn = document.createElement('button'); btn.className = 'server-btn' + (i === 0 ? ' active' : ''); btn.innerHTML = (stream.isActive ? '<span class="dot"></span>' : '') + '<span>' + escapeHtml(stream.server || 'Server ' + (i+1)) + '</span> <span style="opacity:.5">' + escapeHtml(stream.type || '?') + '</span>'; btn.addEventListener('click', () => { document.querySelectorAll('.server-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); currentStreamIndex = i; playStream(i); }); row.appendChild(btn); });
}
function playStream(index) {
  if (!watchData || !watchData.streams || !watchData.streams[index]) return;
  const stream = watchData.streams[index]; showOverlay(true);
  if (hls) { hls.destroy(); hls = null; } video.removeAttribute('src'); video.innerHTML = '';
  const existingIframe = document.querySelector('.player-wrap iframe'); if (existingIframe) existingIframe.remove(); video.style.display = 'block';
  if (stream.type === 'hls' && stream.url) { playHLS(stream); } else if (stream.type === 'embed' && stream.embedUrl) { playEmbed(stream); } else if (stream.embedUrl) { playEmbed(stream); } else if (stream.url) { video.src = proxyUrl(stream.url); video.load(); showOverlay(false); } else { showError('No playable URL for this server.'); showOverlay(false); }
  setupSkip(stream);
}
function playHLS(stream) {
  if (stream.subtitles && stream.subtitles.length) { stream.subtitles.forEach(sub => { const track = document.createElement('track'); track.kind = 'subtitles'; track.label = sub.label || 'English'; track.srclang = sub.srclang || 'en'; track.src = sub.url; if (sub.default) track.default = true; video.appendChild(track); }); }
  const streamUrl = proxyUrl(stream.url);
  if (Hls.isSupported()) { hls = new Hls({ enableWorker:true, lowLatencyMode:true, backBufferLength:90 }); hls.loadSource(streamUrl); hls.attachMedia(video); hls.on(Hls.Events.MANIFEST_PARSED, () => { showOverlay(false); video.play().catch(()=>{}); }); hls.on(Hls.Events.ERROR, (event, data) => { if (data.fatal) { switch (data.type) { case Hls.ErrorTypes.NETWORK_ERROR: hls.startLoad(); break; case Hls.ErrorTypes.MEDIA_ERROR: hls.recoverMediaError(); break; default: showError('HLS playback failed. Try another server.'); hls.destroy(); showOverlay(false); break; } } }); }
  else if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = streamUrl; video.addEventListener('loadedmetadata', () => { showOverlay(false); video.play().catch(()=>{}); }, { once:true }); }
  else { showError('HLS not supported.'); showOverlay(false); }
}
function playEmbed(stream) { if (!stream.embedUrl) { showError('No embed URL.'); showOverlay(false); return; } video.style.display = 'none'; const iframe = document.createElement('iframe'); iframe.src = stream.embedUrl; iframe.allow = 'fullscreen;autoplay;encrypted-media;picture-in-picture'; iframe.allowFullscreen = true; iframe.sandbox = 'allow-scripts allow-same-origin allow-presentation allow-forms'; document.getElementById('playerWrap').appendChild(iframe); showOverlay(false); }
function setupSkip(stream) { skipBtn.classList.remove('visible'); skipMode = null; const intro = stream.intro || watchData.intro; const outro = stream.outro || watchData.outro; if (!intro && !outro) return; video.addEventListener('timeupdate', function check() { const t = video.currentTime; if (intro && t >= intro.start && t < intro.end - 2) { skipMode = 'intro'; skipBtn.textContent = 'Skip Intro →'; skipBtn.classList.add('visible'); } else if (outro && t >= outro.start && t < outro.end - 2) { skipMode = 'outro'; skipBtn.textContent = 'Skip Outro →'; skipBtn.classList.add('visible'); } else { skipBtn.classList.remove('visible'); } }, { passive:true }); }
skipBtn.addEventListener('click', () => { if (skipMode === 'intro') { const i = watchData.streams[currentStreamIndex]?.intro || watchData.intro; if (i) video.currentTime = i.end; } else if (skipMode === 'outro') { const o = watchData.streams[currentStreamIndex]?.outro || watchData.outro; if (o) video.currentTime = o.end; } skipBtn.classList.remove('visible'); });
function renderNowPlaying(data, provider, ep) { document.getElementById('nowCard').style.display = 'block'; const info = document.getElementById('nowInfo'); const pd = episodesData?.[provider]; const epInfo = pd?.episodes?.[data.audio || currentAudio]?.find(e => e.number === ep); info.innerHTML = '<div><strong>Episode ' + (data.episode || ep) + '</strong></div>' + (epInfo?.title ? '<div>' + escapeHtml(epInfo.title) + '</div>' : '') + '<div style="margin-top:4px;">Provider: <strong>' + escapeHtml(provider) + '</strong></div><div>Audio: <strong>' + (data.audio || currentAudio) + '</strong></div><div>Streams: <strong>' + (data.streams?.length || 0) + '</strong></div>'; }
function renderSubs(data) { const card = document.getElementById('subCard'); const list = document.getElementById('subList'); const all = []; if (data.subtitles) data.subtitles.forEach(s => all.push({ ...s, source:s.source||'API' })); if (data.streams) data.streams.forEach(st => { if (st.subtitles) st.subtitles.forEach(s => { if (!all.find(x=>x.url===s.url)) all.push({ ...s, source:st.server||'Unknown' }); }); }); if (!all.length) { card.style.display = 'none'; return; } card.style.display = 'block'; list.innerHTML = ''; all.forEach(sub => { const item = document.createElement('div'); item.className = 'sub-item'; item.innerHTML = '<span class="lang">' + escapeHtml(sub.label || sub.srclang || 'Unknown') + '</span>' + (sub.default ? '<span style="color:var(--accent);font-size:0.66rem;">●</span>' : '') + '<span class="src">' + escapeHtml(sub.source) + '</span>'; list.appendChild(item); }); }
function renderDls(data) { const card = document.getElementById('dlCard'); const list = document.getElementById('dlList'); if (!data.downloads || !data.downloads.length) { card.style.display = 'none'; return; } card.style.display = 'block'; list.innerHTML = ''; data.downloads.forEach(dl => { const item = document.createElement('a'); item.className = 'dl-item'; item.href = dl.url; item.target = '_blank'; item.rel = 'noopener noreferrer'; let host = 'Unknown'; try { host = new URL(dl.url).hostname; } catch {} item.innerHTML = '<span>' + escapeHtml(dl.label || 'Download') + '</span><span class="host">' + escapeHtml(host) + '</span>'; list.appendChild(item); }); }
video.addEventListener('waiting', () => showOverlay(true)); video.addEventListener('playing', () => showOverlay(false)); video.addEventListener('canplay', () => showOverlay(false)); video.addEventListener('error', () => { showOverlay(false); });
function onAuthenticated() { fetchTitle(); fetchEpisodes(); }
</script></body></html>`;
}
function readPage(pk, cu, anilistId, anivexaApi, streamProxy) {
  const PROXY = streamProxy || 'https://stream-proxy.muldera.workers.dev/?url=';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>The Ledger — Read #${anilistId}</title>
${clerkHead(pk, cu)}<style>${commonCSS()}
.read-layout { display:grid; grid-template-columns:1fr 280px; gap:24px; }
@media(max-width:900px) { .read-layout { grid-template-columns:1fr; } }
.read-main { min-width:0; } .read-sidebar { display:flex; flex-direction:column; gap:16px; }
.read-card { border:1px solid var(--rule); background:var(--paper-dim); padding:14px; }
.read-card h3 { font-family:'Courier New',monospace; font-size:0.72rem; letter-spacing:1.5px; text-transform:uppercase; color:var(--accent); border-bottom:1px solid var(--rule); padding-bottom:6px; margin-bottom:10px; }
.reader-viewer { background:#1a1814; border:1px solid var(--ink); margin-bottom:16px; }
.reader-viewer img { display:block; width:100%; max-width:900px; margin:0 auto; }
.reader-nav { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:12px 0; border-top:1px solid var(--rule); border-bottom:1px solid var(--rule); margin-bottom:16px; }
.reader-nav button { padding:8px 18px; border:1px solid var(--ink); background:var(--paper); font-family:'Courier New',monospace; font-size:0.72rem; letter-spacing:1px; text-transform:uppercase; cursor:pointer; color:var(--ink); }
.reader-nav button:hover:not(:disabled) { background:var(--ink); color:var(--paper); } .reader-nav button:disabled { opacity:.35; cursor:not-allowed; }
.reader-nav .page-info { font-family:'Courier New',monospace; font-size:0.72rem; letter-spacing:1px; text-transform:uppercase; color:var(--ink-soft); }
.chapter-list { display:flex; flex-direction:column; gap:4px; max-height:400px; overflow-y:auto; }
.chapter-list::-webkit-scrollbar { width:5px; } .chapter-list::-webkit-scrollbar-track { background:var(--paper-dim); } .chapter-list::-webkit-scrollbar-thumb { background:var(--rule); }
.chapter-item { padding:8px 10px; border:1px solid var(--rule); background:var(--paper); font-size:0.82rem; cursor:pointer; display:flex; justify-content:space-between; align-items:center; }
.chapter-item:hover { border-color:var(--accent); background:var(--accent-soft); } .chapter-item.active { border-color:var(--accent); background:var(--accent-soft); color:var(--accent); font-weight:bold; }
.chapter-item .ch-num { font-family:'Courier New',monospace; font-size:0.72rem; } .chapter-item .ch-group { font-family:'Courier New',monospace; font-size:0.66rem; color:var(--ink-soft); }
.lang-filter { display:flex; gap:4px; flex-wrap:wrap; margin-bottom:10px; } .lang-btn { padding:4px 10px; border:1px solid var(--rule); background:var(--paper); font-family:'Courier New',monospace; font-size:0.66rem; letter-spacing:1px; text-transform:uppercase; cursor:pointer; color:var(--ink-soft); } .lang-btn.active { background:var(--ink); color:var(--paper); border-color:var(--ink); }
.read-info { margin-bottom:16px; } .read-info h1 { font-size:1.6rem; font-weight:400; margin-bottom:4px; } .read-info .meta { font-family:'Courier New',monospace; font-size:0.72rem; letter-spacing:1px; text-transform:uppercase; color:var(--ink-soft); }
.mode-toggle { display:flex; gap:4px; margin-bottom:10px; } .mode-toggle button { flex:1; padding:6px; border:1px solid var(--rule); background:var(--paper); font-family:'Courier New',monospace; font-size:0.68rem; letter-spacing:1px; text-transform:uppercase; cursor:pointer; color:var(--ink-soft); } .mode-toggle button.active { background:var(--accent); color:var(--paper); border-color:var(--accent); }
.reader-viewer.double { display:flex; justify-content:center; gap:2px; } .reader-viewer.double img { width:50%; max-width:50%; height:auto; object-fit:contain; } .reader-viewer.double img:only-child { width:100%; max-width:900px; }
.reader-viewer:fullscreen { background:#1a1814; display:flex; align-items:center; justify-content:center; } .reader-viewer:fullscreen img { max-height:100vh; width:auto; max-width:100%; object-fit:contain; }
.reader-viewer.double:fullscreen { align-items:center; } .reader-viewer.double:fullscreen img { max-height:100vh; width:50%; max-width:50%; object-fit:contain; }
.reader-empty { text-align:center; padding:80px 20px; } .reader-empty h2 { font-size:1.4rem; font-weight:400; margin-bottom:8px; } .reader-empty p { color:var(--ink-soft); font-family:'Courier New',monospace; font-size:0.78rem; letter-spacing:1px; text-transform:uppercase; }
</style></head><body>
<header><div><h1>The Ledger</h1><div class="tagline">Read · Record #${anilistId}</div></div><div id="header-right"><span class="loading">Loading…</span></div></header>
<div class="auth-gate" id="auth-gate"><h1>Sign in required</h1><p>Sign in to read.</p><div class="auth-buttons"><button class="btn" id="gate-signin">Sign In</button><button class="btn" id="gate-signup">Sign Up</button></div></div>
<div class="app" id="app"><main><a href="/detail/${anilistId}" class="back-link">← Back to Details</a><div class="read-layout"><div class="read-main">
<div class="read-info" id="readInfo" style="display:none;"><h1 id="mangaTitle">—</h1><div class="meta" id="mangaMeta"></div></div>
<div class="reader-empty" id="readerEmpty"><h2>Select a chapter</h2><p>Choose from the list →</p></div>
<div class="reader-viewer" id="readerViewer" style="display:none;"></div>
<div class="reader-nav" id="readerNav" style="display:none;"><button id="prevPage" disabled>← Prev</button><span class="page-info" id="pageInfo">—</span><button id="nextPage" disabled>Next →</button></div>
<div class="reader-nav" id="chapterNav" style="display:none;"><button id="prevCh" disabled>← Prev Chapter</button><span class="page-info" id="chInfo">—</span><button id="nextCh" disabled>Next Chapter →</button></div>
</div><div class="read-sidebar">
<div class="read-card" style="display:block;"><h3>Chapters</h3><div class="lang-filter" id="langFilter"></div><div class="chapter-list" id="chapterList"><div style="font-family:Courier New,monospace;font-size:0.72rem;color:var(--ink-soft);padding:10px;">Waiting for sign-in…</div></div></div>
<div class="read-card" id="readerSettingsCard" style="display:none;"><h3>Reader Settings</h3><div class="mode-toggle" id="modeToggle"><button data-mode="single" class="active">Single</button><button data-mode="double">Double</button><button data-mode="vertical">Vertical</button></div><button id="fullscreenBtn" style="width:100%;margin-top:8px;padding:8px;border:1px solid var(--ink);background:var(--paper);font-family:'Courier New',monospace;font-size:0.68rem;letter-spacing:1px;text-transform:uppercase;cursor:pointer;color:var(--ink);">Enter Fullscreen</button></div>
</div></div></main></div>
<script>
${commonAuthJS()}
const ANILIST_API = 'https://graphql.anilist.co'; const MANGADEX_API = '/md'; const STREAM_PROXY = ${JSON.stringify(PROXY)}; const ANILIST_ID = ${anilistId};
function mdFetch(path) { return fetch('/md' + path); }
let mangaTitle = '', mangaDexId = null, chapters = [], currentChapterIndex = -1, currentPages = [], currentPageIndex = 0, readerMode = 'single', currentLang = 'en';
function escapeHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
async function fetchTitle() {
  const empty = document.getElementById('readerEmpty');
  try { const resp = await fetch(ANILIST_API, { method: 'POST', headers: { 'Content-Type':'application/json','Accept':'application/json' }, body: JSON.stringify({ query: 'query($id:Int){Media(id:$id){id title{romaji english native} format coverImage{large}}}', variables: { id: ANILIST_ID } }) });
    const json = await resp.json();
    if (json.errors) { empty.innerHTML = '<h2>AniList error</h2><p>' + escapeHtml(json.errors[0].message) + '</p>'; return null; }
    if (json.data && json.data.Media) { const m = json.data.Media; mangaTitle = m.title.english || m.title.romaji || m.title.native || 'Unknown'; document.getElementById('mangaTitle').textContent = mangaTitle; document.getElementById('readInfo').style.display = 'block'; document.getElementById('mangaMeta').textContent = 'Record #' + ANILIST_ID + (m.format ? ' · ' + m.format : ''); document.title = 'The Ledger — ' + mangaTitle; return mangaTitle; }
    else { empty.innerHTML = '<h2>Not found</h2><p>No AniList entry for ID ' + ANILIST_ID + '.</p>'; return null; }
  } catch (err) { empty.innerHTML = '<h2>Network error</h2><p>' + escapeHtml(err.message) + '</p>'; return null; }
}
async function safeJson(resp) { const text = await resp.text(); try { return JSON.parse(text); } catch { return { result: 'error', errors: [{ detail: 'Invalid response: ' + text.substring(0, 200) }] }; } }
async function searchMangaDex(title) {
  const empty = document.getElementById('readerEmpty');
  try { let url = MANGADEX_API + '/manga?title=' + encodeURIComponent(title) + '&limit=5&order[relevance]=desc'; let resp = await mdFetch(url.replace(MANGADEX_API,"")); let data = await safeJson(resp);
    if (data.data && data.data.length > 0) return data.data[0].id;
    const shortTitle = title.split(' ').slice(0, 3).join(' ');
    if (shortTitle !== title) { url = MANGADEX_API + '/manga?title=' + encodeURIComponent(shortTitle) + '&limit=5&order[relevance]=desc'; resp = await mdFetch(url.replace(MANGADEX_API,"")); data = await safeJson(resp); if (data.data && data.data.length > 0) return data.data[0].id; }
    const cleanTitle = title.replace(/[^\\w\\s]/g, '').trim();
    if (cleanTitle && cleanTitle !== title) { url = MANGADEX_API + '/manga?title=' + encodeURIComponent(cleanTitle) + '&limit=5&order[relevance]=desc'; resp = await mdFetch(url.replace(MANGADEX_API,"")); data = await safeJson(resp); if (data.data && data.data.length > 0) return data.data[0].id; }
    if (data.errors) { empty.innerHTML = '<h2>MangaDex error</h2><p>' + escapeHtml(data.errors[0].detail || 'Unknown error') + '</p>'; return null; }
    empty.innerHTML = '<h2>Not on MangaDex</h2><p>Could not find "' + escapeHtml(title) + '" on MangaDex.</p>'; return null;
  } catch (err) { empty.innerHTML = '<h2>MangaDex error</h2><p>' + escapeHtml(err.message) + '</p>'; return null; }
}
async function fetchChapters(mdId) {
  const empty = document.getElementById('readerEmpty');
  let allChapters = [];
  let offset = 0;
  const limit = 500;
  try {
    while (true) {
      const url = MANGADEX_API + '/manga/' + mdId + '/feed?limit=' + limit + '&offset=' + offset + '&order[chapter]=asc&includes[]=scanlation_group';
      let resp = await mdFetch(url.replace(MANGADEX_API,""));
      let data = await safeJson(resp);
      if (data.errors || !data.data) {
        await new Promise(r => setTimeout(r, 2000));
        resp = await mdFetch(url.replace(MANGADEX_API,""));
        data = await safeJson(resp);
      }
      if (data.errors) {
        empty.innerHTML = '<h2>MangaDex API error</h2><p>' + escapeHtml(data.errors[0].detail || data.errors[0].title || 'Unknown') + '</p>';
        return [];
      }
      if (!data.data) { empty.innerHTML = '<h2>No data</h2><p>MangaDex returned no data. (result=' + (data.result||'none') + ')</p>'; return []; }
      const valid = data.data.filter(ch => {
        const attr = ch.attributes || ch;
        if (attr.externalUrl) return false;
        if (attr.isUnavailable) return false;
        return true;
      });
      allChapters = allChapters.concat(valid);
      if (data.data.length < limit) break;
      offset += limit;
    }
    const englishChapters = allChapters.filter(ch => {
      const attr = ch.attributes || ch;
      return (attr.translatedLanguage || 'en') === 'en';
    });
    if (englishChapters.length) {
      allChapters = englishChapters;
    }
    if (!allChapters.length) {
      empty.innerHTML = '<h2>No chapters</h2><p>No chapters available for this manga.</p>';
    }
    return allChapters;
  } catch (err) {
    empty.innerHTML = '<h2>Network error</h2><p>' + escapeHtml(err.message) + '</p>';
    return [];
  }
}
function renderLangFilter() { return; }
function renderChapterList() {
  const list = document.getElementById('chapterList'); list.innerHTML = '';
  const filtered = chapters;
  if (!filtered.length) { list.innerHTML = '<div style="font-family:Courier New,monospace;font-size:0.72rem;color:var(--ink-soft);padding:10px;">No chapters found.</div>'; return; }
  filtered.forEach((ch, idx) => {
    const attr = ch.attributes || ch; const chNum = attr.chapter || '?'; const chTitle = attr.title || '';
    let groupName = ''; if (ch.relationships) { const group = ch.relationships.find(r => r.type === 'scanlation_group'); if (group) groupName = group.attributes?.name || ''; }
    const item = document.createElement('div'); item.className = 'chapter-item' + (currentChapterIndex === idx ? ' active' : '');
    item.innerHTML = '<span><span class="ch-num">Ch.' + escapeHtml(chNum) + '</span>' + (chTitle ? ' — ' + escapeHtml(chTitle) : '') + '</span>' + (groupName ? '<span class="ch-group">' + escapeHtml(groupName) + '</span>' : '');
    item.addEventListener('click', () => { currentChapterIndex = idx; document.querySelectorAll('.chapter-item').forEach(c => c.classList.remove('active')); item.classList.add('active'); loadChapter(filtered[idx], idx); });
    list.appendChild(item);
  });
  chapters._filtered = filtered;
}
async function loadChapter(chapter, idx) {
  document.getElementById('readerEmpty').style.display = 'none'; document.getElementById('readerViewer').style.display = 'block'; document.getElementById('readerSettingsCard').style.display = 'block';
  document.getElementById('readerViewer').innerHTML = '<div style="text-align:center;padding:60px;font-family:Courier New,monospace;font-size:0.8rem;color:#d8cdb8;">Loading pages…</div>';
  const chId = chapter.id;
  try { const resp = await mdFetch('/at-home/server/' + chId); const data = await safeJson(resp);
    if (data.result !== 'ok') { const filtered = chapters._filtered || []; if (idx + 1 < filtered.length) { currentChapterIndex = idx + 1; document.querySelectorAll('.chapter-item').forEach(c => c.classList.remove('active')); document.querySelectorAll('.chapter-item')[currentChapterIndex]?.classList.add('active'); return loadChapter(filtered[currentChapterIndex], currentChapterIndex); } throw new Error('Chapter not available on MangaDex servers.'); }
    const baseUrl = data.baseUrl; if (!baseUrl) throw new Error('No server URL in response (result=' + (data.result||'none') + ')');
    const ch = data.chapter || {}; const attr = chapter.attributes || chapter; const hash = ch.hash || attr.hash;
    const files = (ch.data && ch.data.length) ? ch.data : (ch.dataSaver && ch.dataSaver.length) ? ch.dataSaver : (attr.data || attr.dataSaver || []);
    if (!hash || !files.length) throw new Error('No page data (hash=' + (hash||'none') + ', files=' + files.length + ')');
    const qualityPath = (ch.data && ch.data.length) ? 'data' : (attr.data && attr.data.length) ? 'data' : 'data-saver';
    currentPages = files.map(f => STREAM_PROXY + encodeURIComponent(baseUrl + '/' + qualityPath + '/' + hash + '/' + f));
    currentPageIndex = 0; renderPages(); updateChapterNav(idx);
  } catch (err) { document.getElementById('readerViewer').innerHTML = '<div style="text-align:center;padding:60px;font-family:Courier New,monospace;font-size:0.8rem;color:#f87171;">Failed to load: ' + escapeHtml(err.message) + '</div>'; }
}
function renderPages() {
  const viewer = document.getElementById('readerViewer'); viewer.classList.remove('double');
  if (readerMode === 'single') { viewer.innerHTML = '<img src="' + currentPages[currentPageIndex] + '" alt="Page ' + (currentPageIndex+1) + '" />'; document.getElementById('readerNav').style.display = 'flex'; document.getElementById('prevPage').disabled = currentPageIndex === 0; document.getElementById('nextPage').disabled = currentPageIndex >= currentPages.length - 1; document.getElementById('pageInfo').textContent = 'Page ' + (currentPageIndex+1) + ' / ' + currentPages.length; }
  else if (readerMode === 'double') { viewer.classList.add('double'); let html = '<img src="' + currentPages[currentPageIndex] + '" alt="Page ' + (currentPageIndex+1) + '" />'; if (currentPageIndex + 1 < currentPages.length) { html += '<img src="' + currentPages[currentPageIndex + 1] + '" alt="Page ' + (currentPageIndex+2) + '" />'; } viewer.innerHTML = html; document.getElementById('readerNav').style.display = 'flex'; document.getElementById('prevPage').disabled = currentPageIndex === 0; document.getElementById('nextPage').disabled = currentPageIndex + 2 >= currentPages.length; document.getElementById('pageInfo').textContent = 'Pages ' + (currentPageIndex+1) + '-' + (Math.min(currentPageIndex+2, currentPages.length)) + ' / ' + currentPages.length; }
  else { viewer.innerHTML = currentPages.map((url, i) => '<img src="' + url + '" alt="Page ' + (i+1) + '" />').join(''); document.getElementById('readerNav').style.display = 'none'; }
}
function updateChapterNav(idx) { document.getElementById('chapterNav').style.display = 'flex'; const filtered = chapters._filtered || []; document.getElementById('prevCh').disabled = idx <= 0; document.getElementById('nextCh').disabled = idx >= filtered.length - 1; document.getElementById('chInfo').textContent = 'Chapter ' + (idx + 1) + ' / ' + filtered.length; }
document.getElementById('prevPage').addEventListener('click', () => { const step = readerMode === 'double' ? 2 : 1; if (currentPageIndex > 0) { currentPageIndex = Math.max(0, currentPageIndex - step); renderPages(); window.scrollTo(0,0); } });
document.getElementById('nextPage').addEventListener('click', () => { const step = readerMode === 'double' ? 2 : 1; if (currentPageIndex < currentPages.length - 1) { currentPageIndex = Math.min(currentPages.length - 1, currentPageIndex + step); renderPages(); window.scrollTo(0,0); } });
document.getElementById('prevCh').addEventListener('click', () => { const filtered = chapters._filtered || []; if (currentChapterIndex > 0) { currentChapterIndex--; document.querySelectorAll('.chapter-item').forEach(c => c.classList.remove('active')); document.querySelectorAll('.chapter-item')[currentChapterIndex]?.classList.add('active'); loadChapter(filtered[currentChapterIndex], currentChapterIndex); } });
document.getElementById('nextCh').addEventListener('click', () => { const filtered = chapters._filtered || []; if (currentChapterIndex < filtered.length - 1) { currentChapterIndex++; document.querySelectorAll('.chapter-item').forEach(c => c.classList.remove('active')); document.querySelectorAll('.chapter-item')[currentChapterIndex]?.classList.add('active'); loadChapter(filtered[currentChapterIndex], currentChapterIndex); } });
document.querySelectorAll('#modeToggle button').forEach(btn => { btn.addEventListener('click', () => { readerMode = btn.dataset.mode; document.querySelectorAll('#modeToggle button').forEach(b => b.classList.remove('active')); btn.classList.add('active'); if (currentPages.length) renderPages(); }); });
document.addEventListener('keydown', (e) => { if (!currentPages.length) return; if (readerMode === 'vertical') return; const step = readerMode === 'double' ? 2 : 1; if (e.key === 'ArrowLeft' && currentPageIndex > 0) { currentPageIndex = Math.max(0, currentPageIndex - step); renderPages(); window.scrollTo(0,0); } if (e.key === 'ArrowRight' && currentPageIndex < currentPages.length - 1) { currentPageIndex = Math.min(currentPages.length - 1, currentPageIndex + step); renderPages(); window.scrollTo(0,0); } });
const fullscreenBtn = document.getElementById('fullscreenBtn'); const readerViewer = document.getElementById('readerViewer');
fullscreenBtn.addEventListener('click', () => { if (document.fullscreenElement) { document.exitFullscreen(); } else { readerViewer.requestFullscreen().catch(() => {}); } });
document.addEventListener('fullscreenchange', () => { fullscreenBtn.textContent = document.fullscreenElement ? 'Exit Fullscreen' : 'Enter Fullscreen'; });
async function onAuthenticated() {
  const empty = document.getElementById('readerEmpty');
  empty.innerHTML = '<h2>Loading…</h2><p>Fetching manga data.</p>';
  const title = await fetchTitle(); if (!title) return;
  empty.innerHTML = '<h2>Searching…</h2><p>Looking for "' + escapeHtml(title) + '" on MangaDex.</p>';
  mangaDexId = await searchMangaDex(title); if (!mangaDexId) return;
  empty.innerHTML = '<h2>Loading chapters…</h2><p>Fetching chapter list from MangaDex.</p>';
  chapters = await fetchChapters(mangaDexId); if (!chapters.length) return;
  renderLangFilter(); renderChapterList(); empty.style.display = 'none';
}
</script></body></html>`;
}
