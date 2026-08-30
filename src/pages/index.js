import { commonCSS, themeInitScript, siteMeta, clerkHead } from '../lib/theme.js';
import { commonAuthJS, headerMarkup } from '../lib/auth.js';
import { icon } from '../lib/icons.js';
import { skeletonRail } from '../lib/skeletons.js';

export function indexPage(pk, cu) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">${themeInitScript()}
<title>The Ledger — Anime &amp; Manga Index</title>${siteMeta()}
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
