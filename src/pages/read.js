import { commonCSS, themeInitScript, siteMeta, clerkHead } from '../lib/theme.js';
import { commonAuthJS, headerMarkup } from '../lib/auth.js';
import { skeletonChapterList } from '../lib/skeletons.js';

export function readPage(pk, cu, anilistId, anivexaApi, streamProxy) {
  const PROXY = streamProxy || 'https://stream-proxy.muldera.workers.dev/?url=';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">${themeInitScript()}
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
