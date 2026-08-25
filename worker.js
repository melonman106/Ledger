export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const pk = env.CLERK_PUBLISHABLE_KEY || '';
    const cu = env.CLERK_FRONTEND_API_URL || '';
    const anivexaApi = env.ANIVEXA_API_URL || 'https://anivexa-api-gubc.onrender.com';
    const streamProxy = env.STREAM_PROXY_URL || 'https://stream-proxy.muldera.workers.dev/?url=';
    const parts = path.split('/').filter(Boolean);
    let anilistId = null;
    if (parts.length >= 2 && ['detail', 'watch', 'read'].includes(parts[0])) { anilistId = parts[1]; }
    if (parts[0] === 'api' && parts[1] === 'progress') { return handleProgress(request, env, parts); }
    if (parts[0] === 'api') { return handleApiProxy(request, anivexaApi); }
    if (parts[0] === 'md') { return handleMangaDexProxy(request); }
    let html;
    if (path === '/' || path === '/index.html') { html = indexPage(pk, cu); }
    else if (parts[0] === 'detail' && anilistId && /^\d+$/.test(anilistId)) { html = detailPage(pk, cu, anilistId); }
    else if (parts[0] === 'watch' && anilistId && /^\d+$/.test(anilistId)) { html = watchPage(pk, cu, anilistId, anivexaApi, streamProxy); }
    else if (parts[0] === 'read' && anilistId && /^\d+$/.test(anilistId)) { html = readPage(pk, cu, anilistId, anivexaApi, streamProxy); }
    else { return new Response(notFoundPage(pk, cu), { status: 404, headers: { 'Content-Type': 'text/html; charset=UTF-8' } }); }
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
  }
};
const CORS_JSON = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
async function handleProgress(request, env, parts) {
  // Binding variable name may be "DB" or the literal "ledger-db" depending on how it was added in the dashboard.
  const db = env.DB || env['ledger-db'] || env['ledger_db'];
  if (!db) { return new Response(JSON.stringify({ error: 'D1 binding not found. Expected a binding named DB or ledger-db.' }), { status: 500, headers: CORS_JSON }); }
  const url = new URL(request.url);
  try {
    if (request.method === 'GET') {
      const userId = url.searchParams.get('user');
      const id = url.searchParams.get('id');
      if (!userId) return new Response(JSON.stringify({ error: 'user required' }), { status: 400, headers: CORS_JSON });
      if (id) {
        const row = await db.prepare('SELECT * FROM watch_progress WHERE user_id = ? AND anilist_id = ?').bind(userId, id).first();
        return new Response(JSON.stringify({ item: row || null }), { headers: CORS_JSON });
      }
      const { results } = await db.prepare('SELECT * FROM watch_progress WHERE user_id = ? ORDER BY updated_at DESC LIMIT 20').bind(userId).all();
      return new Response(JSON.stringify({ items: results || [] }), { headers: CORS_JSON });
    }
    if (request.method === 'POST') {
      const body = await request.json();
      const { userId, anilistId, type, title, coverImage, episodeOrChapter, positionSeconds, durationSeconds, pageIndex } = body || {};
      if (!userId || !anilistId || !type || !title) return new Response(JSON.stringify({ error: 'missing fields' }), { status: 400, headers: CORS_JSON });
      await db.prepare(`INSERT INTO watch_progress (user_id, anilist_id, type, title, cover_image, episode_or_chapter, position_seconds, duration_seconds, page_index, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(user_id, anilist_id) DO UPDATE SET type=excluded.type, title=excluded.title, cover_image=excluded.cover_image,
        episode_or_chapter=excluded.episode_or_chapter, position_seconds=excluded.position_seconds, duration_seconds=excluded.duration_seconds,
        page_index=excluded.page_index, updated_at=excluded.updated_at`)
        .bind(userId, anilistId, type, title, coverImage || null, episodeOrChapter || null, positionSeconds ?? null, durationSeconds ?? null, pageIndex ?? null, Date.now())
        .run();
      return new Response(JSON.stringify({ ok: true }), { headers: CORS_JSON });
    }
    if (request.method === 'DELETE') {
      const anilistId = parts[2];
      const userId = url.searchParams.get('user');
      if (!userId || !anilistId) return new Response(JSON.stringify({ error: 'missing fields' }), { status: 400, headers: CORS_JSON });
      await db.prepare('DELETE FROM watch_progress WHERE user_id = ? AND anilist_id = ?').bind(userId, anilistId).run();
      return new Response(JSON.stringify({ ok: true }), { headers: CORS_JSON });
    }
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: CORS_JSON });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'progress error: ' + err.message }), { status: 500, headers: CORS_JSON });
  }
}
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
  return `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet"><script async crossorigin="anonymous" data-clerk-publishable-key="${pk}" type="text/javascript" src="${cu}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script>`;
}
function themeInitScript() {
  return `<script>(function(){try{var t=localStorage.getItem('ledger-theme');if(t==='dark'){document.documentElement.setAttribute('data-theme','dark');}}catch(e){}})();</script>`;
}
function siteMeta(description) {
  const desc = description || 'Stream anime and read manga from one fast, ad-free index.';
  const favicon = "https://f.playcode.io/p-2672631/v-1/01a01c84-3719-76e8-a432-c61309fd7732/icon.png' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23142030'/%3E%3Cpath d='M9 7h10l5 5v13a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z' fill='none' stroke='%2326a3d6' stroke-width='2'/%3E%3Cpath d='M19 7v5h5' fill='none' stroke='%2326a3d6' stroke-width='2'/%3E%3C/svg%3E";
  return `<link rel="icon" type="image/svg+xml" href="${favicon}"><meta name="theme-color" content="#142030"><meta name="description" content="${desc}"><meta property="og:title" content="The Ledger"><meta property="og:description" content="${desc}"><meta property="og:type" content="website"><meta property="og:image" content="${favicon}">`;
}
function icon(name) {
  const icons = {
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>',
    back10: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
    fwd10: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>',
    volume: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
    mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M16 9l5 6M21 9l-5 6"/></svg>',
    fullscreen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 19h16"/></svg>',
    captions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M8 12h2M8 15h5M14 12h2"/></svg>',
    chevronLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
    chevronRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };
  return icons[name] || '';
}
function commonCSS() {
  return `:root { --paper:#142030; --paper-dim:#1b2c42; --ink:#e9eef5; --ink-soft:#8b9bb5; --rule:#25344a; --accent:#26a3d6; --accent-soft:#1d6183; --ease:cubic-bezier(0.32,0.72,0,1); }
:root[data-theme="dark"] { --paper:#0b131d; --paper-dim:#111d2b; --ink:#e9eef5; --ink-soft:#728196; --rule:#1c2836; --accent:#26a3d6; --accent-soft:#1d6183; }
* { box-sizing:border-box; margin:0; padding:0; }
body { background:var(--paper); color:var(--ink); font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif; padding-bottom:80px; transition:background .35s var(--ease), color .35s var(--ease); }
:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
header { border-bottom:1px solid var(--rule); padding:14px 32px; max-width:2200px; margin:0 auto; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:16px; }
.header-left { display:flex; align-items:center; gap:22px; flex-wrap:wrap; flex:1; min-width:0; }
.header-brand { flex-shrink:0; }
header h1 { font-size:1.4rem; font-weight:800; letter-spacing:-0.3px; }
header .tagline { font-family:inherit; font-weight:600; font-size:0.66rem; letter-spacing:1px; text-transform:uppercase; color:var(--ink-soft); }
.header-controls { display:flex; align-items:center; gap:8px; }
.header-search { position:relative; flex:1; max-width:380px; min-width:160px; }
.header-search .search-icon { position:absolute; left:11px; top:50%; transform:translateY(-50%); width:14px; height:14px; color:var(--ink-soft); pointer-events:none; }
.header-search .search-icon svg { width:100%; height:100%; }
.header-search input { width:100%; padding:10px 14px 10px 34px; border:1px solid var(--rule); background:var(--paper-dim); font-family:inherit; font-weight:500; font-size:0.85rem; color:var(--ink); border-radius:20px; transition:border-color .2s var(--ease); }
.header-search input:focus { outline:none; border-color:var(--accent); }
.header-search input::placeholder { color:var(--ink-soft); }
.search-suggest { display:none; position:absolute; top:calc(100% + 8px); left:0; right:0; background:var(--paper-dim); border:1px solid var(--rule); border-radius:10px; box-shadow:0 16px 34px -12px rgba(6,10,18,.6); z-index:60; max-height:420px; overflow-y:auto; }
.search-suggest.open { display:block; }
.search-suggest-item { display:flex; align-items:center; gap:10px; padding:8px 10px; cursor:pointer; text-decoration:none; color:inherit; border-bottom:1px solid var(--rule); }
.search-suggest-item:last-child { border-bottom:none; }
.search-suggest-item:hover, .search-suggest-item.active { background:var(--accent-soft); }
.search-suggest-item img { width:32px; height:44px; object-fit:cover; border:1px solid var(--rule); flex-shrink:0; }
.search-suggest-item .ssi-title { font-size:0.82rem; line-height:1.25; }
.search-suggest-item .ssi-meta { font-family:inherit; font-weight:600; font-size:0.62rem; color:var(--ink-soft); text-transform:uppercase; margin-top:2px; }
.search-suggest-empty { padding:14px; font-family:inherit; font-weight:600; font-size:0.7rem; color:var(--ink-soft); text-transform:uppercase; text-align:center; }
.search-suggest-footer { padding:8px 10px; font-family:inherit; font-weight:600; font-size:0.62rem; color:var(--ink-soft); text-transform:uppercase; border-top:1px solid var(--rule); }
.user-name { font-family:inherit; font-weight:600; font-size:0.75rem; letter-spacing:1px; }
.btn { padding:10px 22px; border-radius:8px; border:none; background:var(--accent); color:#fff; font-family:inherit; font-weight:700; font-size:0.85rem; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; gap:8px; transition:background .25s var(--ease), transform .2s var(--ease); }
.btn svg { width:16px; height:16px; }
.btn:hover { background:var(--accent-soft); transform:translateY(-2px); }
.btn:active { transform:scale(0.97); }
.auth-gate { display:none; flex-direction:column; align-items:center; justify-content:center; min-height:70vh; gap:20px; padding:40px; text-align:center; }
.auth-gate h1 { font-size:1.8rem; font-weight:400; }
.auth-gate p { color:var(--ink-soft); max-width:400px; }
.auth-buttons { display:flex; gap:12px; }
.app { display:none; }
.app.active { display:block; }
/* profile dropdown */
.profile-wrap { position:relative; display:flex; align-items:center; gap:8px; }
.theme-toggle { width:34px; height:34px; border:none; background:var(--paper-dim); color:var(--ink-soft); cursor:pointer; display:flex; align-items:center; justify-content:center; border-radius:8px; transition:background .25s var(--ease), color .2s var(--ease), transform .2s var(--ease); }
.theme-toggle:hover { background:var(--rule); color:var(--ink); }
.theme-toggle:active { transform:scale(0.92); }
.theme-toggle svg { width:16px; height:16px; }
.profile-pill { display:flex; align-items:center; gap:8px; border:none; border-radius:8px; padding:5px 12px 5px 5px; background:var(--paper-dim); cursor:pointer; font-family:inherit; font-weight:600; transition:background .25s var(--ease); }
.profile-pill:hover { background:var(--rule); }
.profile-avatar { width:26px; height:26px; border-radius:50%; background:var(--accent); color:#fff; display:flex; align-items:center; justify-content:center; font-size:0.68rem; font-weight:bold; overflow:hidden; flex-shrink:0; }
.profile-avatar img { width:100%; height:100%; object-fit:cover; }
.profile-menu { display:none; position:absolute; top:calc(100% + 8px); right:0; min-width:180px; background:var(--paper-dim); border:1px solid var(--rule); border-radius:10px; box-shadow:0 14px 30px -10px rgba(6,10,18,.55); z-index:50; overflow:hidden; }
.profile-menu.open { display:block; }
.profile-menu button { display:flex; align-items:center; gap:8px; width:100%; text-align:left; padding:9px 12px; background:none; border:none; border-bottom:1px solid var(--rule); font-family:inherit; font-weight:600; font-size:0.7rem; letter-spacing:0.5px; text-transform:uppercase; color:var(--ink); cursor:pointer; }
.profile-menu button:last-child { border-bottom:none; color:var(--accent); }
.profile-menu button:hover { background:var(--accent-soft); }
.profile-menu svg { width:13px; height:13px; flex-shrink:0; }
nav.sections { display:flex; flex-wrap:wrap; gap:2px; }
nav.sections button { flex:none; padding:8px 14px; background:none; border:none; font-family:inherit; font-weight:600; font-size:0.78rem; color:var(--ink-soft); cursor:pointer; border-radius:6px; white-space:nowrap; transition:color .2s var(--ease), background .2s var(--ease); }
nav.sections button:hover { color:var(--ink); background:var(--paper-dim); }
nav.sections button.active { background:var(--accent); color:#fff; }
.filters { display:none; max-width:2200px; margin:16px auto 0; padding:0 32px; gap:10px; align-items:center; }
.filters.visible { display:flex; }
.filters select { padding:10px 14px; border:1px solid var(--rule); background:var(--paper-dim); border-radius:8px; font-family:inherit; font-size:0.85rem; color:var(--ink); }
main { max-width:2200px; margin:16px auto 0; padding:0 32px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(190px,1fr)); gap:20px; }
.entry { padding:0; cursor:pointer; text-decoration:none; color:inherit; display:block; transition:transform .3s var(--ease); }
.entry:hover { transform:translateY(-4px); background:none; }
.entry img { width:100%; aspect-ratio:2/3; object-fit:cover; border-radius:8px; transition:box-shadow .3s var(--ease); }
.entry:hover img { box-shadow:0 16px 32px -10px rgba(6,10,18,.65); }
.entry .num { font-family:inherit; font-weight:600; font-size:0.68rem; color:var(--accent); margin-top:8px; }
.entry .name { font-size:0.92rem; line-height:1.3; margin-top:2px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; min-height:2.4em; }
.entry .meta { font-family:inherit; font-weight:600; font-size:0.68rem; color:var(--ink-soft); margin-top:5px; text-transform:uppercase; }
.entry .score { color:var(--accent); font-weight:bold; }
/* hero slideshow */
.hero-carousel { position:relative; width:100%; aspect-ratio:21/8; min-height:280px; max-height:480px; border-radius:12px; overflow:hidden; margin-bottom:24px; background:var(--paper-dim); }
.hero-slide { position:absolute; inset:0; opacity:0; pointer-events:none; transition:opacity .7s var(--ease); cursor:pointer; }
.hero-slide.active { opacity:1; pointer-events:auto; }
.hero-slide-bg { position:absolute; inset:0; background-size:cover; background-position:center 20%; transform:scale(1.02); }
.hero-slide-scrim { position:absolute; inset:0; background:linear-gradient(90deg, var(--paper) 0%, rgba(20,32,48,.75) 38%, rgba(20,32,48,.15) 68%, transparent 100%); }
.hero-slide-content { position:relative; height:100%; display:flex; flex-direction:column; justify-content:center; gap:14px; padding:40px 5% 56px; max-width:640px; }
.hero-badges { display:flex; gap:8px; flex-wrap:wrap; }
.hero-badge { font-size:0.72rem; font-weight:700; letter-spacing:0.4px; text-transform:uppercase; background:rgba(255,255,255,.12); color:var(--ink); padding:4px 10px; border-radius:5px; }
.hero-badge-score { background:var(--accent); color:#fff; }
.hero-slide-content h2 { font-size:clamp(1.6rem, 3.2vw, 2.6rem); font-weight:800; line-height:1.1; letter-spacing:-0.5px; }
.hero-slide-content p { font-size:0.95rem; line-height:1.5; color:var(--ink-soft); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.hero-play-btn { width:fit-content; padding:12px 26px; font-size:0.9rem; }
.hero-dots { position:absolute; left:5%; bottom:20px; display:flex; gap:6px; z-index:2; }
.hero-dot { width:8px; height:8px; border-radius:50%; border:none; background:rgba(255,255,255,.35); cursor:pointer; padding:0; transition:background .25s var(--ease), width .25s var(--ease); }
.hero-dot.active { background:var(--accent); width:22px; border-radius:4px; }
/* rails */
.rail { margin-bottom:20px; }
.rail-head { display:flex; align-items:baseline; justify-content:space-between; margin-bottom:8px; padding-bottom:4px; border-bottom:1px solid var(--rule); }
.rail-head h2 { font-size:1.05rem; font-weight:400; }
.rail-arrows { display:flex; gap:4px; }
.rail-arrows button { width:26px; height:26px; border:none; border-radius:6px; background:var(--paper-dim); cursor:pointer; font-family:inherit; font-weight:600; color:var(--ink-soft); transition:background .2s var(--ease), color .2s var(--ease), transform .2s var(--ease); display:flex; align-items:center; justify-content:center; }
.rail-arrows button svg { width:13px; height:13px; }
.rail-arrows button:hover { background:var(--accent); color:#fff; }
.rail-arrows button:active { transform:scale(0.9); }
.rail-track { display:flex; gap:8px; overflow-x:auto; scroll-behavior:smooth; padding-bottom:4px; scrollbar-width:none; }
.rail-track::-webkit-scrollbar { display:none; }
.rail-card { flex:none; width:172px; text-decoration:none; color:inherit; cursor:pointer; position:relative; transition:transform .3s var(--ease); }
.rail-card:hover { transform:translateY(-4px); }
.rail-card img { width:100%; aspect-ratio:2/3; object-fit:cover; border-radius:8px; display:block; transition:box-shadow .3s var(--ease); }
.rail-card:hover img { box-shadow:0 16px 32px -10px rgba(6,10,18,.65); }
.rail-card .name { font-size:0.86rem; font-weight:600; margin-top:6px; line-height:1.25; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.rail-card .meta { font-weight:500; font-size:0.68rem; color:var(--ink-soft); margin-top:2px; text-transform:uppercase; letter-spacing:.4px; }
.rail-card .progress-bar { position:absolute; left:0; right:0; bottom:0; height:4px; background:rgba(0,0,0,.4); border-radius:0 0 8px 8px; overflow:hidden; }
.rail-card .progress-fill { height:100%; background:var(--accent); }
.rail-card .cw-remove { position:absolute; top:6px; right:6px; width:22px; height:22px; border:none; background:rgba(11,19,29,.8); color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; border-radius:5px; }
.rail-card .cw-remove svg { width:10px; height:10px; }
.rail-empty, .rail-error { font-family:inherit; font-weight:600; font-size:0.72rem; color:var(--ink-soft); text-transform:uppercase; padding:12px 0; }
/* skeletons */
@keyframes shimmer { 0% { background-position:-300px 0; } 100% { background-position:300px 0; } }
.skel { background:linear-gradient(90deg, var(--paper-dim) 25%, var(--rule) 37%, var(--paper-dim) 63%); background-size:600px 100%; animation:shimmer 1.4s infinite linear; }
.skel-card { flex:none; width:172px; }
.skel-card .skel-img { width:100%; aspect-ratio:2/3; border-radius:8px; }
.skel-card .skel-line { height:10px; margin-top:8px; width:90%; }
.skel-card .skel-line.short { width:55%; margin-top:5px; }
.skel-rail-track { display:flex; gap:12px; overflow:hidden; padding-bottom:6px; }
.skel-hero { display:flex; gap:32px; flex-wrap:wrap; margin-bottom:28px; }
.skel-hero .skel-cover { width:220px; aspect-ratio:2/3; border:1px solid var(--rule); flex-shrink:0; }
.skel-hero-info { flex:1; min-width:240px; }
.skel-hero-info .skel-line { height:26px; width:70%; margin-bottom:12px; }
.skel-hero-info .skel-line.sm { height:12px; width:40%; margin-bottom:20px; }
.skel-hero-info .skel-line.stat { height:28px; width:90px; display:inline-block; margin-right:8px; }
.skel-desc .skel-line { height:12px; width:100%; margin-bottom:8px; }
.record-id { font-family:inherit; font-weight:700; font-size:0.72rem; letter-spacing:1px; text-transform:uppercase; color:var(--accent); background:var(--paper-dim); border-radius:6px; display:inline-block; padding:5px 12px; margin-bottom:18px; }
.back-link { font-family:inherit; font-weight:600; font-size:0.78rem; color:var(--ink-soft); text-decoration:none; background:var(--paper-dim); border-radius:8px; padding:8px 16px; display:inline-block; margin-bottom:20px; transition:background .2s var(--ease), color .2s var(--ease); }
.back-link:hover { background:var(--rule); color:var(--ink); }
.hero { display:flex; gap:32px; flex-wrap:wrap; margin-bottom:28px; }
.hero img { width:220px; aspect-ratio:2/3; object-fit:cover; border-radius:10px; flex-shrink:0; }
.hero-info h1 { font-size:2rem; font-weight:400; line-height:1.2; margin-bottom:6px; }
.hero-info .native { color:var(--ink-soft); font-style:italic; margin-bottom:16px; }
.stat-row { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:18px; }
.stat { border:none; background:var(--paper-dim); padding:7px 14px; border-radius:6px; font-family:inherit; font-weight:600; font-size:0.78rem; }
.stat.score { background:var(--accent-soft); color:#fff; font-weight:bold; }
.genres, .studio { color:var(--ink-soft); font-size:0.9rem; margin-bottom:4px; }
.action-row { margin-top:18px; }
.section-label { font-family:inherit; font-weight:600; font-size:0.72rem; letter-spacing:2px; text-transform:uppercase; color:var(--accent); border-bottom:1px solid var(--rule); padding-bottom:8px; margin:32px 0 14px; }
.description { font-size:1rem; line-height:1.75; white-space:pre-line; }
.loading, .error, .empty { text-align:center; padding:70px 20px; font-family:inherit; font-weight:600; font-size:0.8rem; letter-spacing:1px; text-transform:uppercase; color:var(--ink-soft); }
.error { color:var(--accent); }
.placeholder { text-align:center; padding:100px 20px; }
.placeholder h2 { font-size:1.6rem; font-weight:400; margin-bottom:12px; }
.placeholder p { color:var(--ink-soft); font-family:inherit; font-weight:600; font-size:0.8rem; letter-spacing:1px; text-transform:uppercase; }
/* custom video player */
.player-wrap { position:relative; width:100%; aspect-ratio:16/9; background:#000; border-radius:10px; margin-bottom:20px; overflow:hidden; user-select:none; }
.player-wrap video, .player-wrap iframe { width:100%; height:100%; border:none; display:block; background:#000; }
.player-overlay { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(14,13,11,.85); z-index:10; transition:opacity .3s; pointer-events:none; }
.player-overlay.hidden { opacity:0; }
.spinner { width:40px; height:40px; border:3px solid rgba(255,255,255,.2); border-top-color:var(--accent); border-radius:50%; animation:spin .8s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
.skip-btn { position:absolute; bottom:64px; right:16px; background:var(--accent); color:#fff; border:none; padding:6px 14px; font-family:inherit; font-weight:600; font-size:0.72rem; letter-spacing:1px; text-transform:uppercase; cursor:pointer; z-index:15; opacity:0; transform:translateY(8px); transition:opacity .3s,transform .3s; }
.skip-btn.visible { opacity:1; transform:translateY(0); pointer-events:auto; }
.pc-bar { position:absolute; left:0; right:0; bottom:0; z-index:20; padding:6px 12px 10px; background:linear-gradient(to top, rgba(0,0,0,.85), rgba(0,0,0,0)); opacity:0; transition:opacity .25s; font-family:inherit; font-weight:600; }
.player-wrap.pc-show .pc-bar, .player-wrap:not(.pc-playing) .pc-bar { opacity:1; }
.pc-seek { position:relative; height:5px; background:rgba(255,255,255,.25); cursor:pointer; margin-bottom:8px; }
.pc-buffered { position:absolute; top:0; left:0; height:100%; background:rgba(255,255,255,.35); }
.pc-progress { position:absolute; top:0; left:0; height:100%; background:var(--accent); }
.pc-seek-handle { position:absolute; top:50%; width:11px; height:11px; border-radius:50%; background:var(--accent); transform:translate(-50%,-50%); }
.pc-row { display:flex; align-items:center; gap:10px; color:#fff; }
.pc-btn { background:none; border:none; color:#fff; cursor:pointer; padding:4px; display:flex; align-items:center; font-family:inherit; font-size:0.9rem; transition:color .2s var(--ease), transform .2s var(--ease); }
.pc-btn:hover { color:var(--accent-soft); }
.pc-btn:active { transform:scale(0.9); }
.pc-btn svg { width:18px; height:18px; display:block; }
.skip-btn svg { width:13px; height:13px; }
.skip-btn { display:flex; align-items:center; gap:6px; }
.pc-time { font-size:0.68rem; letter-spacing:0.5px; white-space:nowrap; }
.pc-vol { display:flex; align-items:center; gap:4px; }
.pc-vol input[type=range] { width:60px; accent-color:var(--accent); }
.pc-spacer { flex:1; }
.pc-menu-wrap { position:relative; }
.pc-menu { display:none; position:absolute; bottom:calc(100% + 8px); right:0; background:#1a1814; border:1px solid #333; min-width:110px; z-index:30; }
.pc-menu.open { display:block; }
.pc-menu button { display:block; width:100%; text-align:left; padding:7px 12px; background:none; border:none; color:#e8e2d4; font-family:inherit; font-weight:600; font-size:0.68rem; cursor:pointer; }
.pc-menu button.active { color:var(--accent); }
.pc-menu button:hover { background:#2a2620; }
.pc-menu-wide { min-width:230px; max-height:260px; overflow-y:auto; }
.pc-menu-empty { padding:12px; color:#8a8378; font-family:inherit; font-weight:600; font-size:0.66rem; text-transform:uppercase; }
.pc-menu-row { display:flex; justify-content:space-between; gap:10px; padding:8px 12px; font-family:inherit; font-weight:600; font-size:0.68rem; color:#e8e2d4; border-bottom:1px solid #2a2620; }
.pc-menu-row:last-child { border-bottom:none; }
.pc-menu-sub { color:#8a8378; }
a.pc-menu-link { text-decoration:none; cursor:pointer; }
a.pc-menu-link:hover { background:#2a2620; }
.pc-label { font-size:0.66rem; letter-spacing:1px; text-transform:uppercase; }`;
}
function commonAuthJS() {
  return `
const ICON_USER = ${JSON.stringify(icon('user'))};
const ICON_LOGOUT = ${JSON.stringify(icon('logout'))};
const ICON_SUN = ${JSON.stringify(icon('sun'))};
const ICON_MOON = ${JSON.stringify(icon('moon'))};
let clerkReady = false;
function doOpenSignIn() { if (window.Clerk) { try { Clerk.openSignIn(); } catch {} } }
function doOpenSignUp() { if (window.Clerk) { try { Clerk.openSignUp(); } catch {} } }
function currentTheme() { return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }
function applyThemeIcon() { const btn = document.getElementById('theme-toggle'); if (btn) btn.innerHTML = currentTheme() === 'dark' ? ICON_SUN : ICON_MOON; }
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  if (next === 'dark') document.documentElement.setAttribute('data-theme', 'dark'); else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('ledger-theme', next); } catch {}
  applyThemeIcon();
}
function attachGateButtons() {
  const si = document.getElementById('gate-signin');
  const su = document.getElementById('gate-signup');
  if (si) si.addEventListener('click', doOpenSignIn);
  if (su) su.addEventListener('click', doOpenSignUp);
  const tt = document.getElementById('theme-toggle');
  if (tt) { applyThemeIcon(); tt.addEventListener('click', toggleTheme); }
  const pill = document.getElementById('profile-pill');
  const menu = document.getElementById('profile-menu');
  if (pill && menu) {
    pill.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
    document.addEventListener('click', () => menu.classList.remove('open'));
    const soBtn2 = document.getElementById('menu-signout');
    if (soBtn2) soBtn2.addEventListener('click', () => { if (window.Clerk) Clerk.signOut(); });
    const profBtn = document.getElementById('menu-profile');
    if (profBtn) profBtn.addEventListener('click', () => { if (window.Clerk) { try { Clerk.openUserProfile(); } catch {} } });
  }
}
function initClerk() {
  if (clerkReady || !window.Clerk) return;
  clerkReady = true;
  Clerk.load().then(() => { onClerkState(); Clerk.addListener(() => onClerkState()); }).catch(() => {
    const headerRight = document.getElementById('header-right');
    if (headerRight) headerRight.innerHTML = '<span class="loading">Sign in to continue</span>';
  });
}
function initials(name) { return String(name || 'U').trim().split(/\\s+/).map(w => w[0]).join('').slice(0,2).toUpperCase(); }
function onClerkState() {
  const headerRight = document.getElementById('header-right');
  const authGate = document.getElementById('auth-gate');
  const app = document.getElementById('app');
  if (Clerk.user) {
    if (authGate) authGate.style.display = 'none';
    if (app) app.classList.add('active');
    if (headerRight) {
      const name = Clerk.user.username || Clerk.user.firstName || 'User';
      const img = Clerk.user.imageUrl;
      const avatarInner = img ? '<img src="' + img + '" alt="' + name + '">' : initials(name);
      headerRight.innerHTML = '<div class="profile-wrap"><button class="profile-pill" id="profile-pill"><span class="profile-avatar">' + avatarInner + '</span><span class="user-name">' + name + '</span></button><div class="profile-menu" id="profile-menu"><button id="menu-profile">' + ICON_USER + ' Profile</button><button id="menu-signout">' + ICON_LOGOUT + ' Sign Out</button></div></div>';
      const pill = document.getElementById('profile-pill');
      const menu = document.getElementById('profile-menu');
      pill.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
      document.addEventListener('click', () => menu.classList.remove('open'));
      document.getElementById('menu-signout').addEventListener('click', () => Clerk.signOut());
      document.getElementById('menu-profile').addEventListener('click', () => { try { Clerk.openUserProfile(); } catch {} });
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
function headerMarkup(tagline, withSearch) {
  const search = withSearch ? `<div class="header-search"><span class="search-icon">${icon('search')}</span><input type="text" id="header-search-input" placeholder="Search anime or manga..." autocomplete="off"><div class="search-suggest" id="search-suggest"></div></div>` : '';
  const nav = withSearch ? `<nav class="sections" id="nav-sections"><button class="active" data-mode="home">Home</button><button data-mode="random">Random Pull</button><button data-mode="seasonal">This Season</button><button data-mode="upcoming">On the Horizon</button><button data-mode="manga">Top Manga</button><button data-mode="search">Search Index</button></nav>` : '';
  return `<header><div class="header-left"><div class="header-brand"><h1>The Ledger</h1><div class="tagline">${tagline}</div></div>${search}${nav}</div><div class="header-controls"><button class="theme-toggle" id="theme-toggle" title="Toggle theme" aria-label="Toggle theme"></button><div id="header-right"><span class="loading">Loading…</span></div></div></header>`;
}
function skeletonRail(count) {
  let cards = '';
  for (let i = 0; i < count; i++) { cards += `<div class="skel-card"><div class="skel skel-img"></div><div class="skel skel-line"></div><div class="skel skel-line short"></div></div>`; }
  return `<div class="skel-rail-track">${cards}</div>`;
}
function notFoundPage(pk, cu) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">${themeInitScript()}
<title>The Ledger — Page not found</title>${siteMeta("The page you're looking for doesn't exist.")}
<link rel="icon" href="https://f.playcode.io/p-2672631/v-1/01a01c84-3719-76e8-a432-c61309fd7732/icon.png" type="image/png">
    <link rel="icon" href="./icon.png" type="image/png">
<style>${commonCSS()}
.nf-wrap { min-height:80vh; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:40px; gap:18px; }
.nf-code { font-size:5rem; font-weight:800; color:var(--accent); letter-spacing:-2px; line-height:1; }
.nf-wrap p { color:var(--ink-soft); max-width:420px; }
</style></head><body>
${headerMarkup('Page not found', false)}
<div class="nf-wrap"><div class="nf-code">404</div><h1 style="font-weight:700;">This record isn't in the index</h1><p>The page you're looking for doesn't exist or may have moved.</p><a href="/" class="btn">Back to Index</a></div>
<script>
const ICON_SUN_NF = ${JSON.stringify(icon('sun'))};
const ICON_MOON_NF = ${JSON.stringify(icon('moon'))};
function applyNfThemeIcon() { const btn = document.getElementById('theme-toggle'); if (btn) btn.innerHTML = document.documentElement.getAttribute('data-theme') === 'dark' ? ICON_SUN_NF : ICON_MOON_NF; }
applyNfThemeIcon();
document.getElementById('theme-toggle')?.addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) { document.documentElement.removeAttribute('data-theme'); try { localStorage.setItem('ledger-theme','light'); } catch {} }
  else { document.documentElement.setAttribute('data-theme','dark'); try { localStorage.setItem('ledger-theme','dark'); } catch {} }
  applyNfThemeIcon();
});
document.getElementById('header-right').innerHTML = '<a href="/" class="btn" style="padding:8px 16px;font-size:0.78rem;">Home</a>';
</script>
</body></html>`;
}
function indexPage(pk, cu) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">${themeInitScript()}
<title>The Ledger — Anime &amp; Manga Index</title>${siteMeta()}
<link rel="icon" href="https://f.playcode.io/p-2672631/v-1/01a01c84-3719-76e8-a432-c61309fd7732/icon.png" type="image/png">
    <link rel="icon" href="./icon.png" type="image/png">
