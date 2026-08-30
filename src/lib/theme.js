export function clerkHead(pk, cu) {
  return `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet"><script async crossorigin="anonymous" data-clerk-publishable-key="${pk}" type="text/javascript" src="${cu}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script>`;
}

export function themeInitScript() {
  return `<script>(function(){try{var t=localStorage.getItem('ledger-theme');if(t==='dark'){document.documentElement.setAttribute('data-theme','dark');}}catch(e){}})();</script>`;
}

export function siteMeta(description) {
  const desc = description || 'Stream anime and read manga from one fast, ad-free index.';
  const favicon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23142030'/%3E%3Cpath d='M9 7h10l5 5v13a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z' fill='none' stroke='%2326a3d6' stroke-width='2'/%3E%3Cpath d='M19 7v5h5' fill='none' stroke='%2326a3d6' stroke-width='2'/%3E%3C/svg%3E";
  return `<link rel="icon" type="image/svg+xml" href="${favicon}"><meta name="theme-color" content="#142030"><meta name="description" content="${desc}"><meta property="og:title" content="The Ledger"><meta property="og:description" content="${desc}"><meta property="og:type" content="website"><meta property="og:image" content="${favicon}">`;
}

export function commonCSS() {
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
