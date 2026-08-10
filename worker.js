export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const pk = env.CLERK_PUBLISHABLE_KEY || '';
    const cu = env.CLERK_FRONTEND_API_URL || '';
    const parts = path.split('/').filter(Boolean);

    // TMDB API proxy (injects API key server-side)
    if (parts[0] === 'api' && parts[1] === 'tmdb') { return handleTmdbProxy(request, env); }

    // Route parsing
    let mediaType = null, mediaId = null;
    if (parts[0] === 'detail' && parts.length >= 3 && ['tv', 'movie'].includes(parts[1])) {
      mediaType = parts[1]; mediaId = parts[2];
    } else if (parts[0] === 'detail' && parts.length >= 2 && /^\d+$/.test(parts[1])) {
      mediaId = parts[1];
    }
    if (parts[0] === 'watch' && parts.length >= 3 && ['tv', 'movie'].includes(parts[1])) {
      mediaType = parts[1]; mediaId = parts[2];
    }

    let html;
    if (path === '/' || path === '/index.html') { html = indexPage(pk, cu); }
    else if (parts[0] === 'detail' && mediaId && /^\d+$/.test(mediaId)) { html = detailPage(pk, cu, mediaId, mediaType); }
    else if (parts[0] === 'watch' && mediaType && mediaId && /^\d+$/.test(mediaId)) { html = watchPage(pk, cu, mediaType, mediaId); }
    else { return new Response('Not Found', { status: 404 }); }
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
  }
};