${clerkHead(pk, cu)}<style>${commonCSS()}</style></head><body>
${headerMarkup('An Index of Anime &amp; Manga', true)}
<div class="auth-gate" id="auth-gate"><h1>Sign in required</h1><p>Sign in to browse the index — Top Ten, Popular, Seasonal, and Search.</p><div class="auth-buttons"><button class="btn" id="gate-signin">Sign In</button><button class="btn" id="gate-signup">Sign Up</button></div></div>
<div class="app" id="app">
<div class="filters" id="seasonal-filters"><select id="season-select"><option value="WINTER">Winter</option><option value="SPRING">Spring</option><option value="SUMMER">Summer</option><option value="FALL">Fall</option></select><select id="year-select"></select></div>
<main>
<div id="home-view">
  <div class="hero-carousel" id="heroCarousel"><div class="hero-slides" id="heroSlides"><div class="hero-slide active"><div class="hero-slide-bg skel" style="border-radius:0;"></div></div></div><div class="hero-dots" id="heroDots"></div></div>
  <div class="rail" id="rail-continue" style="display:none;"><div class="rail-head"><h2>Continue Watching &amp; Reading</h2><div class="rail-arrows"><button data-rail="continue" data-dir="-1">${icon('chevronLeft')}</button><button data-rail="continue" data-dir="1">${icon('chevronRight')}</button></div></div><div class="rail-track" id="track-continue">${skeletonRail(4)}</div></div>
  <div class="rail"><div class="rail-head"><h2>Top Ten Anime</h2><div class="rail-arrows"><button data-rail="top" data-dir="-1">${icon('chevronLeft')}</button><button data-rail="top" data-dir="1">${icon('chevronRight')}</button></div></div><div class="rail-track" id="track-top">${skeletonRail(6)}</div></div>
  <div class="rail"><div class="rail-head"><h2>This Season</h2><div class="rail-arrows"><button data-rail="seasonal" data-dir="-1">${icon('chevronLeft')}</button><button data-rail="seasonal" data-dir="1">${icon('chevronRight')}</button></div></div><div class="rail-track" id="track-seasonal">${skeletonRail(6)}</div></div>
  <div class="rail"><div class="rail-head"><h2>Top Manga</h2><div class="rail-arrows"><button data-rail="manga" data-dir="-1">${icon('chevronLeft')}</button><button data-rail="manga" data-dir="1">${icon('chevronRight')}</button></div></div><div class="rail-track" id="track-manga">${skeletonRail(6)}</div></div>
