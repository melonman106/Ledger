import { commonCSS, themeInitScript, siteMeta, clerkHead } from '../lib/theme.js';
import { commonAuthJS, headerMarkup } from '../lib/auth.js';
import { skeletonHero } from '../lib/skeletons.js';

export function detailPage(pk, cu, anilistId) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">${themeInitScript()}
<title>The Ledger — Record #${anilistId}</title>${siteMeta("Details, episodes, and chapters for this title on The Ledger.")}
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