// ── TMDB Proxy ──────────────────────────────────────────────────────────────
async function handleTmdbProxy(request, env) {
  const url = new URL(request.url);
  const apiPath = url.pathname.replace(/^\/api\/tmdb/, '') || '/';
  const apiKey = env.TMDB_API_KEY || '';
  const sep = url.search ? '&' : '?';
  const targetUrl = 'https://api.themoviedb.org/3' + apiPath + (url.search || '') + sep + 'api_key=' + apiKey;
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
    return new Response(JSON.stringify({ error: 'TMDB unavailable: ' + err.message }), { status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
}

// ── Clerk head ──────────────────────────────────────────────────────────────
function clerkHead(pk, cu) {
  return `<script async crossorigin="anonymous" data-clerk-publishable-key="${pk}" type="text/javascript" src="${cu}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script>`;
}

// ── Common CSS ──────────────────────────────────────────────────────────────
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
.search-row { display:none; max-width:1100px; margin:20px auto 0; padding:0 24px; gap:10px; align-items:center; }
.search-row.visible { display:flex; }
.search-row input, .search-row select { padding:10px 12px; border:1px solid var(--ink); background:var(--paper); font-family:inherit; font-size:0.9rem; color:var(--ink); }
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
.error { color:var(--accent); }`;
}

// ── Common auth JS ──────────────────────────────────────────────────────────
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

// ── Index page ──────────────────────────────────────────────────────────────
function indexPage(pk, cu) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>The Ledger — TV &amp; Movie Index</title>
${clerkHead(pk, cu)}<style>${commonCSS()}</style></head><body>
<header><div><h1>The Ledger</h1><div class="tagline">An Index of TV &amp; Film</div><div class="dateline" id="dateline"></div></div><div id="header-right"><span class="loading">Loading…</span></div></header>
<div class="auth-gate" id="auth-gate"><h1>Sign in required</h1><p>Sign in to browse the index — Top Rated, Popular, Trending, and Search.</p><div class="auth-buttons"><button class="btn" id="gate-signin">Sign In</button><button class="btn" id="gate-signup">Sign Up</button></div></div>
<div class="app" id="app">
<nav class="sections" id="nav-sections"><button class="active" data-mode="top-tv">Top TV</button><button data-mode="top-movie">Top Films</button><button data-mode="popular-tv">Popular TV</button><button data-mode="popular-movie">Popular Films</button><button data-mode="trending">Trending</button><button data-mode="now-playing">In Theaters</button><button data-mode="search">Search the Index</button></nav>
<div class="search-row" id="search-row"><input type="text" id="search-input" placeholder="Search a title..."><select id="search-type"><option value="tv">TV Show</option><option value="movie">Movie</option></select><button id="search-btn">Search</button></div>
<main><div id="content" class="grid"></div></main></div>
<script>
${commonAuthJS()}
const TMDB_PROXY = '/api/tmdb';
let content, navSections, searchRow; let authInit = false;
function escapeHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function tmdb(path) { return fetch(TMDB_PROXY + path).then(r => r.json()); }
function posterUrl(p) { return p ? 'https://image.tmdb.org/t/p/w342' + p : 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="300"%3E%3Crect fill="%23ece5d8" width="200" height="300"/%3E%3Ctext x="100" y="150" text-anchor="middle" fill="%235c5347" font-family="monospace" font-size="12"%3ENo Image%3C/text%3E%3C/svg%3E'; }

function renderGrid(items) {
  if (!items || items.length === 0) { content.innerHTML = '<div class="empty">No entries found.</div>'; return; }
  content.innerHTML = items.map((item, i) => renderEntry(item, i)).join('');
  content.querySelectorAll('.entry').forEach(el => { el.addEventListener('click', () => { window.location.href = '/detail/' + el.dataset.type + '/' + el.dataset.id; }); });
}
function renderEntry(item, index) {
  const title = item.name || item.title || 'Unknown';
  const score = item.vote_average ? item.vote_average.toFixed(1) : '—';
  const date = item.release_date || item.first_air_date || '';
  const year = date ? date.substring(0, 4) : '';
  const type = item.media_type || (item.name ? 'tv' : 'movie');
  const num = String(index + 1).padStart(2, '0');
  return \`<a class="entry" data-id="\${item.id}" data-type="\${type}"><img src="\${posterUrl(item.poster_path)}" alt="\${escapeHtml(title)}" loading="lazy"><div class="num">No. \${num}</div><div class="name">\${escapeHtml(title)}</div><div class="meta">\${type === 'tv' ? 'TV' : 'Film'} \${year ? '· ' + year : ''} · <span class="score">\${score}</span></div></a>\`;
}
let currentMode = 'top-tv';
async function loadMode(mode) {
  currentMode = mode; searchRow.classList.toggle('visible', mode === 'search');
  navSections.querySelectorAll('button').forEach(b => { b.classList.toggle('active', b.dataset.mode === mode); });
  content.innerHTML = '<div class="loading">Loading…</div>';
  try { let data;
    if (mode === 'top-tv') { data = await tmdb('/tv/top_rated?page=1'); renderGrid(data.results || []); }
    else if (mode === 'top-movie') { data = await tmdb('/movie/top_rated?page=1'); renderGrid(data.results || []); }
    else if (mode === 'popular-tv') { data = await tmdb('/tv/popular?page=1'); renderGrid(data.results || []); }
    else if (mode === 'popular-movie') { data = await tmdb('/movie/popular?page=1'); renderGrid(data.results || []); }
    else if (mode === 'trending') { data = await tmdb('/trending/all/week?page=1'); renderGrid(data.results || []); }
    else if (mode === 'now-playing') { data = await tmdb('/movie/now_playing?page=1'); renderGrid(data.results || []); }
  } catch (e) { content.innerHTML = '<div class="error">Error: ' + escapeHtml(e.message) + '</div>'; }
}
async function doSearch() {
  const query = document.getElementById('search-input').value.trim(); const type = document.getElementById('search-type').value; if (!query) return;
  content.innerHTML = '<div class="loading">Searching…</div>';
  try { const data = await tmdb('/search/' + type + '?query=' + encodeURIComponent(query) + '&page=1'); renderGrid(data.results || []); } catch (e) { content.innerHTML = '<div class="error">Error: ' + escapeHtml(e.message) + '</div>'; }
}
function onAuthenticated() {
  if (authInit) return; authInit = true;
  content = document.getElementById('content'); navSections = document.getElementById('nav-sections'); searchRow = document.getElementById('search-row');
  navSections.querySelectorAll('button').forEach(btn => { btn.addEventListener('click', () => loadMode(btn.dataset.mode)); });
  document.getElementById('search-btn').addEventListener('click', doSearch);
  document.getElementById('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  loadMode('top-tv');
}
const dl = document.getElementById('dateline');
if (dl) dl.textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
</script></body></html>`;
}

// ── Detail page ─────────────────────────────────────────────────────────────
function detailPage(pk, cu, mediaId, mediaType) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>The Ledger — Record #${mediaId}</title>
${clerkHead(pk, cu)}<style>${commonCSS()}</style></head><body>
<header><div><h1>The Ledger</h1><div class="tagline">Record #${mediaId}</div></div><div id="header-right"><span class="loading">Loading…</span></div></header>
<div class="auth-gate" id="auth-gate"><h1>Sign in required</h1><p>Sign in to view this record.</p><div class="auth-buttons"><button class="btn" id="gate-signin">Sign In</button><button class="btn" id="gate-signup">Sign Up</button></div></div>
<div class="app" id="app"><main><div id="content"><div class="loading">Loading…</div></div></main></div>
<script>
${commonAuthJS()}
const TMDB_PROXY = '/api/tmdb'; const MEDIA_ID = ${mediaId}; const MEDIA_TYPE = ${mediaType ? JSON.stringify(mediaType) : 'null'};
function escapeHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function cleanDescription(d) { return d ? d.replace(/<br\\s*\\/?>/gi,'\\n').replace(/<[^>]+>/g,'').trim() : ''; }
function posterUrl(p, size) { return p ? 'https://image.tmdb.org/t/p/' + (size || 'w342') + p : 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="300"%3E%3Crect fill="%23ece5d8" width="200" height="300"/%3E%3Ctext x="100" y="150" text-anchor="middle" fill="%235c5347" font-family="monospace" font-size="12"%3ENo Image%3C/text%3E%3C/svg%3E'; }
async function tmdb(path) { const resp = await fetch(TMDB_PROXY + path); if (!resp.ok) throw new Error('TMDB error ' + resp.status); return resp.json(); }
async function loadDetail() {
  const content = document.getElementById('content'); content.innerHTML = '<div class="loading">Loading…</div>';
  try {
    let type = MEDIA_TYPE, data;
    if (type) { data = await tmdb('/' + type + '/' + MEDIA_ID); }
    else {
      try { data = await tmdb('/movie/' + MEDIA_ID); type = 'movie'; } catch { data = await tmdb('/tv/' + MEDIA_ID); type = 'tv'; }
    }
    const title = data.title || data.name || 'Unknown';
    const score = data.vote_average ? data.vote_average.toFixed(1) : '—';
    const date = data.release_date || data.first_air_date || '';
    const year = date ? date.substring(0, 4) : '';
    const isTV = type === 'tv';
    const actionBtn = '<a href="/watch/' + type + '/' + data.id + '" class="btn">Watch Now</a>';
    let stats = '<div class="stat">' + (isTV ? 'TV Series' : 'Film') + '</div>';
    if (isTV && data.number_of_seasons) stats += '<div class="stat">' + data.number_of_seasons + ' Season' + (data.number_of_seasons > 1 ? 's' : '') + '</div>';
    if (isTV && data.number_of_episodes) stats += '<div class="stat">' + data.number_of_episodes + ' Episodes</div>';
    if (!isTV && data.runtime) stats += '<div class="stat">' + data.runtime + ' min</div>';
    if (data.status) stats += '<div class="stat">' + data.status + '</div>';
    if (year) stats += '<div class="stat">' + year + '</div>';
    let genres = ''; if (data.genres && data.genres.length) genres = '<div class="genres">' + data.genres.map(g => g.name).join(' · ') + '</div>';
    let studio = ''; if (data.production_companies && data.production_companies.length) { studio = '<div class="studio">Studio: ' + data.production_companies.map(s => s.name).join(', ') + '</div>'; }
    content.innerHTML = \`<a href="/" class="back-link">← Back to Index</a><div class="record-id">Record #\${data.id} · \${isTV ? 'TV' : 'Film'}</div><div class="hero"><img src="\${posterUrl(data.poster_path, 'w500')}" alt="\${escapeHtml(title)}"><div class="hero-info"><h1>\${escapeHtml(title)}</h1>\${data.tagline ? '<div class="native">' + escapeHtml(data.tagline) + '</div>' : ''}<div class="stat-row"><div class="stat score">\${score} / 10</div>\${stats}</div>\${genres}\${studio}<div class="action-row">\${actionBtn}</div></div></div><div class="section-label">Synopsis</div><div class="description">\${cleanDescription(data.overview)}</div>\`;
  } catch (e) { content.innerHTML = '<div class="error">Error: ' + escapeHtml(e.message) + '</div>'; }
}
function onAuthenticated() { loadDetail(); }
</script></body></html>`;
}

// ── Watch page (VIDEASY iframe embed, no proxy) ─────────────────────────────
function watchPage(pk, cu, mediaType, mediaId) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>The Ledger — Watch #${mediaType}/${mediaId}</title>
${clerkHead(pk, cu)}
<style>${commonCSS()}
.player-wrap { position:relative; width:100%; aspect-ratio:16/9; background:#1a1814; border:1px solid var(--ink); margin-bottom:20px; }
.player-wrap iframe { width:100%; height:100%; border:none; display:block; }
.player-overlay { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(26,24,20,.92); z-index:10; transition:opacity .3s; }
.player-overlay.hidden { opacity:0; pointer-events:none; }
.spinner { width:40px; height:40px; border:3px solid var(--rule); border-top-color:var(--accent); border-radius:50%; animation:spin .8s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
.watch-layout { display:grid; grid-template-columns:1fr 300px; gap:24px; }
@media(max-width:900px) { .watch-layout { grid-template-columns:1fr; } }
.watch-main { min-width:0; } .watch-sidebar { display:flex; flex-direction:column; gap:16px; }
.watch-card { border:1px solid var(--rule); background:var(--paper-dim); padding:14px; }
.watch-card h3 { font-family:'Courier New',monospace; font-size:0.72rem; letter-spacing:1.5px; text-transform:uppercase; color:var(--accent); border-bottom:1px solid var(--rule); padding-bottom:6px; margin-bottom:10px; }
.season-select { width:100%; padding:8px; border:1px solid var(--ink); background:var(--paper); font-family:inherit; font-size:0.85rem; margin-bottom:10px; }
.ep-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(36px,1fr)); gap:4px; max-height:300px; overflow-y:auto; }
.ep-grid::-webkit-scrollbar { width:5px; } .ep-grid::-webkit-scrollbar-track { background:var(--paper-dim); } .ep-grid::-webkit-scrollbar-thumb { background:var(--rule); }
.ep-btn { padding:6px 2px; border:1px solid var(--rule); background:var(--paper); font-family:'Courier New',monospace; font-size:0.72rem; font-weight:bold; text-align:center; cursor:pointer; color:var(--ink); }
.ep-btn:hover { border-color:var(--accent); background:var(--accent-soft); } .ep-btn.active { background:var(--accent); color:var(--paper); border-color:var(--accent); }
.now-playing { font-size:0.85rem; line-height:1.6; color:var(--ink-soft); } .now-playing strong { color:var(--ink); }
.watch-info { margin-bottom:16px; } .watch-info h1 { font-size:1.6rem; font-weight:400; margin-bottom:4px; } .watch-info .meta { font-family:'Courier New',monospace; font-size:0.72rem; letter-spacing:1px; text-transform:uppercase; color:var(--ink-soft); display:flex; flex-wrap:wrap; gap:12px; } .watch-info .meta .badge { border:1px solid var(--accent); color:var(--accent); padding:1px 8px; }
.progress-bar { height:6px; background:var(--paper-dim); border:1px solid var(--rule); border-radius:3px; overflow:hidden; margin-top:8px; }
.progress-fill { height:100%; background:var(--accent); width:0%; transition:width .3s; }
.progress-text { font-family:'Courier New',monospace; font-size:0.68rem; color:var(--ink-soft); margin-top:4px; }
</style></head><body>
<header><div><h1>The Ledger</h1><div class="tagline">Watch · ${mediaType === 'tv' ? 'TV' : 'Film'} #${mediaId}</div></div><div id="header-right"><span class="loading">Loading…</span></div></header>
<div class="auth-gate" id="auth-gate"><h1>Sign in required</h1><p>Sign in to watch.</p><div class="auth-buttons"><button class="btn" id="gate-signin">Sign In</button><button class="btn" id="gate-signup">Sign Up</button></div></div>
<div class="app" id="app"><main><a href="/detail/${mediaType}/${mediaId}" class="back-link">← Back to Details</a><div class="watch-layout"><div class="watch-main">
<div class="player-wrap" id="playerWrap"><div class="player-overlay" id="overlay"><div class="spinner"></div></div><iframe id="playerFrame" allow="fullscreen;autoplay;encrypted-media;picture-in-picture" allowfullscreen></iframe></div>
<div class="watch-info" id="watchInfo" style="display:none;"><h1 id="epTitle">—</h1><div class="meta"><span>Type: <span id="typeLabel">—</span></span><span>TMDB #<span id="tmdbIdLabel">—</span></span><span class="badge">VIDEASY</span></div><div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div><div class="progress-text" id="progressText">—</div></div>
<div class="error" id="errBox" style="display:none;"></div></div><div class="watch-sidebar">
<div class="watch-card" id="seasonCard" style="display:none;"><h3>Seasons &amp; Episodes</h3><select class="season-select" id="seasonSelect"></select><div class="ep-grid" id="epGrid"></div></div>
<div class="watch-card" id="nowCard" style="display:none;"><h3>Now Playing</h3><div class="now-playing" id="nowInfo"></div></div></div></div></main></div>
<script>
${commonAuthJS()}
const TMDB_PROXY = '/api/tmdb'; const MEDIA_TYPE = ${JSON.stringify(mediaType)}; const MEDIA_ID = ${mediaId};
const VIDEASY_BASE = 'https://player.videasy.net';
let tmdbData = null, seasonsData = [], currentSeason = 1, currentEpNum = null;
const overlay = document.getElementById('overlay');
const playerFrame = document.getElementById('playerFrame');
function escapeHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function showOverlay(show) { overlay.classList.toggle('hidden', !show); }
function showError(msg) { const box = document.getElementById('errBox'); box.textContent = msg; box.style.display = 'block'; }
function hideError() { document.getElementById('errBox').style.display = 'none'; }
async function tmdb(path) { const r = await fetch(TMDB_PROXY + path); if (!r.ok) throw new Error('TMDB ' + r.status); return r.json(); }

// Build VIDEASY embed URL (direct, no proxy)
function buildEmbedUrl(type, id, season, episode) {
  let embedPath;
  if (type === 'tv') { embedPath = '/tv/' + id + '/' + season + '/' + episode; }
  else { embedPath = '/movie/' + id; }
  const params = 'color=a63d2f' + (type === 'tv' ? '&nextEpisode=true&episodeSelector=true&autoplayNextEpisode=true&overlay=true' : '&overlay=true');
  return VIDEASY_BASE + embedPath + '?' + params;
}

// Load the iframe player
function loadPlayer(type, id, season, episode) {
  showOverlay(true); hideError();
  const src = buildEmbedUrl(type, id, season, episode);
  playerFrame.src = src;
  // Hide overlay once iframe loads
  playerFrame.onload = () => { showOverlay(false); };
  // Update info
  document.getElementById('watchInfo').style.display = 'block';
  document.getElementById('typeLabel').textContent = type === 'tv' ? 'TV' : 'Film';
  document.getElementById('tmdbIdLabel').textContent = id;
  if (type === 'tv' && episode != null) {
    document.getElementById('epTitle').textContent = 'S' + String(season).padStart(2,'0') + 'E' + String(episode).padStart(2,'0');
  } else {
    document.getElementById('epTitle').textContent = tmdbData ? (tmdbData.title || tmdbData.name || 'Now Playing') : 'Now Playing';
  }
  // Update now-playing card
  document.getElementById('nowCard').style.display = 'block';
  const info = document.getElementById('nowInfo');
  let html = '<div><strong>' + escapeHtml(document.getElementById('epTitle').textContent) + '</strong></div>';
  if (tmdbData) { html += '<div>' + escapeHtml(tmdbData.title || tmdbData.name || '') + '</div>'; }
  html += '<div style="margin-top:4px;">Source: <strong>VIDEASY</strong></div>';
  info.innerHTML = html;
}

// Listen for progress events from the VIDEASY iframe
window.addEventListener('message', function(event) {
  if (typeof event.data !== 'string') return;
  try {
    const msg = JSON.parse(event.data);
    // VIDEASY sends: { id, type, progress, timestamp, duration, season, episode }
    if (msg.progress != null) {
      const pct = Math.min(100, Math.max(0, msg.progress));
      document.getElementById('progressFill').style.width = pct + '%';
      const curTime = msg.timestamp != null ? formatTime(msg.timestamp) : '—';
      const dur = msg.duration != null ? formatTime(msg.duration) : '—';
      document.getElementById('progressText').textContent = curTime + ' / ' + dur + ' (' + pct.toFixed(1) + '%)';
    }
    // Save progress to localStorage
    if (msg.id && msg.timestamp != null) {
      const key = 'ledger-progress-' + MEDIA_TYPE + '-' + MEDIA_ID + (MEDIA_TYPE === 'tv' ? '-' + currentSeason + '-' + currentEpNum : '');
      try { localStorage.setItem(key, JSON.stringify({ currentTime: msg.timestamp, duration: msg.duration, progress: msg.progress, timestamp: Date.now() })); } catch {}
    }
  } catch {}
});

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
  return m + ':' + String(s).padStart(2,'0');
}

async function fetchTitle() {
  try { tmdbData = await tmdb('/' + MEDIA_TYPE + '/' + MEDIA_ID); const t = tmdbData.title || tmdbData.name || 'Watch'; document.title = 'The Ledger — ' + t; }
  catch {}
}

async function fetchSeasons() {
  if (MEDIA_TYPE !== 'tv' || !tmdbData) return;
  const card = document.getElementById('seasonCard');
  const sel = document.getElementById('seasonSelect');
  const seasons = (tmdbData.seasons || []).filter(s => s.season_number > 0 || (s.season_number === 0 && s.episode_count > 0));
  if (!seasons.length) return;
  card.style.display = 'block';
  sel.innerHTML = seasons.map(s => '<option value="' + s.season_number + '">' + escapeHtml(s.name || 'Season ' + s.season_number) + ' (' + s.episode_count + ' ep)</option>').join('');
  seasonsData = seasons;
  sel.addEventListener('change', () => { currentSeason = parseInt(sel.value); loadEpisodes(currentSeason); });
  currentSeason = seasons[0].season_number;
  loadEpisodes(currentSeason);
}

async function loadEpisodes(seasonNum) {
  const grid = document.getElementById('epGrid'); grid.innerHTML = '<div style="font-family:Courier New,monospace;font-size:0.72rem;color:var(--ink-soft);padding:10px;">Loading…</div>';
  try {
    const data = await tmdb('/tv/' + MEDIA_ID + '/season/' + seasonNum);
    const eps = data.episodes || [];
    if (!eps.length) { grid.innerHTML = '<div style="font-family:Courier New,monospace;font-size:0.72rem;color:var(--ink-soft);padding:10px;">No episodes.</div>'; return; }
    grid.innerHTML = '';
    eps.forEach(ep => {
      const btn = document.createElement('button');
      btn.className = 'ep-btn' + (currentEpNum === ep.episode_number ? ' active' : '');
      btn.textContent = ep.episode_number;
      btn.title = ep.name || 'Episode ' + ep.episode_number;
      btn.addEventListener('click', () => {
        currentEpNum = ep.episode_number;
        document.querySelectorAll('.ep-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        loadPlayer(MEDIA_TYPE, MEDIA_ID, currentSeason, ep.episode_number);
      });
      grid.appendChild(btn);
    });
  } catch (e) { grid.innerHTML = '<div style="font-family:Courier New,monospace;font-size:0.72rem;color:var(--accent);padding:10px;">Error: ' + escapeHtml(e.message) + '</div>'; }
}

async function onAuthenticated() {
  await fetchTitle();
  if (MEDIA_TYPE === 'tv') {
    await fetchSeasons();
    // Auto-load first episode of first season
    if (seasonsData.length) {
      try {
        const data = await tmdb('/tv/' + MEDIA_ID + '/season/' + currentSeason);
        const eps = data.episodes || [];
        if (eps.length) {
          currentEpNum = eps[0].episode_number;
          document.querySelectorAll('.ep-btn').forEach(b => { if (b.textContent == String(currentEpNum)) b.classList.add('active'); });
          loadPlayer(MEDIA_TYPE, MEDIA_ID, currentSeason, currentEpNum);
        } else { showOverlay(false); }
      } catch { showOverlay(false); }
    } else { showOverlay(false); }
  } else {
    // Movie: load immediately
    loadPlayer(MEDIA_TYPE, MEDIA_ID, null, null);
  }
}
</script></body></html>`;
}