</div>
<div id="content" class="grid" style="display:none;"></div>
</main></div>
<script>
${commonAuthJS()}
const ANILIST_API = 'https://graphql.anilist.co';
const ICON_CLOSE = ${JSON.stringify(icon('close'))};
const ICON_PLAY = ${JSON.stringify(icon('play'))};
let content, navSections, seasonalFilters; let authInit = false;
window.aniListIds = window.aniListIds || {};
function registerAniListId(title, id) { const varName = String(title).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); window.aniListIds[varName] = id; return varName; }
function escapeHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function currentSeason() { const now = new Date(); const month = now.getMonth()+1; const year = now.getFullYear(); let season; if (month<=3) season='WINTER'; else if (month<=6) season='SPRING'; else if (month<=9) season='SUMMER'; else season='FALL'; return { season, year }; }
function nextSeason() { const { season, year } = currentSeason(); const order=['WINTER','SPRING','SUMMER','FALL']; const idx=order.indexOf(season); const nextIdx=(idx+1)%4; const nextYear = nextIdx===0 ? year+1 : year; return { season: order[nextIdx], year: nextYear }; }
const QUERIES = {
  top: \`query { Page(page:1, perPage:10) { media(type:ANIME, sort:SCORE_DESC) { id title{romaji english} coverImage{large} averageScore episodes format } } }\`,
  hero: \`query { Page(page:1, perPage:8) { media(type:ANIME, sort:POPULARITY_DESC) { id title{romaji english} coverImage{large extraLarge} bannerImage description averageScore episodes format status } } }\`,
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
function renderRailCard(item, index) {
  const title = item.title.english || item.title.romaji || 'Unknown';
  const score = item.averageScore ? (item.averageScore / 10).toFixed(1) : '—';
  const episodes = item.episodes ? item.episodes + ' ep' : item.chapters ? item.chapters + ' ch' : '';
  return \`<a class="rail-card entry" data-id="\${item.id}"><img src="\${item.coverImage.large}" alt="\${escapeHtml(title)}" loading="lazy"><div class="name">\${escapeHtml(title)}</div><div class="meta">\${episodes} · <span class="score">\${score}</span></div></a>\`;
}
async function loadRail(mode, trackId) {
  const track = document.getElementById(trackId);
  try {
    let data, media;
    if (mode === 'top') { data = await anilist(QUERIES.top); media = data.Page.media; }
    else if (mode === 'seasonal') { const { season, year } = currentSeason(); data = await anilist(QUERIES.seasonal, { season, year }); media = data.Page.media; }
    else if (mode === 'manga') { data = await anilist(QUERIES.topManga); media = data.Page.media; }
    track.innerHTML = media.map((item, i) => renderRailCard(item, i)).join('');
    media.forEach(item => { const title = item.title.english || item.title.romaji; registerAniListId(title, item.id); });
    track.querySelectorAll('.rail-card').forEach(el => { el.addEventListener('click', () => { window.location.href = '/detail/' + el.dataset.id; }); });
  } catch (e) { track.innerHTML = '<div class="rail-error">Error: ' + escapeHtml(e.message) + '</div>'; }
}
/* --- hero slideshow carousel --- */
let heroSlideIndex = 0, heroSlideTimer = null, heroMedia = [];
function cleanHeroDescription(d) { return d ? d.replace(/<br\\s*\\/?>/gi,' ').replace(/<[^>]+>/g,'').trim() : ''; }
async function loadHeroCarousel() {
  const slidesBox = document.getElementById('heroSlides'); const dotsBox = document.getElementById('heroDots');
  try {
    const data = await anilist(QUERIES.hero); heroMedia = data.Page.media.filter(m => m.bannerImage || m.coverImage.extraLarge);
    if (!heroMedia.length) { document.getElementById('heroCarousel').style.display = 'none'; return; }
    slidesBox.innerHTML = heroMedia.map((m, i) => {
      const title = m.title.english || m.title.romaji || 'Unknown';
      const bg = m.bannerImage || m.coverImage.extraLarge;
      const score = m.averageScore ? (m.averageScore / 10).toFixed(1) : null;
      const isManga = m.format === 'MANGA' || m.format === 'NOVEL' || m.format === 'ONE_SHOT';
      const desc = cleanHeroDescription(m.description).slice(0, 220);
      return \`<div class="hero-slide\${i === 0 ? ' active' : ''}" data-id="\${m.id}"><div class="hero-slide-bg" style="background-image:url('\${bg}')"></div><div class="hero-slide-scrim"></div><div class="hero-slide-content"><div class="hero-badges">\${m.format ? '<span class="hero-badge">' + m.format + '</span>' : ''}\${score ? '<span class="hero-badge hero-badge-score">★ ' + score + '</span>' : ''}\${m.status ? '<span class="hero-badge">' + m.status.replace(/_/g,' ') + '</span>' : ''}</div><h2>\${escapeHtml(title)}</h2><p>\${escapeHtml(desc)}\${desc.length >= 220 ? '…' : ''}</p><button class="btn hero-play-btn" data-id="\${m.id}" data-manga="\${isManga}">\${ICON_PLAY} \${isManga ? 'Read Now' : 'Play Now'}</button></div></div>\`;
    }).join('');
    dotsBox.innerHTML = heroMedia.map((_, i) => \`<button class="hero-dot\${i === 0 ? ' active' : ''}" data-idx="\${i}"></button>\`).join('');
    dotsBox.querySelectorAll('.hero-dot').forEach(dot => { dot.addEventListener('click', () => { goToHeroSlide(parseInt(dot.dataset.idx)); resetHeroTimer(); }); });
    slidesBox.querySelectorAll('.hero-play-btn').forEach(btn => { btn.addEventListener('click', (e) => { e.stopPropagation(); const id = btn.dataset.id; window.location.href = (btn.dataset.manga === 'true' ? '/read/' : '/watch/') + id; }); });
    slidesBox.querySelectorAll('.hero-slide').forEach(el => { el.addEventListener('click', () => { window.location.href = '/detail/' + el.dataset.id; }); });
    resetHeroTimer();
  } catch (e) { document.getElementById('heroCarousel').style.display = 'none'; }
}
function goToHeroSlide(idx) {
  heroSlideIndex = (idx + heroMedia.length) % heroMedia.length;
  document.querySelectorAll('.hero-slide').forEach((el, i) => el.classList.toggle('active', i === heroSlideIndex));
  document.querySelectorAll('.hero-dot').forEach((el, i) => el.classList.toggle('active', i === heroSlideIndex));
}
function resetHeroTimer() { clearInterval(heroSlideTimer); heroSlideTimer = setInterval(() => goToHeroSlide(heroSlideIndex + 1), 6500); }
document.addEventListener('mouseover', (e) => { if (e.target.closest('#heroCarousel')) clearInterval(heroSlideTimer); });
document.addEventListener('mouseout', (e) => { if (e.target.closest('#heroCarousel')) resetHeroTimer(); });
async function loadContinueRail() {
  const railBox = document.getElementById('rail-continue');
  const track = document.getElementById('track-continue');
  if (!window.Clerk || !Clerk.user) { railBox.style.display = 'none'; return; }
  try {
    const res = await fetch('/api/progress?user=' + encodeURIComponent(Clerk.user.id));
    const data = await res.json();
    const items = data.items || [];
    if (!items.length) { railBox.style.display = 'none'; return; }
    railBox.style.display = 'block';
    track.innerHTML = items.map(it => {
      const pct = (it.type === 'anime' && it.duration_seconds) ? Math.min(100, Math.round((it.position_seconds / it.duration_seconds) * 100)) : (it.page_index ? 40 : 0);
      const href = it.type === 'anime' ? '/watch/' + it.anilist_id : '/read/' + it.anilist_id;
      return \`<a class="rail-card entry" href="\${href}"><button class="cw-remove" data-remove="\${it.anilist_id}" title="Remove">\${ICON_CLOSE}</button><img src="\${it.cover_image || ''}" alt="\${escapeHtml(it.title)}" loading="lazy"><div class="name">\${escapeHtml(it.title)}</div><div class="meta">\${escapeHtml(it.episode_or_chapter || '')}</div><div class="progress-bar"><div class="progress-fill" style="width:\${pct}%"></div></div></a>\`;
    }).join('');
    track.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        const id = btn.dataset.remove;
        await fetch('/api/progress/' + id + '?user=' + encodeURIComponent(Clerk.user.id), { method: 'DELETE' });
        loadContinueRail();
      });
    });
  } catch (e) { railBox.style.display = 'none'; }
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-rail]');
  if (!btn) return;
  const track = document.getElementById('track-' + btn.dataset.rail);
  if (track) track.scrollBy({ left: parseInt(btn.dataset.dir) * 480, behavior: 'smooth' });
});
let currentMode = 'home';
async function loadMode(mode) {
  currentMode = mode;
  document.getElementById('home-view').style.display = mode === 'home' ? 'block' : 'none';
  content.style.display = mode === 'home' ? 'none' : 'grid';
  seasonalFilters.classList.toggle('visible', mode === 'seasonal' || mode === 'upcoming');
  navSections.querySelectorAll('button').forEach(b => { b.classList.toggle('active', b.dataset.mode === mode); });
  if (mode === 'home') return;
  content.innerHTML = '<div class="loading">Loading…</div>';
  try { let data;
    if (mode === 'random') { const page = Math.floor(Math.random() * 10) + 1; data = await anilist(QUERIES.randomPage, { page }); renderGrid(data.Page.media); }
    else if (mode === 'seasonal') { const season = document.getElementById('season-select').value; const year = parseInt(document.getElementById('year-select').value); data = await anilist(QUERIES.seasonal, { season, year }); renderGrid(data.Page.media); }
    else if (mode === 'upcoming') { const { season, year } = nextSeason(); data = await anilist(QUERIES.upcoming, { season, year }); renderGrid(data.Page.media); }
    else if (mode === 'manga') { data = await anilist(QUERIES.topManga); renderGrid(data.Page.media); }
    else if (mode === 'search') { content.innerHTML = '<div class="empty">Use the search box in the header, or type below and press Enter.</div>'; }
  } catch (e) { content.innerHTML = '<div class="error">Error: ' + escapeHtml(e.message) + '</div>'; }
}
async function doHeaderSearch(query) {
  navSections.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === 'search'));
  document.getElementById('home-view').style.display = 'none'; content.style.display = 'grid'; currentMode = 'search';
  content.innerHTML = '<div class="loading">Searching…</div>';
  try { const data = await anilist(QUERIES.search, { search: query, type: 'ANIME' }); renderGrid(data.Page.media); } catch (e) { content.innerHTML = '<div class="error">Error: ' + escapeHtml(e.message) + '</div>'; }
}
/* --- live search suggestions --- */
const SUGGEST_QUERY = \`query($search:String!) { Page(page:1, perPage:7) { media(search:$search, sort:SEARCH_MATCH) { id title{romaji english} coverImage{medium} format episodes chapters type } } }\`;
let suggestTimer = null, suggestActive = -1, suggestItems = [];
function closeSuggest() { const box = document.getElementById('search-suggest'); box.classList.remove('open'); box.innerHTML = ''; suggestActive = -1; suggestItems = []; }
function renderSuggest(media, query) {
  const box = document.getElementById('search-suggest');
  if (!media || !media.length) { box.innerHTML = '<div class="search-suggest-empty">No matches for "' + escapeHtml(query) + '"</div>'; box.classList.add('open'); suggestItems = []; return; }
  suggestItems = media;
  box.innerHTML = media.map((item, i) => {
    const title = item.title.english || item.title.romaji || 'Unknown';
    const meta = (item.type === 'MANGA' ? 'Manga' : 'Anime') + (item.episodes ? ' · ' + item.episodes + ' ep' : item.chapters ? ' · ' + item.chapters + ' ch' : '');
    return '<a class="search-suggest-item" data-idx="' + i + '" data-id="' + item.id + '"><img src="' + (item.coverImage.medium || '') + '" alt=""><div><div class="ssi-title">' + escapeHtml(title) + '</div><div class="ssi-meta">' + meta + '</div></div></a>';
  }).join('') + '<div class="search-suggest-footer">Enter for full results · Esc to close</div>';
  box.classList.add('open');
  box.querySelectorAll('.search-suggest-item').forEach(el => { el.addEventListener('click', () => { window.location.href = '/detail/' + el.dataset.id; }); });
}
function updateSuggestActive() {
  document.querySelectorAll('.search-suggest-item').forEach((el, i) => el.classList.toggle('active', i === suggestActive));
  const activeEl = document.querySelector('.search-suggest-item.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}
function wireSearchSuggest() {
  const input = document.getElementById('header-search-input');
  if (!input) return;
  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(suggestTimer);
    if (!q) { closeSuggest(); return; }
    suggestTimer = setTimeout(async () => {
      try { const data = await anilist(SUGGEST_QUERY, { search: q }); renderSuggest(data.Page.media, q); } catch { closeSuggest(); }
    }, 250);
  });
  input.addEventListener('keydown', (e) => {
    const box = document.getElementById('search-suggest');
    if (e.key === 'ArrowDown' && box.classList.contains('open')) { e.preventDefault(); suggestActive = Math.min(suggestItems.length - 1, suggestActive + 1); updateSuggestActive(); }
    else if (e.key === 'ArrowUp' && box.classList.contains('open')) { e.preventDefault(); suggestActive = Math.max(0, suggestActive - 1); updateSuggestActive(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (suggestActive >= 0 && suggestItems[suggestActive]) { window.location.href = '/detail/' + suggestItems[suggestActive].id; } else if (input.value.trim()) { closeSuggest(); doHeaderSearch(input.value.trim()); } }
    else if (e.key === 'Escape') { closeSuggest(); input.blur(); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.header-search')) closeSuggest(); });
}
function onAuthenticated() {
  if (authInit) return; authInit = true;
  content = document.getElementById('content'); navSections = document.getElementById('nav-sections'); seasonalFilters = document.getElementById('seasonal-filters');
  const { year } = currentSeason(); const yearSelect = document.getElementById('year-select');
  for (let y = year + 1; y >= year - 10; y--) { const opt = document.createElement('option'); opt.value = y; opt.textContent = y; if (y === year) opt.selected = true; yearSelect.appendChild(opt); }
  document.getElementById('season-select').value = currentSeason().season;
  navSections.querySelectorAll('button').forEach(btn => { btn.addEventListener('click', () => loadMode(btn.dataset.mode)); });
  document.getElementById('season-select').addEventListener('change', () => { if (currentMode === 'seasonal') loadMode('seasonal'); });
  document.getElementById('year-select').addEventListener('change', () => { if (currentMode === 'seasonal') loadMode('seasonal'); });
  loadRail('top', 'track-top'); loadRail('seasonal', 'track-seasonal'); loadRail('manga', 'track-manga');
  loadHeroCarousel();
  loadContinueRail();
  wireSearchSuggest();
  const params = new URLSearchParams(window.location.search);
  const q = params.get('q');
  if (q) { const hs = document.getElementById('header-search-input'); if (hs) hs.value = q; doHeaderSearch(q); }
}
const dl = document.getElementById('dateline');
if (dl) dl.textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
</script></body></html>`;
}
function skeletonHero() {
  return `<div class="skel-hero"><div class="skel skel-cover"></div><div class="skel-hero-info"><div class="skel skel-line"></div><div class="skel skel-line sm"></div><div><div class="skel skel-line stat"></div><div class="skel skel-line stat"></div><div class="skel skel-line stat"></div></div></div></div><div class="skel-desc"><div class="skel skel-line"></div><div class="skel skel-line"></div><div class="skel skel-line"></div><div class="skel skel-line" style="width:60%"></div></div>`;
}
function detailPage(pk, cu, anilistId) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">${themeInitScript()}
<title>The Ledger — Record #${anilistId}</title>${siteMeta("Details, episodes, and chapters for this title on The Ledger.")}
<link rel="icon" href="https://f.playcode.io/p-2672631/v-1/01a01c84-3719-76e8-a432-c61309fd7732/icon.png" type="image/png">
    <link rel="icon" href="./icon.png" type="image/png">
${clerkHead(pk, cu)}<style>${commonCSS()}</style></head><body>
${headerMarkup('Record #' + anilistId, false)}
<div class="auth-gate" id="auth-gate"><h1>Sign in required</h1><p>Sign in to view this record.</p><div class="auth-buttons"><button class="btn" id="gate-signin">Sign In</button><button class="btn" id="gate-signup">Sign Up</button></div></div>
<div class="app" id="app"><main><a href="/" class="back-link">← Back to Index</a><div id="content">${skeletonHero()}</div></main></div>
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
  const content = document.getElementById('content');
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
    content.innerHTML = \`<div class="record-id">Record #\${m.id}</div><div class="hero"><img src="\${m.coverImage.large}" alt="\${escapeHtml(title)}"><div class="hero-info"><h1>\${escapeHtml(title)}</h1>\${m.title.native ? '<div class="native">' + escapeHtml(m.title.native) + '</div>' : ''}<div class="stat-row"><div class="stat score">\${score} / 10</div>\${stats}</div>\${genres}\${studio}<div class="action-row">\${actionBtn}</div></div></div><div class="section-label">Synopsis</div><div class="description">\${cleanDescription(m.description)}</div>\`;
    if (!isManga) preloadEpisodes(m.id);
  } catch (e) { content.innerHTML = '<div class="error">Error: ' + escapeHtml(e.message) + '</div>'; }
}
function preloadEpisodes(id) {
  fetch('/api/episodes/anineko/' + id).then(r => r.ok ? r.json() : null).then(data => { if (data) { try { sessionStorage.setItem('ep_anineko_' + id, JSON.stringify({ data, ts: Date.now() })); } catch {} } }).catch(() => {});
}
function onAuthenticated() { loadDetail(); }
</script></body></html>`;
}
function skeletonEpGrid() {
  let btns = ''; for (let i = 0; i < 24; i++) btns += '<div class="skel" style="height:30px;"></div>';
  return `<div class="ep-grid">${btns}</div>`;
}
function watchPage(pk, cu, anilistId, anivexaApi, streamProxy) {
  const PROXY = streamProxy || 'https://stream-proxy.muldera.workers.dev/?url=';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">${themeInitScript()}
<title>The Ledger — Watch #${anilistId}</title>${siteMeta("Watch this anime on The Ledger.")}
<link rel="icon" href="https://f.playcode.io/p-2672631/v-1/01a01c84-3719-76e8-a432-c61309fd7732/icon.png" type="image/png">
    <link rel="icon" href="./icon.png" type="image/png">
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
function skeletonChapterList() {
  let rows = ''; for (let i = 0; i < 10; i++) rows += '<div class="skel" style="height:34px;margin-bottom:4px;"></div>';
  return rows;
}
function readPage(pk, cu, anilistId, anivexaApi, streamProxy) {
  const PROXY = streamProxy || 'https://stream-proxy.muldera.workers.dev/?url=';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">${themeInitScript()}
<link rel="icon" href="https://f.playcode.io/p-2672631/v-1/01a01c84-3719-76e8-a432-c61309fd7732/icon.png" type="image/png">
    <link rel="icon" href="./icon.png" type="image/png">
<title>The Ledger — Read #${anilistId}</title>${siteMeta("Read this manga on The Ledger.")}
${clerkHead(pk, cu)}<style>${commonCSS()}
.read-layout { display:grid; grid-template-columns:1fr 280px; gap:24px; }
@media(max-width:900px) { .read-layout { grid-template-columns:1fr; } }
.read-main { min-width:0; } .read-sidebar { display:flex; flex-direction:column; gap:16px; }
.read-card { border:none; border-radius:10px; background:var(--paper-dim); padding:16px; }
.read-card h3 { font-family:inherit; font-weight:600; font-size:0.72rem; letter-spacing:1.5px; text-transform:uppercase; color:var(--accent); border-bottom:1px solid var(--rule); padding-bottom:6px; margin-bottom:10px; }
.reader-viewer { background:#000; border-radius:10px; overflow:hidden; margin-bottom:16px; }
.reader-viewer img { display:block; width:100%; max-width:900px; margin:0 auto; }
.reader-nav { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:12px 0; border-top:1px solid var(--rule); border-bottom:1px solid var(--rule); margin-bottom:16px; }
.reader-nav button { padding:9px 18px; border:none; border-radius:8px; background:var(--paper-dim); font-family:inherit; font-weight:600; font-size:0.78rem; cursor:pointer; color:var(--ink); transition:background .2s var(--ease); }
.reader-nav button:hover:not(:disabled) { background:var(--accent); color:#fff; } .reader-nav button:disabled { opacity:.35; cursor:not-allowed; }
.reader-nav .page-info { font-family:inherit; font-weight:600; font-size:0.72rem; letter-spacing:1px; text-transform:uppercase; color:var(--ink-soft); }
.chapter-list { display:flex; flex-direction:column; gap:4px; max-height:400px; overflow-y:auto; }
.chapter-list::-webkit-scrollbar { width:5px; } .chapter-list::-webkit-scrollbar-track { background:var(--paper-dim); } .chapter-list::-webkit-scrollbar-thumb { background:var(--rule); }
.chapter-item { padding:9px 12px; border:none; border-radius:8px; background:var(--paper); font-size:0.85rem; cursor:pointer; display:flex; justify-content:space-between; align-items:center; }
.chapter-item:hover { border-color:var(--accent); background:var(--accent-soft); } .chapter-item.active { border-color:var(--accent); background:var(--accent-soft); color:var(--accent); font-weight:bold; }
.chapter-item .ch-num { font-family:inherit; font-weight:600; font-size:0.72rem; } .chapter-item .ch-group { font-family:inherit; font-weight:600; font-size:0.66rem; color:var(--ink-soft); }
.lang-filter { display:flex; gap:4px; flex-wrap:wrap; margin-bottom:10px; } .lang-btn { padding:5px 12px; border:none; border-radius:6px; background:var(--paper); font-family:inherit; font-weight:600; font-size:0.7rem; letter-spacing:0.5px; text-transform:uppercase; cursor:pointer; color:var(--ink-soft); } .lang-btn.active { background:var(--accent); color:#fff; }
.read-info { margin-bottom:16px; } .read-info h1 { font-size:1.6rem; font-weight:400; margin-bottom:4px; } .read-info .meta { font-family:inherit; font-weight:600; font-size:0.72rem; letter-spacing:1px; text-transform:uppercase; color:var(--ink-soft); }
.mode-toggle { display:flex; gap:4px; margin-bottom:10px; } .mode-toggle button { flex:1; padding:6px; border:1px solid var(--rule); background:var(--paper); font-family:inherit; font-weight:600; font-size:0.68rem; letter-spacing:1px; text-transform:uppercase; cursor:pointer; color:var(--ink-soft); } .mode-toggle button.active { background:var(--accent); color:var(--paper); border-color:var(--accent); }
.reader-viewer.double { display:flex; justify-content:center; gap:2px; } .reader-viewer.double img { width:50%; max-width:50%; height:auto; object-fit:contain; } .reader-viewer.double img:only-child { width:100%; max-width:900px; }
.reader-viewer:fullscreen { background:#1a1814; display:flex; align-items:center; justify-content:center; } .reader-viewer:fullscreen img { max-height:100vh; width:auto; max-width:100%; object-fit:contain; }
.reader-viewer.double:fullscreen { align-items:center; } .reader-viewer.double:fullscreen img { max-height:100vh; width:50%; max-width:50%; object-fit:contain; }
.reader-empty { text-align:center; padding:80px 20px; } .reader-empty h2 { font-size:1.4rem; font-weight:400; margin-bottom:8px; } .reader-empty p { color:var(--ink-soft); font-family:inherit; font-weight:600; font-size:0.78rem; letter-spacing:1px; text-transform:uppercase; }
</style></head><body>
${headerMarkup('Read · Record #' + anilistId, false)}
<div class="auth-gate" id="auth-gate"><h1>Sign in required</h1><p>Sign in to read.</p><div class="auth-buttons"><button class="btn" id="gate-signin">Sign In</button><button class="btn" id="gate-signup">Sign Up</button></div></div>
<div class="app" id="app"><main><a href="/detail/${anilistId}" class="back-link">← Back to Details</a><div class="read-layout"><div class="read-main">
<div class="read-info" id="readInfo" style="display:none;"><h1 id="mangaTitle">—</h1><div class="meta" id="mangaMeta"></div></div>
<div class="reader-empty" id="readerEmpty"><h2>Select a chapter</h2><p>Choose from the list →</p></div>
<div class="reader-viewer" id="readerViewer" style="display:none;"></div>
<div class="reader-nav" id="readerNav" style="display:none;"><button id="prevPage" disabled>← Prev</button><span class="page-info" id="pageInfo">—</span><button id="nextPage" disabled>Next →</button></div>
<div class="reader-nav" id="chapterNav" style="display:none;"><button id="prevCh" disabled>← Prev Chapter</button><span class="page-info" id="chInfo">—</span><button id="nextCh" disabled>Next Chapter →</button></div>
</div><div class="read-sidebar">
<div class="read-card" style="display:block;"><h3>Chapters</h3><div class="lang-filter" id="langFilter"></div><div class="chapter-list" id="chapterList">${skeletonChapterList()}</div></div>
<div class="read-card" id="readerSettingsCard" style="display:none;"><h3>Reader Settings</h3><div class="mode-toggle" id="modeToggle"><button data-mode="single" class="active">Single</button><button data-mode="double">Double</button><button data-mode="vertical">Vertical</button></div><button id="fullscreenBtn" style="width:100%;margin-top:8px;padding:9px;border:none;border-radius:8px;background:var(--accent);font-family:inherit;font-weight:700;font-size:0.78rem;cursor:pointer;color:#fff;">Enter Fullscreen</button></div>
</div></div></main></div>
<script>
${commonAuthJS()}
const ANILIST_API = 'https://graphql.anilist.co'; const MANGADEX_API = '/md'; const STREAM_PROXY = ${JSON.stringify(PROXY)}; const ANILIST_ID = ${anilistId};
function mdFetch(path) { return fetch('/md' + path); }
let mangaTitle = '', mangaCover = '', mangaDexId = null, chapters = [], currentChapterIndex = -1, currentPages = [], currentPageIndex = 0, readerMode = 'single', currentLang = 'en', resumeTarget = null;
function escapeHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
async function fetchTitle() {
  const empty = document.getElementById('readerEmpty');
  try { const resp = await fetch(ANILIST_API, { method: 'POST', headers: { 'Content-Type':'application/json','Accept':'application/json' }, body: JSON.stringify({ query: 'query($id:Int){Media(id:$id){id title{romaji english native} format coverImage{large}}}', variables: { id: ANILIST_ID } }) });
    const json = await resp.json();
    if (json.errors) { empty.innerHTML = '<h2>AniList error</h2><p>' + escapeHtml(json.errors[0].message) + '</p>'; return null; }
    if (json.data && json.data.Media) { const m = json.data.Media; mangaTitle = m.title.english || m.title.romaji || m.title.native || 'Unknown'; mangaCover = m.coverImage ? m.coverImage.large : ''; document.getElementById('mangaTitle').textContent = mangaTitle; document.getElementById('readInfo').style.display = 'block'; document.getElementById('mangaMeta').textContent = 'Record #' + ANILIST_ID + (m.format ? ' · ' + m.format : ''); document.title = 'The Ledger — ' + mangaTitle; return mangaTitle; }
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
  if (!filtered.length) { list.innerHTML = '<div style="font-size:0.72rem;color:var(--ink-soft);padding:10px;">No chapters found.</div>'; return; }
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
async function loadChapter(chapter, idx, resumePage) {
  document.getElementById('readerEmpty').style.display = 'none'; document.getElementById('readerViewer').style.display = 'block'; document.getElementById('readerSettingsCard').style.display = 'block';
  document.getElementById('readerViewer').innerHTML = '<div style="padding:20px;"><div class="skel" style="height:70vh;max-width:900px;margin:0 auto;"></div></div>';
  const chId = chapter.id;
  try { const resp = await mdFetch('/at-home/server/' + chId); const data = await safeJson(resp);
    if (data.result !== 'ok') { const filtered = chapters._filtered || []; if (idx + 1 < filtered.length) { currentChapterIndex = idx + 1; document.querySelectorAll('.chapter-item').forEach(c => c.classList.remove('active')); document.querySelectorAll('.chapter-item')[currentChapterIndex]?.classList.add('active'); return loadChapter(filtered[currentChapterIndex], currentChapterIndex); } throw new Error('Chapter not available on MangaDex servers.'); }
    const baseUrl = data.baseUrl; if (!baseUrl) throw new Error('No server URL in response (result=' + (data.result||'none') + ')');
    const ch = data.chapter || {}; const attr = chapter.attributes || chapter; const hash = ch.hash || attr.hash;
    const files = (ch.data && ch.data.length) ? ch.data : (ch.dataSaver && ch.dataSaver.length) ? ch.dataSaver : (attr.data || attr.dataSaver || []);
    if (!hash || !files.length) throw new Error('No page data (hash=' + (hash||'none') + ', files=' + files.length + ')');
    const qualityPath = (ch.data && ch.data.length) ? 'data' : (attr.data && attr.data.length) ? 'data' : 'data-saver';
    currentPages = files.map(f => STREAM_PROXY + encodeURIComponent(baseUrl + '/' + qualityPath + '/' + hash + '/' + f));
    currentPageIndex = (typeof resumePage === 'number' && resumePage < currentPages.length) ? resumePage : 0;
    renderPages(); updateChapterNav(idx); saveMangaProgress(attr.chapter);
  } catch (err) { document.getElementById('readerViewer').innerHTML = '<div style="text-align:center;padding:60px;font-size:0.8rem;color:#f87171;">Failed to load: ' + escapeHtml(err.message) + '</div>'; }
}
function renderPages() {
  const viewer = document.getElementById('readerViewer'); viewer.classList.remove('double');
  if (readerMode === 'single') { viewer.innerHTML = '<img src="' + currentPages[currentPageIndex] + '" alt="Page ' + (currentPageIndex+1) + '" />'; document.getElementById('readerNav').style.display = 'flex'; document.getElementById('prevPage').disabled = currentPageIndex === 0; document.getElementById('nextPage').disabled = currentPageIndex >= currentPages.length - 1; document.getElementById('pageInfo').textContent = 'Page ' + (currentPageIndex+1) + ' / ' + currentPages.length; }
  else if (readerMode === 'double') { viewer.classList.add('double'); let html = '<img src="' + currentPages[currentPageIndex] + '" alt="Page ' + (currentPageIndex+1) + '" />'; if (currentPageIndex + 1 < currentPages.length) { html += '<img src="' + currentPages[currentPageIndex + 1] + '" alt="Page ' + (currentPageIndex+2) + '" />'; } viewer.innerHTML = html; document.getElementById('readerNav').style.display = 'flex'; document.getElementById('prevPage').disabled = currentPageIndex === 0; document.getElementById('nextPage').disabled = currentPageIndex + 2 >= currentPages.length; document.getElementById('pageInfo').textContent = 'Pages ' + (currentPageIndex+1) + '-' + (Math.min(currentPageIndex+2, currentPages.length)) + ' / ' + currentPages.length; }
  else { viewer.innerHTML = currentPages.map((url, i) => '<img src="' + url + '" alt="Page ' + (i+1) + '" />').join(''); document.getElementById('readerNav').style.display = 'none'; }
}
function updateChapterNav(idx) { document.getElementById('chapterNav').style.display = 'flex'; const filtered = chapters._filtered || []; document.getElementById('prevCh').disabled = idx <= 0; document.getElementById('nextCh').disabled = idx >= filtered.length - 1; document.getElementById('chInfo').textContent = 'Chapter ' + (idx + 1) + ' / ' + filtered.length; }
document.getElementById('prevPage').addEventListener('click', () => { const step = readerMode === 'double' ? 2 : 1; if (currentPageIndex > 0) { currentPageIndex = Math.max(0, currentPageIndex - step); renderPages(); window.scrollTo(0,0); saveMangaProgress(); } });
document.getElementById('nextPage').addEventListener('click', () => { const step = readerMode === 'double' ? 2 : 1; if (currentPageIndex < currentPages.length - 1) { currentPageIndex = Math.min(currentPages.length - 1, currentPageIndex + step); renderPages(); window.scrollTo(0,0); saveMangaProgress(); } });
document.getElementById('prevCh').addEventListener('click', () => { const filtered = chapters._filtered || []; if (currentChapterIndex > 0) { currentChapterIndex--; document.querySelectorAll('.chapter-item').forEach(c => c.classList.remove('active')); document.querySelectorAll('.chapter-item')[currentChapterIndex]?.classList.add('active'); loadChapter(filtered[currentChapterIndex], currentChapterIndex); } });
document.getElementById('nextCh').addEventListener('click', () => { const filtered = chapters._filtered || []; if (currentChapterIndex < filtered.length - 1) { currentChapterIndex++; document.querySelectorAll('.chapter-item').forEach(c => c.classList.remove('active')); document.querySelectorAll('.chapter-item')[currentChapterIndex]?.classList.add('active'); loadChapter(filtered[currentChapterIndex], currentChapterIndex); } });
document.querySelectorAll('#modeToggle button').forEach(btn => { btn.addEventListener('click', () => { readerMode = btn.dataset.mode; document.querySelectorAll('#modeToggle button').forEach(b => b.classList.remove('active')); btn.classList.add('active'); if (currentPages.length) renderPages(); }); });
document.addEventListener('keydown', (e) => { if (!currentPages.length) return; if (readerMode === 'vertical') return; const step = readerMode === 'double' ? 2 : 1; if (e.key === 'ArrowLeft' && currentPageIndex > 0) { currentPageIndex = Math.max(0, currentPageIndex - step); renderPages(); window.scrollTo(0,0); saveMangaProgress(); } if (e.key === 'ArrowRight' && currentPageIndex < currentPages.length - 1) { currentPageIndex = Math.min(currentPages.length - 1, currentPageIndex + step); renderPages(); window.scrollTo(0,0); saveMangaProgress(); } });
const fullscreenBtn = document.getElementById('fullscreenBtn'); const readerViewer = document.getElementById('readerViewer');
fullscreenBtn.addEventListener('click', () => { if (document.fullscreenElement) { document.exitFullscreen(); } else { readerViewer.requestFullscreen().catch(() => {}); } });
document.addEventListener('fullscreenchange', () => { fullscreenBtn.textContent = document.fullscreenElement ? 'Exit Fullscreen' : 'Enter Fullscreen'; });
function saveMangaProgress(chNumOverride) {
  if (!window.Clerk || !Clerk.user) return;
  const filtered = chapters._filtered || []; const ch = filtered[currentChapterIndex]; if (!ch) return;
  const attr = ch.attributes || ch; const chNum = chNumOverride || attr.chapter || '?';
  fetch('/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: Clerk.user.id, anilistId: ANILIST_ID, type: 'manga', title: mangaTitle, coverImage: mangaCover, episodeOrChapter: 'Ch. ' + chNum, pageIndex: currentPageIndex }) }).catch(() => {});
}
async function checkResume() {
  if (!window.Clerk || !Clerk.user) return null;
  try { const res = await fetch('/api/progress?user=' + encodeURIComponent(Clerk.user.id) + '&id=' + ANILIST_ID); const data = await res.json(); const item = data.item;
    if (item && item.type === 'manga' && item.episode_or_chapter) { const m = String(item.episode_or_chapter).match(/([\\d.]+)/); return m ? { chNum: m[1], pageIndex: item.page_index || 0 } : null; }
  } catch {} return null;
}
async function onAuthenticated() {
  const empty = document.getElementById('readerEmpty');
  empty.innerHTML = '<h2>Loading…</h2><p>Fetching manga data.</p>';
  const title = await fetchTitle(); if (!title) return;
  resumeTarget = await checkResume();
  empty.innerHTML = '<h2>Searching…</h2><p>Looking for "' + escapeHtml(title) + '" on MangaDex.</p>';
  mangaDexId = await searchMangaDex(title); if (!mangaDexId) return;
  empty.innerHTML = '<h2>Loading chapters…</h2><p>Fetching chapter list from MangaDex.</p>';
  chapters = await fetchChapters(mangaDexId); if (!chapters.length) return;
  renderLangFilter(); renderChapterList(); empty.style.display = 'none';
  if (resumeTarget) {
    const filtered = chapters._filtered || chapters;
    const idx = filtered.findIndex(ch => String((ch.attributes||ch).chapter) === resumeTarget.chNum);
    if (idx >= 0) { currentChapterIndex = idx; document.querySelectorAll('.chapter-item').forEach((c,i) => c.classList.toggle('active', i === idx)); loadChapter(filtered[idx], idx, resumeTarget.pageIndex); }
  }
}
</script></body></html>`;
}
