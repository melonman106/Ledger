/*!
 * The Ledger — anime & manga index.
 *
 * One file, no build step. Paste into a Cloudflare Worker (or `wrangler deploy`).
 *
 * Environment (dashboard → Settings → Variables):
 *   CLERK_PUBLISHABLE_KEY    Clerk publishable key (required for sign-in)
 *   CLERK_FRONTEND_API_URL   Clerk Frontend API URL, e.g. https://xxxx.clerk.accounts.dev
 *   ANIVEXA_API_URL          optional, default https://anivexa-api-gubc.onrender.com
 *   STREAM_PROXY_URL         optional, default https://stream-proxy.muldera.workers.dev/?url=
 *   STREAM_PROXY_REFERER_PARAM  optional. If your stream proxy accepts the upstream Referer as a
 *                            query parameter, put its name here (e.g. "referer") and it is appended.
 * D1 binding (optional, enables Continue Watching sync): DB  (or "ledger-db").
 *   The same binding also holds a small `cache` table (created automatically): saved AniList answers shared by every
 *   Worker instance, and the "AniList is blocking us" pause. Without D1 everything still works, from per-instance memory.
 *
 * Backup sources: when AniList is blocked / rate-limiting / down and nothing saved can answer, pages are filled from Jikan
 * (MyAnimeList) and Kitsu instead, each covering for the other, and the site returns to AniList by itself as soon as it
 * answers again. Ids are translated with ARM (arm.haglund.dev). Set BACKUP_SOURCES=off to disable. See parts below (02-fallback).
 *
 * AniList etiquette: every AniList request goes through anilistPost() (one honest User-Agent, cached, paced, and it
 * stops completely for 15 min → 1 h → 6 h → 24 h when AniList answers "blocked" or 429). GET /status shows the state.
 *
 * Layout of this file:
 *   1. Worker: routing, edge-cached proxies (AniList, Anivexa, MangaDex), progress API, HTML shell
 *   2. APP_CSS: the stylesheet (served at /_/app.css)
 *   3. clientApp(): the browser app. It is a real function so it can be edited like normal code;
 *      the Worker serves its source text at /_/app.js (no template-literal escaping involved).
 */

const SITE_NAME = 'The Ledger';
const FAVICON = 'https://f.playcode.io/p-2672631/v-1/01a01c84-3719-76e8-a432-c61309fd7732/icon.png';
const DEFAULT_API = 'https://anivexa-api-gubc.onrender.com';
const DEFAULT_PROXY = 'https://stream-proxy.muldera.workers.dev/?url=';
const ANILIST_URL = 'https://graphql.anilist.co';
const MANGADEX_URL = 'https://api.mangadex.org';

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx || { waitUntil() {} });
    } catch (err) {
      return json({ error: 'internal error', message: String((err && err.message) || err) }, 500);
    }
  },
};

/* ───────────────────────────── routing ───────────────────────────── */

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const rt = { ctx, db: dbOf(env), fb: fbOn(env) };
  if (path === '/api/progress' || path.startsWith('/api/progress/')) return handleProgress(request, env, url);
  if (path === '/api' || path.startsWith('/api/')) return handleApi(request, env, ctx, url);
  if (path === '/gql') return handleGql(request, rt, url);
  if (path === '/home.json') return handleHome(request, rt);
  if (path === '/status') return handleStatus(request, rt);
  if (path.startsWith('/md/')) return handleMangaDex(request, ctx, url);
  if (path === '/warm') return handleWarm(env, ctx);
  if (path === '/_/app.js' || path === '/_/app.css') return handleAsset(path, url);
  if (path === '/favicon.ico') return Response.redirect(FAVICON, 302);
  if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /api/\nDisallow: /md/\nDisallow: /gql\nDisallow: /status\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method not allowed' }, 405);
  return handlePage(request, env, ctx, url);
}

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {}),
  });
}

/* ───────────────────────────── edge cache helpers ───────────────────────────── */

function edgeCache() {
  return typeof caches !== 'undefined' ? caches.default : null;
}

function hash32(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
function hashKey(str) { return hash32(str, 2166136261) + hash32(str, 3339675911) + str.length.toString(16); }

function edgeKey(kind, keyStr) { return new Request('https://edge.ledger.invalid/' + kind + '/' + hashKey(keyStr)); }

/** Read an entry. Returns {status, text, type, age} or null. */
async function edgeGet(kind, keyStr) {
  const c = edgeCache();
  if (!c) return null;
  try {
    const hit = await c.match(edgeKey(kind, keyStr));
    if (!hit) return null;
    const at = Number(hit.headers.get('x-cached-at')) || 0;
    return { status: hit.status, text: await hit.text(), type: hit.headers.get('content-type') || 'application/json; charset=utf-8', age: (Date.now() - at) / 1000 };
  } catch { return null; }
}

function edgePut(ctx, kind, keyStr, entry, keepSeconds) {
  const c = edgeCache();
  if (!c) return;
  const res = new Response(entry.text, {
    status: entry.status || 200,
    headers: { 'Content-Type': entry.type || 'application/json; charset=utf-8', 'x-cached-at': String(Date.now()), 'Cache-Control': 'public, max-age=' + Math.max(1, keepSeconds | 0) },
  });
  ctx.waitUntil(c.put(edgeKey(kind, keyStr), res).catch(() => {}));
}

/* ── per-instance memory + D1 layers (the Cache API only works on custom domains, not *.workers.dev) ── */

function dbOf(env) { return (env && (env.DB || env['ledger-db'] || env['ledger_db'])) || null; }

const MEM = new Map(); // layerKey → {status, text, type, at, exp}
const MEM_MAX = 80;
const MEM_MAX_CHARS = 1500000;
const BG = new Map(); // layerKey → start time of a background refresh running in this instance

function layerKey(kind, keyStr) { return kind + '/' + hashKey(keyStr); }

function memGet(lk) {
  const e = MEM.get(lk);
  if (!e) return null;
  if (Date.now() > e.exp) { MEM.delete(lk); return null; }
  MEM.delete(lk); MEM.set(lk, e); // LRU touch
  return { status: e.status, text: e.text, type: e.type, age: (Date.now() - e.at) / 1000 };
}
function memPut(lk, entry, atMs, keepSeconds) {
  if (!entry || entry.status !== 200 || typeof entry.text !== 'string' || entry.text.length > MEM_MAX_CHARS) return;
  MEM.delete(lk);
  MEM.set(lk, { status: 200, text: entry.text, type: entry.type || 'application/json; charset=utf-8', at: atMs || Date.now(), exp: Date.now() + Math.max(1, keepSeconds || 60) * 1000 });
  while (MEM.size > MEM_MAX) MEM.delete(MEM.keys().next().value);
}

const DB_KEEP_MS = 7 * 86400000;
let CACHE_TABLE_OK = false;
async function dbReady(db) {
  if (!db) return false;
  if (CACHE_TABLE_OK) return true;
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, body TEXT NOT NULL, at INTEGER NOT NULL)').run();
    CACHE_TABLE_OK = true;
    return true;
  } catch { return false; }
}
async function dbGet(db, k) {
  try {
    if (!(await dbReady(db))) return null;
    const row = await db.prepare('SELECT body, at FROM cache WHERE k = ?').bind(k).first();
    if (!row || typeof row.body !== 'string') return null;
    const at = Number(row.at) || 0;
    return { status: 200, text: row.body, type: 'application/json; charset=utf-8', age: (Date.now() - at) / 1000, at };
  } catch { return null; }
}
function dbPut(ctx, db, k, entry) {
  if (!db || !entry || entry.status !== 200 || entry.text.length > MEM_MAX_CHARS) return;
  ctx.waitUntil((async () => {
    try {
      if (!(await dbReady(db))) return;
      await db.prepare('INSERT INTO cache (k, body, at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET body = excluded.body, at = excluded.at').bind(k, entry.text, Date.now()).run();
      if (Math.random() < 0.02) await db.prepare('DELETE FROM cache WHERE at < ? AND k NOT LIKE ?').bind(Date.now() - DB_KEEP_MS, 'al:%').run();
    } catch { /* optional layer */ }
  })());
}

/**
 * Stale-while-revalidate around an upstream fetcher. Layers, fastest first: instance memory → edge Cache API → D1 (opts.db).
 *   opts: {kind, key, fresh, stale, db?, fetcher: () => {status,text,type}, cacheable: (r) => {stale}|0}
 * Returns {entry, state}. `state` is HIT | STALE | MISS.
 * If the upstream is failing (throws, 5xx, 429, or the AniList breaker is open) any saved copy is served, however old.
 */
async function swr(ctx, opts) {
  const lk = layerKey(opts.kind, opts.key);
  const db = opts.db || null;
  const isFresh = (h) => !!h && h.age < opts.fresh;
  let hit = memGet(lk);
  if (!isFresh(hit)) {
    const e = await edgeGet(opts.kind, opts.key);
    if (e && (!hit || e.age < hit.age)) { hit = e; memPut(lk, e, Date.now() - e.age * 1000, Math.max(1, opts.stale - e.age)); }
  }
  if (!isFresh(hit) && db) {
    const row = await dbGet(db, lk);
    if (row && (!hit || row.age < hit.age)) { hit = row; memPut(lk, row, row.at, Math.max(1, opts.stale - row.age)); }
  }
  const refresh = async () => {
    const r = await opts.fetcher();
    const keep = opts.cacheable(r);
    if (keep) {
      edgePut(ctx, opts.kind, opts.key, r, keep.stale);
      memPut(lk, r, Date.now(), keep.stale);
      if (db) dbPut(ctx, db, lk, r);
    }
    return { r, keep };
  };
  if (hit) {
    if (hit.age < opts.fresh) return { entry: hit, state: 'HIT' };
    if (hit.age < opts.stale) {
      const started = BG.get(lk);
      if (!started || Date.now() - started > 60000) {
        BG.set(lk, Date.now());
        ctx.waitUntil(refresh().catch(() => {}).then(() => { BG.delete(lk); }));
      }
      return { entry: hit, state: 'STALE' };
    }
  }
  try {
    const { r, keep } = await refresh();
    if (!keep && hit && (r.status >= 500 || r.status === 429)) return { entry: hit, state: 'STALE' };
    return { entry: r, state: 'MISS' };
  } catch (err) {
    if (hit) return { entry: hit, state: 'STALE' };
    throw err;
  }
}

async function upstream(url, init, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 20000);
  try { return await fetch(url, Object.assign({}, init || {}, { signal: ctl.signal })); } finally { clearTimeout(t); }
}

/* ───────────────────────────── Anivexa API proxy ───────────────────────────── */

const API_ALLOW = [
  /^\/?$/,
  /^\/map\/\d{1,9}\/?$/,
  /^\/episodes\/(?:[a-z0-9-]+\/)*\d{1,9}\/?$/i,
  /^\/watch\/[a-z0-9]+\/\d{1,9}\/(?:sub|dub)\/[a-z0-9]+-\d{1,6}\/?$/i,
  /^\/stream\/reanime\/\d{1,9}\/(?:sub|dub)\/\d{1,6}\/?$/i,
];

function stripStacks(text) {
  // Provider errors from the API carry stack traces; drop them (only done on small bodies).
  if (text.length > 40000 || text.indexOf('"stack"') < 0) return text;
  try {
    const walk = (v) => {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        const o = {};
        for (const k of Object.keys(v)) { if (k === 'stack' || k === 'Raw-ERROR') continue; o[k] = walk(v[k]); }
        return o;
      }
      return v;
    };
    return JSON.stringify(walk(JSON.parse(text)));
  } catch { return text; }
}

function episodesQuality(text) {
  // 'good' when at least one provider returned episodes; 'empty' when providers answered with none; 'error' otherwise.
  if (/"(?:sub|dub)"\s*:\s*\[\s*\{/.test(text)) return 'good';
  if (/"error"\s*:/.test(text)) return 'error';
  return 'empty';
}

async function handleApi(request, env, ctx, url) {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: Object.assign({ 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': '*' }, cors) });
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method not allowed' }, 405, cors);
  const base = (env.ANIVEXA_API_URL || DEFAULT_API).replace(/\/+$/, '');
  const apiPath = url.pathname.replace(/^\/api/, '') || '/';
  if (!API_ALLOW.some((re) => re.test(apiPath))) return json({ error: 'not found' }, 404, cors);
  const target = base + apiPath + (url.search || '');
  const kind = apiPath.startsWith('/episodes') ? 'episodes' : apiPath.startsWith('/map') ? 'map' : apiPath.startsWith('/watch') ? 'watch' : apiPath.startsWith('/stream') ? 'stream' : 'other';

  if (kind === 'stream') {
    try {
      const r = await upstream(target, { redirect: 'manual', headers: { Accept: '*/*' } }, 30000);
      const loc = r.headers.get('location');
      if (loc) return new Response(null, { status: 302, headers: Object.assign({ Location: loc, 'Cache-Control': 'no-store' }, cors) });
      return json({ error: 'no stream', status: r.status }, 502, cors);
    } catch (err) { return json({ error: 'API unavailable', waking: true }, 502, cors); }
  }

  const fetcher = async () => {
    const r = await upstream(target, { headers: { Accept: 'application/json' } }, kind === 'map' ? 20000 : 50000);
    const raw = await r.text();
    const ctype = r.headers.get('content-type') || '';
    if (!/json/i.test(ctype) && !/^\s*[\[{]/.test(raw)) return { status: 502, text: JSON.stringify({ error: 'API unavailable', waking: r.status !== 404, upstream: r.status }), type: 'application/json; charset=utf-8' };
    return { status: r.status, text: r.status === 200 ? (kind === 'watch' ? raw : stripStacks(raw)) : stripStacks(raw), type: 'application/json; charset=utf-8' };
  };

  let entry, state = 'MISS';
  try {
    if (kind === 'episodes' || kind === 'map') {
      const out = await swr(ctx, {
        kind: 'api', key: target, fresh: kind === 'map' ? 21600 : 120, stale: kind === 'map' ? 604800 : 3600, fetcher,
        cacheable: (r) => {
          if (r.status !== 200) return 0;
          if (kind === 'map') return { stale: 604800 };
          const q = episodesQuality(r.text);
          // Good results are served fresh for 2 min and stale for an hour; bad ones barely linger.
          return q === 'good' ? { stale: 3600 } : { stale: 20 };
        },
      });
      entry = out.entry; state = out.state;
    } else {
      entry = await fetcher(); // watch: signed, short-lived URLs → never cached
    }
  } catch (err) {
    return json({ error: 'API unavailable', waking: true, message: String((err && err.message) || err) }, 502, cors);
  }

  const ok = entry.status === 200;
  const cc = ok ? (kind === 'watch' ? 'no-store' : 'public, max-age=30') : 'no-store';
  return new Response(entry.text, { status: entry.status, headers: Object.assign({ 'Content-Type': entry.type || 'application/json; charset=utf-8', 'Cache-Control': cc, 'X-Cache': state }, cors) });
}

/* ───────────────────────────── AniList proxy (GET /gql?q=&v=) ───────────────────────────── */

function gqlTtl(q) {
  if (/airingSchedules|nextAiringEpisode\s*\{[^}]*timeUntilAiring/.test(q)) return 300;
  if (/search\s*:/.test(q)) return 300;
  if (/\bMedia\s*\(\s*id\s*:/.test(q)) return 1800;
  return 900;
}

/* ───────────────────────────── AniList gate (circuit breaker) ─────────────────────────────
 * AniList blocks IP addresses that send too much traffic ("You have been manually blocked. Please come to the
 * principal's office."). This is the ONLY code that talks to AniList. It sends one honest request at a time-ish
 * (small gap between requests), and when AniList says 429 or "blocked" it stops calling AniList completely
 * (15 min → 1 h → 6 h → 24 h, then a single probe request) while saved answers keep being served.
 * It does not try to get around a block: only AniList can lift one. */

const AL_STEPS = [900, 3600, 21600, 86400]; // seconds
const AL_BLOCKED_RE = /manually blocked|you have been blocked|principal'?s office/i;
const AL_GAP_MS = 500;
const AL_MAX_WAIT_MS = 6000;
const AL = { until: 0, level: 0, reason: '', message: '', since: 0, shared: false, probing: 0, next: 0, fails: 0, synced: 0, requests: 0, ok: 0, lastStatus: 0, lastAt: 0, lastMessage: '' };

class ALPause extends Error {
  constructor(kind, retryAfter, message) { super(message); this.name = 'ALPause'; this.kind = kind; this.retryAfter = retryAfter; }
}

function alLeft() { return Math.max(0, Math.ceil((AL.until - Date.now()) / 1000)); }

function alPause() {
  const secs = alLeft() || 5, mins = Math.max(1, Math.ceil(secs / 60));
  const msg = AL.reason === 'blocked'
    ? 'AniList has blocked this server, so new lookups are paused (next attempt in about ' + mins + ' min). Pages you opened before still load from saved data.'
    : AL.reason === 'unavailable'
      ? 'AniList is not responding right now. Please try again in a moment.'
      : 'AniList is rate-limiting requests. Please try again in about ' + (secs < 90 ? secs + ' seconds' : mins + ' minutes') + '.';
  return new ALPause(AL.reason || 'limited', secs, msg);
}

function alPersist(rt) {
  if (!rt.db) return;
  rt.ctx.waitUntil((async () => {
    try {
      if (!(await dbReady(rt.db))) return;
      if (AL.until > Date.now()) {
        const body = JSON.stringify({ until: AL.until, level: AL.level, reason: AL.reason, message: AL.message, since: AL.since });
        await rt.db.prepare('INSERT INTO cache (k, body, at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET body = excluded.body, at = excluded.at').bind('al:breaker', body, Date.now()).run();
        AL.shared = true;
      } else {
        await rt.db.prepare('DELETE FROM cache WHERE k = ?').bind('al:breaker').run();
      }
    } catch { /* optional */ }
  })());
}

/** Other Worker instances share the pause through D1 (checked at most every 20 s). */
async function alSync(rt) {
  const now = Date.now();
  if (!rt.db || now - AL.synced < 20000) return;
  AL.synced = now;
  try {
    if (!(await dbReady(rt.db))) return;
    const row = await rt.db.prepare('SELECT body FROM cache WHERE k = ?').bind('al:breaker').first();
    let b = null;
    if (row && row.body) { try { b = JSON.parse(row.body); } catch { b = null; } }
    if (b) {
      // Adopt the shared pause even when it has already expired: the block hasn't been seen to lift, so this instance must
      // probe once (and escalate to the next step if it is still blocked) instead of starting over at 15 minutes.
      if ((Number(b.until) || 0) > AL.until) { AL.until = Number(b.until); AL.level = Number(b.level) || 1; AL.reason = String(b.reason || 'blocked'); AL.message = String(b.message || ''); AL.since = Number(b.since) || now; AL.shared = true; }
      else if ((Number(b.level) || 0) > AL.level) AL.level = Number(b.level);
    } else if (AL.shared && now - AL.since > 20000) {
      AL.until = 0; AL.reason = ''; AL.level = 0; AL.message = ''; AL.shared = false; // another instance got through: the pause is over
    }
  } catch { /* optional */ }
}

function alOpen(rt, reason, secs, message) {
  AL.reason = reason; AL.until = Date.now() + secs * 1000; AL.since = Date.now(); AL.shared = false;
  AL.message = String(message || '').slice(0, 200);
  alPersist(rt);
}
function alBlock(rt, text) {
  AL.level = Math.min(AL.level + 1, AL_STEPS.length);
  let msg = '';
  try { const j = JSON.parse(text); msg = (j && j.errors && j.errors[0] && j.errors[0].message) || ''; } catch { /* plain text block page */ }
  alOpen(rt, 'blocked', AL_STEPS[AL.level - 1], msg || String(text).slice(0, 160));
}
function alOk(rt) {
  AL.fails = 0; AL.ok++;
  if (AL.reason || AL.level || AL.until) { AL.level = 0; AL.reason = ''; AL.until = 0; AL.message = ''; AL.shared = false; alPersist(rt); }
}

async function alPace() {
  const now = Date.now();
  if (AL.next > now + AL_MAX_WAIT_MS + AL_GAP_MS) AL.next = now; // the clock moved backwards: don't wait on a slot that can't be real
  const slot = Math.max(now, AL.next);
  if (slot - now > AL_MAX_WAIT_MS) throw new ALPause('limited', 5, 'AniList lookups are queued up. Please try again in a few seconds.');
  AL.next = slot + AL_GAP_MS;
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
}

function alStatus() {
  const left = alLeft();
  return {
    state: left ? AL.reason : 'ok', blocked: !!left && AL.reason === 'blocked', pausedForSeconds: left, blockLevel: AL.level,
    lastStatus: AL.lastStatus, lastMessage: AL.lastMessage, lastAt: AL.lastAt ? new Date(AL.lastAt).toISOString() : null,
    requests: AL.requests, ok: AL.ok,
  };
}

/** The one door to AniList. Resolves {status,text,type,retryAfter}; throws ALPause while paused (blocked / rate limited). */
async function anilistPost(rt, query, vars) {
  await alSync(rt);
  if (Date.now() < AL.until) throw alPause();
  const probe = AL.reason === 'blocked'; // the pause ended but the block hasn't been seen to lift: allow one probe at a time
  if (probe) {
    if (AL.probing && Date.now() - AL.probing < 20000) throw alPause();
    AL.probing = Date.now();
  }
  try {
    await alPace();
    if (Date.now() < AL.until) throw alPause(); // another request tripped the breaker while this one waited its turn
    AL.requests++;
    let r, text;
    try {
      r = await upstream(ANILIST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'TheLedger/2.1 (+anime index; polite client)' },
        body: JSON.stringify({ query, variables: vars || {} }),
      }, 15000);
      text = await r.text();
    } catch (err) {
      AL.lastStatus = 0; AL.lastAt = Date.now(); AL.lastMessage = 'network error';
      if (++AL.fails >= 3) { AL.fails = 0; alOpen(rt, 'unavailable', 30, 'network errors'); }
      throw err;
    }
    AL.lastStatus = r.status; AL.lastAt = Date.now();
    const okBody = r.status === 200 && /^\s*\{\s*"data"\s*:\s*\{/.test(text); // AniList answered normally (even an empty data object proves we are not blocked)
    AL.lastMessage = okBody ? 'ok' : String(text).replace(/\s+/g, ' ').slice(0, 160);
    const retryAfter = r.headers.get('retry-after') || '';
    if (r.status === 429) {
      const secs = Math.min(Math.max(Number(retryAfter) || 60, 5), 600);
      alOpen(rt, 'limited', secs, '429 Too Many Requests');
      throw alPause();
    }
    if (!okBody && (r.status === 403 || AL_BLOCKED_RE.test(String(text).slice(0, 800)))) { alBlock(rt, text); throw alPause(); }
    if (r.status >= 500) { if (++AL.fails >= 3) { AL.fails = 0; alOpen(rt, 'unavailable', 30, 'HTTP ' + r.status); } }
    else AL.fails = 0;
    if (okBody) alOk(rt);
    return { status: r.status, text, type: 'application/json; charset=utf-8', retryAfter };
  } finally { if (probe) AL.probing = 0; }
}

/** Turn a failure from the gate into a JSON error the client understands. */
function alFail(err, triedBackup) {
  if (err && err.name === 'ALPause') {
    const blocked = err.kind === 'blocked', status = err.kind === 'limited' ? 429 : 503;
    const message = err.message + (triedBackup ? ' The backup sources (Jikan, Kitsu) could not answer this either.' : '');
    return json({ errors: [{ message, status }], blocked, paused: true, retryAfter: err.retryAfter }, status, { 'Retry-After': String(err.retryAfter) });
  }
  return json({ errors: [{ message: 'AniList unavailable' }] }, 502);
}

async function handleStatus(request, rt) {
  AL.synced = 0;
  await alSync(rt);
  const a = alStatus();
  const body = { ok: !a.blocked, anilist: a, backup: Object.assign({ enabled: !!rt.fb }, fbStatus()), cache: { memoryEntries: MEM.size, edge: !!edgeCache(), d1: !!rt.db }, time: new Date().toISOString() };
  if (a.blocked) body.hint = 'AniList has blocked requests from this server. Only AniList can lift that (their Discord server). ' + (rt.fb ? 'Meanwhile the site fills pages from Jikan and Kitsu, and goes back to AniList on its own once it answers again.' : 'The site keeps working from saved data and retries on its own.');
  return json(body, 200);
}

const GQL_OK = /^\s*\{\s*"data"\s*:\s*\{\s*"/;

/** AniList could not answer: try Jikan / Kitsu. Returns a Response, or null when the backups cannot (or may not) help. */
async function gqlBackup(rt, q, vars) {
  if (!rt.fb) return null;
  try {
    const r = await fbGql(rt, q, vars);
    if (!r) return null;
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60', 'X-Cache': 'BACKUP', 'X-Backup': r.source || 'none' };
    if (alLeft()) headers['X-AniList'] = AL.reason;
    if (r.notFound) return new Response(JSON.stringify({ data: { Media: null }, errors: [{ message: 'Not Found.', status: 404 }] }), { status: 404, headers: Object.assign(headers, { 'Cache-Control': 'no-store' }) });
    return new Response(JSON.stringify(r.body), { status: 200, headers });
  } catch (e) {
    FBX.lastError = String((e && e.message) || e).slice(0, 160);
    return null;
  }
}

async function handleGql(request, rt, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ errors: [{ message: 'method not allowed' }] }, 405);
  const q = url.searchParams.get('q') || '';
  const v = url.searchParams.get('v') || '';
  if (!q || q.length > 9000 || /\bmutation\b/i.test(q) || v.length > 2000) return json({ errors: [{ message: 'bad request' }] }, 400);
  let vars = {};
  if (v) { try { vars = JSON.parse(v); } catch { return json({ errors: [{ message: 'bad variables' }] }, 400); } }
  const ttl = gqlTtl(q);
  try {
    const out = await swr(rt.ctx, {
      kind: 'gql', key: q + '\n' + v, fresh: ttl, stale: ttl * 12, db: rt.db,
      fetcher: () => anilistPost(rt, q, vars),
      cacheable: (r) => (r.status === 200 && GQL_OK.test(r.text) ? { stale: ttl * 12 } : 0),
    });
    const e = out.entry;
    if (e.status >= 500) { const b = await gqlBackup(rt, q, vars); if (b) return b; } // AniList itself is failing
    const headers = { 'Content-Type': e.type, 'X-Cache': out.state, 'Cache-Control': e.status === 200 ? 'public, max-age=' + Math.min(ttl, 300) : 'no-store' };
    if (e.retryAfter) headers['Retry-After'] = e.retryAfter;
    if (alLeft()) headers['X-AniList'] = AL.reason;
    return new Response(e.text, { status: e.status, headers });
  } catch (err) {
    const b = await gqlBackup(rt, q, vars); // paused (blocked / rate limited), unreachable, or no saved answer: ask Jikan / Kitsu
    return b || alFail(err, rt.fb);
  }
}

/* ───────────────────────────── home rails (one aggregated query) ───────────────────────────── */

function seasonOf(date) {
  const m = date.getUTCMonth() + 1;
  return { season: m <= 3 ? 'WINTER' : m <= 6 ? 'SPRING' : m <= 9 ? 'SUMMER' : 'FALL', year: date.getUTCFullYear() };
}
function nextSeasonOf(date) {
  const cur = seasonOf(date);
  const order = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
  const i = (order.indexOf(cur.season) + 1) % 4;
  return { season: order[i], year: i === 0 ? cur.year + 1 : cur.year };
}

const HOME_FIELDS = 'id title{romaji english} coverImage{large extraLarge color} bannerImage averageScore episodes chapters format status season seasonYear isAdult genres nextAiringEpisode{episode airingAt}';
const HOME_RAILS = [
  ['trending', 'Page(page:1,perPage:20){media(type:ANIME,sort:TRENDING_DESC,isAdult:false){...M description(asHtml:false)}}'],
  ['recent', 'Page(page:1,perPage:50){airingSchedules(airingAt_greater:$from,airingAt_lesser:$to,sort:TIME_DESC){episode airingAt media{...M}}}'],
  ['top', 'Page(page:1,perPage:10){media(type:ANIME,sort:SCORE_DESC,isAdult:false){...M}}'],
  ['season', 'Page(page:1,perPage:20){media(type:ANIME,season:$season,seasonYear:$year,sort:POPULARITY_DESC,isAdult:false){...M}}'],
  ['popular', 'Page(page:1,perPage:20){media(type:ANIME,sort:POPULARITY_DESC,isAdult:false){...M}}'],
  ['manga', 'Page(page:1,perPage:20){media(type:MANGA,format:MANGA,sort:SCORE_DESC,isAdult:false){...M}}'],
  ['trendingManga', 'Page(page:1,perPage:16){media(type:MANGA,sort:TRENDING_DESC,isAdult:false){...M}}'],
  ['upcoming', 'Page(page:1,perPage:16){media(type:ANIME,season:$nSeason,seasonYear:$nYear,sort:POPULARITY_DESC,isAdult:false){...M}}'],
];
const HOME_VARS_DECL = '$season:MediaSeason,$year:Int,$nSeason:MediaSeason,$nYear:Int,$from:Int,$to:Int';

function homeVars(now) {
  const d = new Date(now);
  const cur = seasonOf(d);
  const nxt = nextSeasonOf(d);
  const to = Math.floor(now / 1000 / 600) * 600; // 10-minute buckets keep the upstream query stable
  return { season: cur.season, year: cur.year, nSeason: nxt.season, nYear: nxt.year, from: to - 2 * 86400, to };
}

function homeQueryFor(rails) {
  // Declared variables must all be used, so declare only what the selected rails reference.
  const body = rails.map((r) => r[0] + ':' + r[1]).join('');
  const decl = HOME_VARS_DECL.split(',').filter((d) => body.indexOf(d.split(':')[0]) >= 0).join(',');
  return 'query' + (decl ? '(' + decl + ')' : '') + '{' + body + '} fragment M on Media{' + HOME_FIELDS + '}';
}

async function fetchHome(rt) {
  const vars = homeVars(Date.now());
  let r;
  try { r = await anilistPost(rt, homeQueryFor(HOME_RAILS), vars); } // throws while AniList is blocking / rate limiting: no fan-out then
  catch (err) { return homeBackup(rt, err); }
  if (r.status === 200 && GQL_OK.test(r.text)) return { status: 200, text: r.text, type: r.type };
  // Only a rejected query (HTTP 400 / GraphQL errors) justifies per-rail queries. Never fan out on rate limits or outages.
  if (r.status !== 400 && r.status !== 200) return homeBackup(rt, null);
  // The combined query failed validation. Fetch each rail alone (paced) so one bad rail can't blank the page.
  const data = {};
  await Promise.all(HOME_RAILS.map(async (rail) => {
    try {
      const x = await anilistPost(rt, homeQueryFor([rail]), vars);
      if (x.status !== 200) return;
      const j = JSON.parse(x.text);
      if (j && j.data && j.data[rail[0]]) data[rail[0]] = j.data[rail[0]];
    } catch { /* skip rail */ }
  }));
  if (!Object.keys(data).length) return homeBackup(rt, null);
  return { status: 200, text: JSON.stringify({ data, partial: true }), type: 'application/json; charset=utf-8' };
}

/** AniList could not give the home page: build it from Jikan / Kitsu. If they cannot either, fail the way AniList failed. */
async function homeBackup(rt, err) {
  if (rt.fb) {
    try {
      const h = await fbHome(rt);
      return { status: 200, text: JSON.stringify(h), type: 'application/json; charset=utf-8' };
    } catch (e) { FBX.lastError = String((e && e.message) || e).slice(0, 160); }
  }
  if (err) throw err;
  return { status: 502, text: JSON.stringify({ errors: [{ message: 'AniList unavailable' }] }), type: 'application/json; charset=utf-8' };
}

async function loadHome(rt) {
  return swr(rt.ctx, {
    kind: 'home', key: 'home:v2', fresh: 600, stale: 21600, db: rt.db, fetcher: () => fetchHome(rt),
    cacheable: (r) => (r.status === 200 && !HOME_MORE_RE.test(r.text.slice(-24)) ? { stale: 21600 } : 0), // a home page that is still being built from the backups is not saved
  });
}
const HOME_MORE_RE = /"more":true\}$/;

async function handleHome(request, rt) {
  try {
    const out = await loadHome(rt);
    const building = HOME_MORE_RE.test(out.entry.text.slice(-24));
    const headers = { 'Content-Type': out.entry.type, 'Cache-Control': out.entry.status === 200 && !building ? 'public, max-age=120, stale-while-revalidate=600' : 'no-store', 'X-Cache': out.state };
    if (alLeft()) headers['X-AniList'] = AL.reason;
    return new Response(out.entry.text, { status: out.entry.status, headers });
  } catch (err) { return alFail(err, rt.fb); }
}

/* ───────────────────────────── MangaDex proxy ───────────────────────────── */

const MD_ALLOW = /^\/(?:manga|manga\/[0-9a-f-]{36}(?:\/feed|\/aggregate)?|chapter\/[0-9a-f-]{36}|at-home\/server\/[0-9a-f-]{36})\/?$/;

async function handleMangaDex(request, ctx, url) {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method not allowed' }, 405, cors);
  const mdPath = url.pathname.replace(/^\/md/, '');
  if (!MD_ALLOW.test(mdPath) || url.search.length > 1500) return json({ result: 'error', errors: [{ detail: 'not allowed' }] }, 404, cors);
  const target = MANGADEX_URL + mdPath + (url.search || '');
  const isAtHome = mdPath.indexOf('/at-home/') === 0;
  const fetcher = async () => {
    const r = await upstream(target, { headers: { Accept: 'application/json', 'User-Agent': 'TheLedger/2.0' } }, 20000);
    const text = await r.text();
    const ctype = r.headers.get('content-type') || '';
    if (!/json/i.test(ctype) || r.status >= 500) return { status: 502, text: JSON.stringify({ result: 'error', errors: [{ detail: 'MangaDex returned HTTP ' + r.status + '. The API may be temporarily unavailable.' }] }), type: 'application/json; charset=utf-8' };
    return { status: r.status, text, type: 'application/json; charset=utf-8' };
  };
  try {
    if (isAtHome) { // per-reader signed base URL: never cache
      const e = await fetcher();
      return new Response(e.text, { status: e.status, headers: Object.assign({ 'Content-Type': e.type, 'Cache-Control': 'no-store' }, cors) });
    }
    const out = await swr(ctx, {
      kind: 'md', key: target, fresh: 600, stale: 21600, fetcher,
      cacheable: (r) => (r.status === 200 ? { stale: 21600 } : 0),
    });
    return new Response(out.entry.text, { status: out.entry.status, headers: Object.assign({ 'Content-Type': out.entry.type, 'Cache-Control': out.entry.status === 200 ? 'public, max-age=120' : 'no-store', 'X-Cache': out.state }, cors) });
  } catch (err) {
    return json({ result: 'error', errors: [{ detail: 'MangaDex unavailable' }] }, 502, cors);
  }
}

/* ───────────────────────────── warm-up ping (wakes a sleeping Render instance) ───────────────────────────── */

async function handleWarm(env, ctx) {
  const base = (env.ANIVEXA_API_URL || DEFAULT_API).replace(/\/+$/, '');
  const c = edgeCache();
  const key = edgeKey('warm', base);
  let recent = false;
  if (c) { try { recent = !!(await c.match(key)); } catch { /* ignore */ } }
  if (!recent) {
    ctx.waitUntil(upstream(base + '/', { headers: { Accept: 'application/json' } }, 55000).then((r) => r.text()).catch(() => {}));
    if (c) ctx.waitUntil(c.put(key, new Response('1', { headers: { 'Cache-Control': 'public, max-age=240' } })).catch(() => {}));
  }
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

/* ───────────────────────────── watch progress (D1) ───────────────────────────── */

function str(v, max) { return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null; }
function num(v, max) { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? n : null; }

async function handleProgress(request, env, url) {
  // The binding may be called "DB" or "ledger-db" depending on how it was added in the dashboard.
  const db = env.DB || env['ledger-db'] || env['ledger_db'];
  if (!db) return json({ error: 'D1 binding not found. Expected a binding named DB or ledger-db.' }, 500);
  const parts = url.pathname.split('/').filter(Boolean); // api, progress, [anilistId]
  try {
    if (request.method === 'GET') {
      const userId = str(url.searchParams.get('user'), 128);
      if (!userId) return json({ error: 'user required' }, 400);
      const id = url.searchParams.get('id');
      if (id) {
        const aid = num(id, 2147483647);
        if (!aid) return json({ error: 'bad id' }, 400);
        const row = await db.prepare('SELECT * FROM watch_progress WHERE user_id = ? AND anilist_id = ?').bind(userId, aid).first();
        return json({ item: row || null });
      }
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '30', 10) || 30));
      const { results } = await db.prepare('SELECT * FROM watch_progress WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?').bind(userId, limit).all();
      return json({ items: results || [] });
    }
    if (request.method === 'POST') {
      const raw = await request.text();
      if (raw.length > 4000) return json({ error: 'payload too large' }, 413);
      let b; try { b = JSON.parse(raw); } catch { return json({ error: 'invalid json' }, 400); }
      b = b || {};
      const userId = str(b.userId, 128);
      const anilistId = num(b.anilistId, 2147483647);
      const type = b.type === 'anime' || b.type === 'manga' ? b.type : null;
      const title = str(b.title, 300);
      if (!userId || !anilistId || !type || !title) return json({ error: 'missing fields' }, 400);
      const cover = typeof b.coverImage === 'string' && /^https:\/\//.test(b.coverImage) && b.coverImage.length <= 600 ? b.coverImage : null;
      const label = typeof b.episodeOrChapter === 'string' ? b.episodeOrChapter.slice(0, 60) : null;
      const pos = b.positionSeconds == null ? null : num(b.positionSeconds, 1e7);
      const dur = b.durationSeconds == null ? null : num(b.durationSeconds, 1e7);
      const page = b.pageIndex == null ? null : num(b.pageIndex, 100000);
      await db.prepare(`INSERT INTO watch_progress (user_id, anilist_id, type, title, cover_image, episode_or_chapter, position_seconds, duration_seconds, page_index, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(user_id, anilist_id) DO UPDATE SET type=excluded.type, title=excluded.title, cover_image=excluded.cover_image,
        episode_or_chapter=excluded.episode_or_chapter, position_seconds=excluded.position_seconds, duration_seconds=excluded.duration_seconds,
        page_index=excluded.page_index, updated_at=excluded.updated_at`)
        .bind(userId, anilistId, type, title, cover, label, pos, dur, page, Date.now()).run();
      return json({ ok: true });
    }
    if (request.method === 'DELETE') {
      const userId = str(url.searchParams.get('user'), 128);
      const aid = num(parts[2], 2147483647);
      if (!userId || !aid) return json({ error: 'missing fields' }, 400);
      await db.prepare('DELETE FROM watch_progress WHERE user_id = ? AND anilist_id = ?').bind(userId, aid).run();
      return json({ ok: true });
    }
    return json({ error: 'method not allowed' }, 405);
  } catch (err) {
    return json({ error: 'progress error: ' + String((err && err.message) || err) }, 500);
  }
}

/* ───────────────────────────── HTML shell ───────────────────────────── */

const BROWSE_MODES = ['top', 'popular', 'trending', 'seasonal', 'upcoming', 'manga', 'random'];

function matchPage(path) {
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path;
  let m;
  if (p === '/' || p === '/index.html') return { name: 'home' };
  if ((m = p.match(/^\/(detail|watch|read)\/(\d{1,9})$/))) return { name: m[1], id: m[2] };
  if ((m = p.match(/^\/browse\/([a-z]+)$/)) && BROWSE_MODES.indexOf(m[1]) >= 0) return { name: 'browse', mode: m[1] };
  if (p === '/search') return { name: 'search' };
  if (p === '/library') return { name: 'library' };
  return null;
}

function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function safeJsonForHtml(text) { return text.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }

async function handlePage(request, env, ctx, url) {
  const page = matchPage(url.pathname);
  const rt = { ctx, db: dbOf(env), fb: fbOn(env) };
  const a = assets();
  const cfg = {
    pk: env.CLERK_PUBLISHABLE_KEY || '',
    cu: (env.CLERK_FRONTEND_API_URL || '').replace(/\/+$/, ''),
    proxy: env.STREAM_PROXY_URL || DEFAULT_PROXY,
    refParam: env.STREAM_PROXY_REFERER_PARAM || '',
    v: a.v,
    nf: !page,
  };
  // Home data is the same for everyone: when the edge already has it, inline it so the first paint needs no round trip.
  let inline = '';
  if (page && page.name === 'home') {
    const hit = memGet(layerKey('home', 'home:v2')) || await edgeGet('home', 'home:v2');
    if (hit && hit.status === 200) {
      inline = '<script type="application/json" id="home-data">' + safeJsonForHtml(hit.text) + '</script>';
      if (hit.age > 600) ctx.waitUntil(loadHome(rt).catch(() => {}));
    } else {
      ctx.waitUntil(loadHome(rt).catch(() => {})); // warm for the next visitor
    }
  }
  const desc = 'Stream anime and read manga from one fast, ad-free index.';
  const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<title>' + SITE_NAME + ' — Anime &amp; Manga</title>' +
    '<meta name="description" content="' + desc + '"><meta name="theme-color" content="#0b1522"><meta name="color-scheme" content="dark">' +
    '<meta property="og:title" content="' + SITE_NAME + '"><meta property="og:description" content="' + desc + '"><meta property="og:type" content="website"><meta property="og:image" content="' + FAVICON + '">' +
    '<link rel="icon" type="image/png" href="' + FAVICON + '"><link rel="apple-touch-icon" href="' + FAVICON + '">' +
    '<link rel="preconnect" href="https://s4.anilist.co">' +
    '<style>html{background:#0b1522;color:#eef3f9;color-scheme:dark}body{margin:0;min-height:100vh;font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}#boot{position:fixed;inset:0;display:grid;place-items:center}#boot i{width:34px;height:34px;border-radius:50%;border:3px solid rgba(255,255,255,.15);border-top-color:#0a84ff;animation:b .8s linear infinite}@keyframes b{to{transform:rotate(360deg)}}</style>' +
    '<link rel="stylesheet" href="/_/app.css?v=' + a.v + '">' +
    '<script>window.__CFG=' + safeJsonForHtml(JSON.stringify(cfg)) + '</script>' +
    '<script defer src="/_/app.js?v=' + a.v + '"></script>' +
    '</head><body><div id="boot"><i></i></div><div id="app"></div>' + inline +
    '<noscript><p style="padding:24px">The Ledger needs JavaScript.</p></noscript></body></html>';
  return new Response(request.method === 'HEAD' ? null : html, {
    status: page ? 200 : 404,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  });
}

/* ───────────────────────────── static assets (versioned, immutable) ───────────────────────────── */

let ASSET_CACHE = null;
function assets() {
  if (!ASSET_CACHE) {
    // `__name` shim: wrangler/esbuild may inject __name() calls into function bodies (keep_names); the browser has no such helper.
    const js = '/* The Ledger client */\nvar __name=window.__name||function(f){return f};\n(' + clientApp.toString() + ')();\n';
    ASSET_CACHE = { js, css: APP_CSS, v: hash32(js + APP_CSS, 2166136261) };
  }
  return ASSET_CACHE;
}

function handleAsset(path, url) {
  const a = assets();
  const immutable = url.searchParams.get('v') === a.v;
  return new Response(path.endsWith('.js') ? a.js : a.css, {
    headers: {
      'Content-Type': path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/* ───────────────────────────── Backup sources: Jikan (MyAnimeList) + Kitsu ─────────────────────────────
 * AniList stays the main source. This code only runs when AniList cannot answer (the gate above is paused because of a
 * block / rate limit, or AniList is down) AND no saved AniList answer exists. Each page is then filled from Jikan or Kitsu,
 * whichever answers; if one is down or rate-limited the other is used. Results are reshaped to look exactly like AniList's
 * (same field names, AniList ids) so the site needs no special cases. As soon as AniList works again it is used again.
 *
 * Sites keep AniList ids, so MAL/Kitsu ids are translated with ARM (https://arm.haglund.dev, a free id-mapping service),
 * and Kitsu also lists AniList ids itself ("mappings"). Anime can use Jikan or Kitsu. Manga uses Kitsu only: ARM does not
 * map manga, and Kitsu is the one source here that knows manga AniList ids.
 *
 * Etiquette: every source has its own pacing, a per-minute budget (Jikan: 3/s and 60/min), 429/Retry-After handling and
 * a pause after repeated failures. Answers are cached (memory → edge → D1). Nothing here talks to AniList. */

const JIKAN_URL = 'https://api.jikan.moe/v4';
const KITSU_URL = 'https://kitsu.io/api/edge';
const ARM_URL = 'https://arm.haglund.dev/api/v2/ids';
const FB_UA = 'TheLedger/2.2 (+anime index; polite client)';
const FB_STEPS = [900, 3600, 21600]; // seconds, used when a source refuses us outright (403 / challenge page)
const FB_LIST_FRESH = 1800, FB_LIST_STALE = 3 * 86400; // list pages: fresh 30 min, usable for 3 days if the source is down
const FB_ITEM_FRESH = 6 * 3600, FB_ITEM_STALE = 14 * 86400;
const FB_ID_FRESH = 7 * 86400, FB_ID_STALE = 60 * 86400;

const SRC = {
  jikan: { name: 'jikan', label: 'Jikan', base: JIKAN_URL, gap: 450, perMin: 50, accept: 'application/json' },
  kitsu: { name: 'kitsu', label: 'Kitsu', base: KITSU_URL, gap: 300, perMin: 0, accept: 'application/vnd.api+json' },
  arm: { name: 'arm', label: 'ARM', base: ARM_URL, gap: 150, perMin: 0, accept: 'application/json' },
};
Object.keys(SRC).forEach((k) => Object.assign(SRC[k], { until: 0, level: 0, reason: '', fails: 0, next: 0, stamps: [], requests: 0, ok: 0, lastStatus: 0, lastAt: 0, lastMessage: '' }));
const FBX = { used: '', usedAt: 0, lastError: '' };

class SrcDown extends Error {
  constructor(src, reason, secs, msg) { super(msg || (SRC[src].label + ' is ' + reason)); this.name = 'SrcDown'; this.src = src; this.reason = reason; this.retryAfter = secs || 0; }
}
class SrcMissing extends Error { constructor(src) { super('not found'); this.name = 'SrcMissing'; this.src = src; } }
const isSrcErr = (e) => !!e && (e.name === 'SrcDown' || e.name === 'SrcMissing');
const srcLeft = (S) => Math.max(0, Math.ceil((S.until - Date.now()) / 1000));
function srcOpen(S, reason, secs, msg) { S.reason = reason; S.until = Date.now() + secs * 1000; S.lastMessage = String(msg || '').slice(0, 160); }

/** The one door to Jikan / Kitsu / ARM: pacing, per-minute budget, 429 + block handling. Resolves {status,text,type}. */
async function srcFetch(S, url, init) {
  const now = Date.now();
  if (now < S.until) throw new SrcDown(S.name, S.reason, srcLeft(S));
  if (S.perMin) {
    S.stamps = S.stamps.filter((t) => now - t < 60000);
    if (S.stamps.length >= S.perMin) throw new SrcDown(S.name, 'limited', Math.max(1, Math.ceil((S.stamps[0] + 60000 - now) / 1000)));
  }
  if (S.next > now + 8000 + S.gap) S.next = now; // clock moved backwards
  const slot = Math.max(now, S.next);
  if (slot - now > 8000) throw new SrcDown(S.name, 'queued', 5);
  S.next = slot + S.gap;
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  if (Date.now() < S.until) throw new SrcDown(S.name, S.reason, srcLeft(S));
  S.stamps.push(Date.now()); S.requests++;
  let r, text;
  try {
    r = await upstream(url, Object.assign({}, init || {}, { headers: Object.assign({ Accept: S.accept, 'User-Agent': FB_UA }, (init && init.headers) || {}) }), 12000);
    text = await r.text();
  } catch (err) {
    S.lastStatus = 0; S.lastAt = Date.now(); S.lastMessage = 'network error';
    if (++S.fails >= 3) { S.fails = 0; srcOpen(S, 'unavailable', 60, 'network errors'); }
    throw new SrcDown(S.name, 'unavailable', 5);
  }
  S.lastStatus = r.status; S.lastAt = Date.now();
  const json = /json/i.test(r.headers.get('content-type') || '') && /^\s*[\[{]/.test(text);
  S.lastMessage = r.status === 200 && json ? 'ok' : String(text).replace(/\s+/g, ' ').slice(0, 160);
  if (r.status === 429) {
    const secs = Math.min(Math.max(Number(r.headers.get('retry-after')) || 60, 5), 900);
    srcOpen(S, 'limited', secs, '429 Too Many Requests');
    throw new SrcDown(S.name, 'limited', secs);
  }
  if (r.status === 403 || (r.status === 503 && !json) || (r.status === 200 && !json && /^\s*</.test(text))) { // refused, or a challenge/HTML page instead of JSON
    S.level = Math.min(S.level + 1, FB_STEPS.length);
    srcOpen(S, 'blocked', FB_STEPS[S.level - 1], 'HTTP ' + r.status);
    throw new SrcDown(S.name, 'blocked', FB_STEPS[S.level - 1]);
  }
  if (r.status >= 500) { if (++S.fails >= 3) { S.fails = 0; srcOpen(S, 'unavailable', 60, 'HTTP ' + r.status); } }
  else S.fails = 0;
  if (r.status === 200 && json) { S.ok++; S.level = 0; }
  return { status: r.status, text, type: 'application/json; charset=utf-8' };
}

function srcParse(key, e) {
  const S = SRC[key];
  if (e.status === 404) throw new SrcMissing(key);
  if (e.status !== 200) throw new SrcDown(key, 'error', 30, S.label + ' answered HTTP ' + e.status);
  try { return JSON.parse(e.text); } catch { throw new SrcDown(key, 'error', 30, S.label + ' sent an unreadable answer'); }
}

/** JSON straight from a backup source, no cache (the caller caches the small, reshaped result instead). */
async function srcGet(key, path) { return srcParse(key, await srcFetch(SRC[key], SRC[key].base + path)); }

/** Cached JSON from a backup source (memory → edge → D1; an old copy is served if the source is failing). */
async function srcJson(rt, key, path, fresh, stale, init) {
  const S = SRC[key], url = S.base + path;
  const out = await swr(rt.ctx, {
    kind: 'fb-' + key, key: (init && init.body ? 'POST ' + init.body + ' ' : '') + url, fresh, stale, db: rt.db,
    fetcher: () => srcFetch(S, url, init),
    cacheable: (r) => (r.status === 200 && /^\s*[\[{]/.test(r.text) ? { stale } : 0),
  });
  return srcParse(key, out.entry);
}

/** Backup sources can be switched off with the BACKUP_SOURCES=off variable. */
function fbOn(env) { return !/^(off|0|false|no|disabled)$/i.test(String((env && env.BACKUP_SOURCES) || '')); }

/** Sources in the order to try them: the healthy one first (Jikan by default; Kitsu when Jikan is paused or has a long queue). */
function fbOrder() {
  const now = Date.now();
  const jikanBad = now < SRC.jikan.until || SRC.jikan.next - now > 3000;
  const kitsuBad = now < SRC.kitsu.until || SRC.kitsu.next - now > 3000;
  return jikanBad && !kitsuBad ? ['kitsu', 'jikan'] : ['jikan', 'kitsu'];
}
function fbStatus() {
  const one = (S) => ({ state: srcLeft(S) ? S.reason : 'ok', pausedForSeconds: srcLeft(S), requests: S.requests, ok: S.ok, lastStatus: S.lastStatus, lastMessage: S.lastMessage, lastAt: S.lastAt ? new Date(S.lastAt).toISOString() : null });
  return { jikan: one(SRC.jikan), kitsu: one(SRC.kitsu), armIds: one(SRC.arm), lastUsed: FBX.used || null, lastUsedAt: FBX.usedAt ? new Date(FBX.usedAt).toISOString() : null, lastError: FBX.lastError || null };
}

/* ───────────── id translation (ARM) ───────────── */

const ARMMEM = new Map(); // 'myanimelist:21' → {v: anilistId | 0, at}
const qs = (o) => Object.keys(o).filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== '').map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(o[k])).replace(/%2C/g, ',')).join('&');

/** source = 'myanimelist' | 'kitsu'. Returns Map(sourceId → anilistId); ids ARM does not know are left out. */
async function armToAniList(rt, source, ids) {
  const out = new Map(), need = [], now = Date.now();
  Array.from(new Set(ids.map(Number).filter((n) => n > 0))).forEach((id) => {
    const h = ARMMEM.get(source + ':' + id);
    if (h && now - h.at < FB_ID_FRESH * 1000) { if (h.v) out.set(id, h.v); } else need.push(id);
  });
  for (let i = 0; i < need.length; i += 40) {
    const chunk = need.slice(i, i + 40);
    const arr = await srcJson(rt, 'arm', '', FB_ID_FRESH, FB_ID_STALE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(chunk.map((id) => ({ [source]: id }))) });
    if (!Array.isArray(arr)) throw new SrcDown('arm', 'error', 30, 'ARM sent an unexpected answer');
    if (ARMMEM.size > 6000) ARMMEM.clear();
    chunk.forEach((id, k) => {
      const v = arr[k] && Number(arr[k].anilist) > 0 ? Number(arr[k].anilist) : 0;
      ARMMEM.set(source + ':' + id, { v, at: Date.now() });
      if (v) out.set(id, v);
    });
  }
  return out;
}

/** AniList anime id → {myanimelist, kitsu, …} (or null when ARM has no such anime, e.g. it is a manga). */
async function armFromAniList(rt, anilistId) {
  try {
    const j = await srcJson(rt, 'arm', '?' + qs({ source: 'anilist', id: anilistId }), FB_ID_FRESH, FB_ID_STALE);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch (e) { if (e && e.name === 'SrcMissing') return null; throw e; }
}

/* ───────────── Jikan → AniList shape ───────────── */

const JK_FORMAT = { TV: 'TV', Movie: 'MOVIE', OVA: 'OVA', ONA: 'ONA', Special: 'SPECIAL', 'TV Special': 'SPECIAL', Music: 'MUSIC', CM: 'SPECIAL', PV: 'SPECIAL',
  Manga: 'MANGA', Novel: 'NOVEL', 'Light Novel': 'NOVEL', 'One-shot': 'ONE_SHOT', Doujinshi: 'MANGA', Manhwa: 'MANGA', Manhua: 'MANGA', OEL: 'MANGA' };
const JK_STATUS = { 'Finished Airing': 'FINISHED', 'Currently Airing': 'RELEASING', 'Not yet aired': 'NOT_YET_RELEASED', Finished: 'FINISHED', Publishing: 'RELEASING', 'On Hiatus': 'HIATUS', Discontinued: 'CANCELLED', 'Not yet published': 'NOT_YET_RELEASED' };
const JK_REL = { Sequel: 'SEQUEL', Prequel: 'PREQUEL', 'Side Story': 'SIDE_STORY', 'Parent Story': 'PARENT', 'Alternative Version': 'ALTERNATIVE', 'Alternative Setting': 'ALTERNATIVE', 'Spin-off': 'SPIN_OFF', Summary: 'SUMMARY', 'Full Story': 'PARENT', Adaptation: 'ADAPTATION', Character: 'CHARACTER', Other: 'OTHER' };
const JK_FORMAT_Q = { TV: 'tv', MOVIE: 'movie', OVA: 'ova', ONA: 'ona', SPECIAL: 'special', MUSIC: 'music' };
const JK_ORDER = { POPULARITY_DESC: 'members', SCORE_DESC: 'score', TRENDING_DESC: 'members', FAVOURITES_DESC: 'favorites', START_DATE_DESC: 'start_date' };

const dateObj = (p) => ({ year: (p && p.year) || null, month: (p && p.month) || null, day: (p && p.day) || null });
const seasonOfMonth = (m) => (m <= 3 ? 'WINTER' : m <= 6 ? 'SPRING' : m <= 9 ? 'SUMMER' : 'FALL');
function minutesOf(text) {
  const s = String(text || ''), h = /(\d+)\s*hr/.exec(s), m = /(\d+)\s*min/.exec(s);
  return h || m ? (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0) : null;
}
function cleanSynopsis(t) {
  if (!t) return null;
  let s = String(t).replace(/\r\n/g, '\n');
  const i = s.lastIndexOf('[Written by MAL Rewrite]');
  if (i >= 0 && !s.slice(i + 24).trim()) s = s.slice(0, i);
  s = s.trim();
  return s || null;
}

/** One Jikan anime/manga object → AniList-shaped media (id = 0 until the AniList id is known). */
function jikanMedia(a, kind) {
  const manga = kind === 'manga';
  const span = (manga ? a.published : a.aired) || {};
  const sd = dateObj(span.prop && span.prop.from), ed = dateObj(span.prop && span.prop.to);
  let season = a.season ? String(a.season).toUpperCase() : null, seasonYear = a.year || null;
  if (!manga && !season && sd.year && sd.month) { season = seasonOfMonth(sd.month); seasonYear = sd.year; }
  const im = (a.images && (a.images.jpg || a.images.webp)) || {};
  const big = im.large_image_url || im.image_url || null;
  const genres = (a.genres || []).map((g) => (g.name === 'Suspense' ? 'Thriller' : g.name));
  const tags = (a.themes || []).concat(a.demographics || []).map((g) => ({ name: g.name, rank: 50, isMediaSpoiler: false }));
  const adult = (a.explicit_genres || []).length > 0 || /^Rx/i.test(a.rating || '');
  return {
    id: 0, idMal: a.mal_id || null, type: manga ? 'MANGA' : 'ANIME', format: JK_FORMAT[a.type] || (manga ? 'MANGA' : null), status: JK_STATUS[a.status] || null,
    season, seasonYear, episodes: manga ? null : (a.episodes == null ? null : a.episodes), chapters: manga ? (a.chapters == null ? null : a.chapters) : null, volumes: manga ? (a.volumes == null ? null : a.volumes) : null,
    duration: manga ? null : minutesOf(a.duration), averageScore: a.score ? Math.round(a.score * 10) : null, meanScore: a.score ? Math.round(a.score * 10) : null,
    popularity: a.members || null, favourites: a.favorites || null, genres, source: a.source ? String(a.source).toUpperCase().replace(/[^A-Z0-9]+/g, '_') : null,
    countryOfOrigin: 'JP', isAdult: adult, description: cleanSynopsis(a.synopsis), bannerImage: null,
    coverImage: { medium: im.image_url || big, large: big, extraLarge: big, color: null },
    title: { romaji: a.title || null, english: a.title_english || null, native: a.title_japanese || null }, synonyms: a.title_synonyms || [],
    startDate: sd, endDate: ed, studios: { nodes: (a.studios || []).map((s) => ({ name: s.name })) },
    trailer: a.trailer && a.trailer.youtube_id ? { id: a.trailer.youtube_id, site: 'youtube' } : null, nextAiringEpisode: null,
    tags, relations: { edges: [] }, recommendations: { nodes: [] },
  };
}

/* ───────────── Kitsu → AniList shape ───────────── */

const KT_ANIME_FORMAT = { tv: 'TV', ova: 'OVA', ona: 'ONA', movie: 'MOVIE', special: 'SPECIAL', music: 'MUSIC' };
const KT_MANGA_FORMAT = { manga: 'MANGA', manhwa: 'MANGA', manhua: 'MANGA', doujin: 'MANGA', oel: 'MANGA', novel: 'NOVEL', oneshot: 'ONE_SHOT' };
const KT_STATUS = { finished: 'FINISHED', current: 'RELEASING', upcoming: 'NOT_YET_RELEASED', unreleased: 'NOT_YET_RELEASED', tba: 'NOT_YET_RELEASED' };
const KT_REL = { sequel: 'SEQUEL', prequel: 'PREQUEL', side_story: 'SIDE_STORY', parent_story: 'PARENT', spinoff: 'SPIN_OFF', adaptation: 'ADAPTATION', alternative_setting: 'ALTERNATIVE', alternative_version: 'ALTERNATIVE', summary: 'SUMMARY', full_story: 'PARENT', character: 'CHARACTER', other: 'OTHER' };
const KT_ANIME_SUBTYPE = { TV: 'TV', MOVIE: 'movie', OVA: 'OVA', ONA: 'ONA', SPECIAL: 'special', MUSIC: 'music' };
const KT_MANGA_SUBTYPE = { MANGA: 'manga,manhwa,manhua,doujin,oel', NOVEL: 'novel', ONE_SHOT: 'oneshot' };
const KT_GENRE = { 'Science Fiction': 'Sci-Fi' };
const parseYmd = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? { year: +m[1], month: +m[2], day: +m[3] } : { year: null, month: null, day: null }; };

function jsonApiIndex(j) {
  const inc = new Map();
  ((j && j.included) || []).forEach((x) => { if (x && x.type) inc.set(x.type + ':' + x.id, x); });
  return inc;
}
const relIds = (res, name) => ((res.relationships && res.relationships[name] && res.relationships[name].data) || []);

/** The AniList id Kitsu lists for this record (needs `include=mappings`), or 0. */
function kitsuAniId(res, inc, kind) {
  const want = 'anilist/' + kind;
  for (const ref of relIds(res, 'mappings')) {
    const m = inc.get('mappings:' + ref.id);
    if (m && m.attributes && m.attributes.externalSite === want && Number(m.attributes.externalId) > 0) return Number(m.attributes.externalId);
  }
  return 0;
}

function kitsuMedia(res, kind, inc) {
  const a = res.attributes || {}, t = a.titles || {}, p = a.posterImage || {}, c = a.coverImage || {};
  const manga = kind === 'manga', sd = parseYmd(a.startDate), ed = parseYmd(a.endDate);
  const sub = String(a.subtype || '').toLowerCase();
  const genres = relIds(res, 'genres').map((r) => { const g = inc.get('genres:' + r.id); return g && g.attributes && g.attributes.name ? (KT_GENRE[g.attributes.name] || g.attributes.name) : null; }).filter(Boolean);
  const tags = relIds(res, 'categories').map((r) => { const g = inc.get('categories:' + r.id); return g && g.attributes && g.attributes.title ? { name: g.attributes.title, rank: 50, isMediaSpoiler: false } : null; }).filter(Boolean);
  const big = p.large || p.medium || p.original || null;
  const rating = a.averageRating ? Math.round(Number(a.averageRating)) : null;
  return {
    id: 0, idMal: null, type: manga ? 'MANGA' : 'ANIME', format: (manga ? KT_MANGA_FORMAT : KT_ANIME_FORMAT)[sub] || (manga ? 'MANGA' : null), status: KT_STATUS[a.status] || null,
    season: !manga && sd.month ? seasonOfMonth(sd.month) : null, seasonYear: !manga ? sd.year : null,
    episodes: manga ? null : (a.episodeCount == null ? null : a.episodeCount), chapters: manga ? (a.chapterCount == null ? null : a.chapterCount) : null, volumes: manga ? (a.volumeCount == null ? null : a.volumeCount) : null,
    duration: manga ? null : (a.episodeLength == null ? null : a.episodeLength), averageScore: rating > 0 ? rating : null, meanScore: rating > 0 ? rating : null,
    popularity: a.userCount || null, favourites: a.favoritesCount || null, genres, source: null, countryOfOrigin: sub === 'manhwa' ? 'KR' : sub === 'manhua' ? 'CN' : 'JP',
    isAdult: !!a.nsfw || a.ageRating === 'R18', description: a.description || a.synopsis || null, bannerImage: c.large || c.original || null,
    coverImage: { medium: p.small || p.medium || big, large: big, extraLarge: p.original || big, color: null },
    title: { romaji: t.en_jp || a.canonicalTitle || t.en || null, english: t.en || t.en_us || null, native: t.ja_jp || null }, synonyms: a.abbreviatedTitles || [],
    startDate: sd, endDate: ed, studios: { nodes: [] }, trailer: a.youtubeVideoId ? { id: a.youtubeVideoId, site: 'youtube' } : null, nextAiringEpisode: null,
    tags, relations: { edges: [] }, recommendations: { nodes: [] },
  };
}

/* ───────────── lists (browse, search, suggestions, home rails) ───────────── */

let JK_GENRES = null; // name(lowercase) → id, loaded once per instance (cached 7 days underneath)
async function jikanGenreId(rt, name) {
  const want = String(name).toLowerCase().replace('thriller', 'suspense');
  if (!JK_GENRES) {
    const map = {};
    for (const f of ['genres', 'themes']) {
      const j = await srcJson(rt, 'jikan', '/genres/anime?' + qs({ filter: f }), 7 * 86400, 60 * 86400);
      ((j && j.data) || []).forEach((g) => { if (g && g.name && g.mal_id) map[String(g.name).toLowerCase()] = g.mal_id; });
    }
    JK_GENRES = map;
  }
  return JK_GENRES[want] || 0;
}

/** o = {kind:'ANIME'|'MANGA', format, season, year, search, genre, sort, page, per} → {items, hasNext}. */
async function jikanList(rt, o) {
  const page = o.page || 1, limit = Math.min(o.per || 25, 25), fmt = JK_FORMAT_Q[o.format];
  let path, q = { page, limit, sfw: 'true' }, sortMembers = false;
  if (o.season && o.year) { path = '/seasons/' + Number(o.year) + '/' + String(o.season).toLowerCase(); if (fmt) q.filter = fmt; sortMembers = true; }
  else if (o.search || o.genre) {
    path = '/anime';
    if (o.search) q.q = o.search;
    if (fmt) q.type = fmt;
    if (o.genre) { const gid = await jikanGenreId(rt, o.genre); if (!gid) return { items: [], hasNext: false }; q.genres = gid; }
    if (o.sort && o.sort !== 'SEARCH_MATCH' && JK_ORDER[o.sort]) { q.order_by = JK_ORDER[o.sort]; q.sort = 'desc'; }
  } else {
    path = '/top/anime';
    if (fmt) q.type = fmt;
    if (o.sort === 'TRENDING_DESC') q.filter = 'airing'; else if (o.sort === 'POPULARITY_DESC') q.filter = 'bypopularity';
  }
  const j = await srcGet('jikan', path + '?' + qs(q));
  const seen = new Set(), rows = [];
  ((j && j.data) || []).forEach((a) => { if (a && a.mal_id && !seen.has(a.mal_id)) { seen.add(a.mal_id); rows.push(a); } });
  const ids = await armToAniList(rt, 'myanimelist', rows.map((a) => a.mal_id));
  let items = [];
  rows.forEach((a) => { const id = ids.get(a.mal_id); if (id) { const m = jikanMedia(a, 'anime'); m.id = id; if (!m.isAdult) items.push(m); } });
  if (sortMembers) items.sort((x, y) => (y.popularity || 0) - (x.popularity || 0));
  return { items: items.slice(0, o.per || 25), hasNext: !!(j && j.pagination && j.pagination.has_next_page) };
}

function kitsuListParams(o, limit, page) {
  const manga = o.kind === 'MANGA';
  const p = { 'page[limit]': limit, 'page[offset]': (page - 1) * limit, include: 'mappings', 'fields[mappings]': 'externalSite,externalId' };
  const sub = (manga ? KT_MANGA_SUBTYPE : KT_ANIME_SUBTYPE)[o.format];
  if (sub) p['filter[subtype]'] = sub;
  if (o.search) p['filter[text]'] = o.search;
  if (o.genre) p['filter[categories]'] = String(o.genre).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (o.season && o.year && !manga) { p['filter[season]'] = String(o.season).toLowerCase(); p['filter[seasonYear]'] = Number(o.year); }
  switch (o.sort) {
    case 'TRENDING_DESC': p['filter[status]'] = 'current'; p.sort = '-userCount'; break;
    case 'SCORE_DESC': p.sort = '-averageRating'; p['filter[averageRating]'] = '60..'; p['filter[userCount]'] = '3000..'; break;
    case 'POPULARITY_DESC': p.sort = '-userCount'; break;
    case 'SEARCH_MATCH': break;
    default: p.sort = '-userCount';
  }
  return p;
}

async function kitsuList(rt, o) {
  const limit = Math.min(o.per || 20, 20), page = o.page || 1, manga = o.kind === 'MANGA', kind = manga ? 'manga' : 'anime';
  const j = await srcGet('kitsu', '/' + kind + '?' + qs(kitsuListParams(o, limit, page)));
  const inc = jsonApiIndex(j), items = [], loose = [];
  ((j && j.data) || []).forEach((res) => {
    const m = kitsuMedia(res, kind, inc);
    if (m.isAdult) return;
    const id = kitsuAniId(res, inc, kind);
    if (id) { m.id = id; items.push(m); } else loose.push({ res, m });
  });
  if (loose.length && !manga) { // no AniList id listed by Kitsu: ask ARM (anime only)
    try {
      const ids = await armToAniList(rt, 'kitsu', loose.map((x) => Number(x.res.id)));
      loose.forEach((x) => { const id = ids.get(Number(x.res.id)); if (id) { x.m.id = id; items.push(x.m); } });
    } catch (e) { if (!isSrcErr(e)) throw e; }
  }
  return { items, hasNext: !!(j && j.links && j.links.next) };
}

/** Try the sources in order; the first one that answers wins. Manga is Kitsu only. */
async function fbListRaw(rt, o) {
  const chain = o.kind === 'MANGA' ? ['kitsu'] : fbOrder();
  let last = null;
  for (const s of chain) {
    try { const r = await (s === 'jikan' ? jikanList(rt, o) : kitsuList(rt, o)); r.source = s; return r; }
    catch (e) { if (!isSrcErr(e)) throw e; last = e; }
  }
  throw last || new SrcDown('kitsu', 'unavailable', 30);
}

/** "Just aired": Jikan's recent-episodes feed; Kitsu has no schedule, so it shows what is airing now. */
async function fbRecentRaw(rt) {
  const tryJikan = async () => {
    const j = await srcGet('jikan', '/watch/episodes');
    const rows = ((j && j.data) || []).filter((x) => x && x.entry && x.entry.mal_id);
    const ids = await armToAniList(rt, 'myanimelist', rows.map((x) => x.entry.mal_id));
    const items = [];
    rows.forEach((x) => {
      const id = ids.get(x.entry.mal_id); if (!id) return;
      const ep = x.episodes && x.episodes[0] || {};
      const n = /episode\/(\d+)/.exec(ep.url || '') || /(\d+)/.exec(ep.title || '');
      const m = jikanMedia(x.entry, 'anime'); m.id = id;
      items.push({ episode: n ? Number(n[1]) : null, airingAt: 0, media: m });
    });
    return { items, hasNext: false, source: 'jikan' };
  };
  const tryKitsu = async () => {
    const r = await kitsuList(rt, { kind: 'ANIME', sort: 'TRENDING_DESC', per: 20, page: 2 });
    return { items: r.items.map((m) => ({ episode: null, airingAt: 0, media: m })), hasNext: false, source: 'kitsu' };
  };
  let last = null;
  for (const s of fbOrder()) {
    try { const r = await (s === 'jikan' ? tryJikan() : tryKitsu()); if (r.items.length) return r; }
    catch (e) { if (!isSrcErr(e)) throw e; last = e; }
  }
  throw last || new SrcDown('kitsu', 'unavailable', 30);
}

/* The reshaped answers (small) are what gets cached: a rebuild never has to re-read the big Jikan / Kitsu bodies, and an old
 * copy is served if both sources are down. */
const fbKey = (o) => JSON.stringify([o.kind, o.format || '', o.season || '', o.year || 0, o.search || '', o.genre || '', o.sort || '', o.page || 1, o.per || 0]);
async function fbCached(rt, key, run) {
  const out = await swr(rt.ctx, {
    kind: 'fbl', key, fresh: FB_LIST_FRESH, stale: FB_LIST_STALE, db: rt.db,
    fetcher: async () => { const r = await run(); return { status: r.items.length ? 200 : 204, text: JSON.stringify(r), type: 'application/json; charset=utf-8' }; },
    cacheable: (r) => (r.status === 200 ? { stale: FB_LIST_STALE } : 0),
  });
  return out.entry.status === 200 ? JSON.parse(out.entry.text) : { items: [], hasNext: false, source: '' };
}
/** Look in the caches only (no network): {text, age} or null. */
async function fbPeek(rt, key) {
  const lk = layerKey('fbl', key);
  let hit = memGet(lk);
  if (!hit) { hit = await edgeGet('fbl', key); if (hit) memPut(lk, hit, Date.now() - hit.age * 1000, Math.max(1, FB_LIST_STALE - hit.age)); }
  if (!hit && rt.db) { const row = await dbGet(rt.db, lk); if (row) { hit = row; memPut(lk, row, row.at, Math.max(1, FB_LIST_STALE - row.age)); } }
  return hit && hit.status === 200 && hit.age < FB_LIST_STALE ? hit : null;
}
const fbList = (rt, o) => fbCached(rt, fbKey(o), () => fbListRaw(rt, o));

function fbHomeDefs(now) {
  const v = homeVars(now);
  const L = (key, o, wrap) => ({ key, ck: fbKey(o), run: (rt) => fbListRaw(rt, o), wrap: wrap || ((r) => ({ media: r.items })) });
  return [ // most visible first: the first screen needs trending, recent and top
    L('trending', { kind: 'ANIME', sort: 'TRENDING_DESC', per: 20 }),
    { key: 'recent', ck: 'recent', run: (rt) => fbRecentRaw(rt), wrap: (r) => ({ airingSchedules: r.items }) },
    L('top', { kind: 'ANIME', sort: 'SCORE_DESC', per: 10 }),
    L('season', { kind: 'ANIME', season: v.season, year: v.year, sort: 'POPULARITY_DESC', per: 20 }),
    L('popular', { kind: 'ANIME', sort: 'POPULARITY_DESC', per: 20 }),
    L('upcoming', { kind: 'ANIME', season: v.nSeason, year: v.nYear, sort: 'POPULARITY_DESC', per: 16 }),
    L('manga', { kind: 'MANGA', format: 'MANGA', sort: 'SCORE_DESC', per: 20 }),
    L('trendingManga', { kind: 'MANGA', sort: 'TRENDING_DESC', per: 16 }),
  ];
}
const FB_HOME_STEP = 3; // rails fetched from Jikan / Kitsu per request: keeps each request's CPU small (Workers free plan: 10 ms). The page asks again for the rest.

/** The home rails from the backup sources, a few rails per request; rails already saved are reused. */
async function fbHome(rt) {
  const defs = fbHomeDefs(Date.now());
  const peeks = await Promise.all(defs.map((d) => fbPeek(rt, d.ck)));
  const data = {}, used = new Set();
  let last = null, building = 0, pending = 0;
  await Promise.all(defs.map(async (d, i) => {
    const p = peeks[i];
    try {
      let r;
      if (p && p.age < FB_LIST_FRESH) r = JSON.parse(p.text);                                     // saved and fresh
      else if (building < FB_HOME_STEP) { building++; r = await fbCached(rt, d.ck, () => d.run(rt)); } // fetch (or refresh) now
      else if (p) r = JSON.parse(p.text);                                                          // old copy now, refreshed on a later request
      else { pending++; return; }                                                                  // not built yet: next request
      if (r.items && r.items.length) { data[d.key] = d.wrap(r); if (r.source) used.add(r.source); }
    } catch (e) { if (!isSrcErr(e)) throw e; last = e; }
  }));
  if (!Object.keys(data).length) throw last || new SrcDown('kitsu', 'unavailable', 30);
  const source = Array.from(used).sort().join('+');
  if (source) { FBX.used = source; FBX.usedAt = Date.now(); }
  return { data, source, partial: Object.keys(data).length < defs.length, more: pending > 0 };
}

/* ───────────── one title (detail / watch / read pages) ───────────── */

async function jikanDetail(rt, malId) {
  const j = await srcJson(rt, 'jikan', '/anime/' + malId + '/full', FB_ITEM_FRESH, FB_ITEM_STALE);
  if (!j || !j.data) throw new SrcMissing('jikan');
  const m = jikanMedia(j.data, 'anime');
  const rels = ((j.data.relations) || []).map((r) => ({ type: JK_REL[r.relation] || 'OTHER', entries: (r.entry || []).filter((e) => e && e.type === 'anime' && e.mal_id) }));
  const wanted = [];
  rels.forEach((r) => r.entries.forEach((e) => wanted.push(e.mal_id)));
  if (wanted.length) {
    let ids = new Map();
    try { ids = await armToAniList(rt, 'myanimelist', wanted); } catch (e) { if (!isSrcErr(e)) throw e; } // relations are optional
    rels.forEach((r) => r.entries.forEach((e) => {
      const id = ids.get(e.mal_id); if (!id) return;
      m.relations.edges.push({ relationType: r.type, node: { id, type: 'ANIME', format: null, status: null, seasonYear: null, averageScore: null, episodes: null, chapters: null, title: { romaji: e.name || null, english: null }, coverImage: { large: null, color: null } } });
    }));
  }
  return m;
}

const KT_INCLUDE = { include: 'genres,categories,mediaRelationships.destination,mappings', 'fields[mappings]': 'externalSite,externalId', 'fields[categories]': 'title', 'fields[genres]': 'name' };

/** Kitsu id for an AniList id, via Kitsu's own mappings (used for manga, and for anime when ARM is down). */
async function kitsuIdByAniList(rt, id, kinds) {
  for (const kind of kinds) {
    try {
      const j = await srcJson(rt, 'kitsu', '/mappings?' + qs({ 'filter[externalSite]': 'anilist/' + kind, 'filter[externalId]': id, include: 'item', 'fields[mappings]': 'externalSite,externalId' }), FB_ID_FRESH, FB_ID_STALE);
      const row = j && j.data && j.data[0];
      const item = row && row.relationships && row.relationships.item && row.relationships.item.data;
      if (item && item.id && (item.type === 'anime' || item.type === 'manga')) return { kind: item.type, kid: item.id };
    } catch (e) { if (!(e && e.name === 'SrcMissing')) throw e; }
  }
  return null;
}

async function kitsuDetail(rt, id, kind, kid) {
  const j = await srcJson(rt, 'kitsu', '/' + kind + '/' + kid + '?' + qs(KT_INCLUDE), FB_ITEM_FRESH, FB_ITEM_STALE);
  if (!j || !j.data) throw new SrcMissing('kitsu');
  const inc = jsonApiIndex(j), m = kitsuMedia(j.data, kind, inc);
  m.id = id;
  const edges = [];
  relIds(j.data, 'mediaRelationships').forEach((ref) => {
    const mr = inc.get('mediaRelationships:' + ref.id);
    const dst = mr && mr.relationships && mr.relationships.destination && mr.relationships.destination.data;
    const res = dst && inc.get(dst.type + ':' + dst.id);
    if (res && (dst.type === 'anime' || dst.type === 'manga')) edges.push({ role: mr.attributes && mr.attributes.role, res, kind: dst.type });
  });
  if (edges.length) {
    const ids = new Map();
    try {
      const animeIds = edges.filter((e) => e.kind === 'anime').map((e) => Number(e.res.id));
      if (animeIds.length) (await armToAniList(rt, 'kitsu', animeIds)).forEach((v, k) => ids.set('anime:' + k, v));
    } catch (e) { if (!isSrcErr(e)) throw e; }
    try {
      const mangaIds = edges.filter((e) => e.kind === 'manga').map((e) => e.res.id);
      if (mangaIds.length) {
        const mj = await srcJson(rt, 'kitsu', '/manga?' + qs({ 'filter[id]': mangaIds.join(','), include: 'mappings', 'fields[mappings]': 'externalSite,externalId', 'page[limit]': 20 }), FB_ITEM_FRESH, FB_ITEM_STALE);
        const minc = jsonApiIndex(mj);
        ((mj && mj.data) || []).forEach((r) => { const a = kitsuAniId(r, minc, 'manga'); if (a) ids.set('manga:' + r.id, a); });
      }
    } catch (e) { if (!isSrcErr(e)) throw e; }
    edges.forEach((e) => {
      const aid = ids.get(e.kind + ':' + e.res.id); if (!aid) return;
      const n = kitsuMedia(e.res, e.kind, inc); n.id = aid;
      m.relations.edges.push({ relationType: KT_REL[e.role] || 'OTHER', node: { id: n.id, type: n.type, format: n.format, status: n.status, seasonYear: n.seasonYear, averageScore: n.averageScore, episodes: n.episodes, chapters: n.chapters, title: n.title, coverImage: { large: n.coverImage.large, color: null } } });
    });
  }
  return m;
}

/** Full media record for an AniList id, or null when no backup source knows it. Throws SrcDown when none can be reached. */
async function fbDetail(rt, id) {
  let arm = null, armDown = false;
  try { arm = await armFromAniList(rt, id); } catch (e) { if (!isSrcErr(e)) throw e; armDown = true; }
  const isAnime = !!(arm && Number(arm.myanimelist) > 0), kitsuId = arm && Number(arm.kitsu) > 0 ? String(arm.kitsu) : '';
  const order = fbOrder();
  let last = null, missing = true;
  for (const s of order) {
    try {
      if (s === 'jikan') {
        if (!isAnime) continue;
        const m = await jikanDetail(rt, Number(arm.myanimelist)); m.id = id; return { media: m, source: 'jikan' };
      }
      let kind = 'anime', kid = kitsuId;
      if (!kid) { const f = await kitsuIdByAniList(rt, id, isAnime ? ['anime'] : ['anime', 'manga']); if (!f) continue; kind = f.kind; kid = f.kid; }
      return { media: await kitsuDetail(rt, id, kind, kid), source: 'kitsu' };
    } catch (e) {
      if (!isSrcErr(e)) throw e;
      last = e; if (e.name === 'SrcDown') missing = false;
    }
  }
  if (last && !missing) throw last;
  if (armDown && !last) throw new SrcDown('arm', 'unavailable', 30);
  return null;
}

/* ───────────── GraphQL shapes the site sends ───────────── */

function parseGqlShape(q, vars) {
  const aliases = Array.from(q.matchAll(/(\w+):Media\(id:(\d+)\)/g));
  if (aliases.length) return { shape: 'batch', items: aliases.slice(0, 14).map((m) => [m[1], Number(m[2])]) };
  if (/\bMedia\(id:\$id\)/.test(q) && Number(vars.id) > 0) return { shape: 'detail', id: Number(vars.id) };
  const m = /Page\(page:(\$\w+|\d+),perPage:(\d+)\)\s*\{\s*(?:pageInfo\s*\{\s*hasNextPage\s*\}\s*)?media\(([^)]*)\)\s*\{/.exec(q);
  if (!m) return null;
  const val = (t) => (t[0] === '$' ? vars[t.slice(1)] : t);
  const o = { shape: 'list', kind: 'ALL', page: Math.min(Math.max(Math.floor(Number(val(m[1]))) || 1, 1), 200), per: Math.min(Number(m[2]) || 20, 50), sort: 'POPULARITY_DESC' };
  m[3].split(',').forEach((pair) => {
    const i = pair.indexOf(':'); if (i < 0) return;
    const k = pair.slice(0, i).trim(), v = val(pair.slice(i + 1).trim());
    if (v == null) return;
    if (k === 'type' && /^(ANIME|MANGA)$/.test(v)) o.kind = v;
    else if (k === 'format' && /^[A-Z_]{2,12}$/.test(v)) o.format = v;
    else if (k === 'season' && /^(WINTER|SPRING|SUMMER|FALL)$/.test(v)) o.season = v;
    else if (k === 'seasonYear' && Number(v) >= 1950 && Number(v) <= 2100) o.year = Math.floor(Number(v));
    else if (k === 'search' && typeof v === 'string') o.search = v.trim().slice(0, 100);
    else if (k === 'genre' && typeof v === 'string' && v.length <= 40) o.genre = v;
    else if (k === 'sort' && /^[A-Z_]{3,24}$/.test(v)) o.sort = v;
  });
  if (o.season && !o.year) delete o.season;
  return o;
}

/** Answer an AniList-style query from the backup sources. Returns {body, source} | null (shape not supported). */
async function fbGql(rt, q, vars) {
  const s = parseGqlShape(q, vars || {});
  if (!s) return null;
  const done = (data, source) => { FBX.used = source; FBX.usedAt = Date.now(); return { body: { data, source }, source }; };
  if (s.shape === 'detail') {
    const r = await fbDetail(rt, s.id);
    if (!r) return { notFound: true };
    return done({ Media: r.media }, r.source);
  }
  if (s.shape === 'batch') {
    const rows = await Promise.all(s.items.map(async ([alias, id]) => { try { return [alias, await fbDetail(rt, id)]; } catch (e) { if (!isSrcErr(e)) throw e; return [alias, undefined]; } }));
    if (rows.every((r) => r[1] === undefined)) throw new SrcDown('jikan', 'unavailable', 30);
    const data = {}, used = new Set();
    rows.forEach(([alias, r]) => { data[alias] = r ? r.media : null; if (r) used.add(r.source); });
    return done(data, Array.from(used).sort().join('+') || 'jikan');
  }
  if (s.kind === 'ALL') { // search across anime and manga: anime first, manga mixed in
    const [a, b] = await Promise.all([fbList(rt, Object.assign({}, s, { kind: 'ANIME' })).catch((e) => { if (!isSrcErr(e)) throw e; return null; }), fbList(rt, Object.assign({}, s, { kind: 'MANGA' })).catch((e) => { if (!isSrcErr(e)) throw e; return null; })]);
    if (!a && !b) throw new SrcDown('kitsu', 'unavailable', 30);
    const items = [], x = a ? a.items : [], y = b ? b.items : [];
    for (let i = 0; i < Math.max(x.length, y.length) && items.length < s.per; i++) { if (x[i]) items.push(x[i]); if (y[i] && items.length < s.per) items.push(y[i]); }
    return done({ Page: { pageInfo: { hasNextPage: !!((a && a.hasNext) || (b && b.hasNext)) }, media: items } }, [a && a.source, b && b.source].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).sort().join('+'));
  }
  const r = await fbList(rt, s);
  return done({ Page: { pageInfo: { hasNextPage: r.hasNext }, media: r.items } }, r.source);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. CLIENT APP — runs in the browser. Served as /_/app.js via clientApp.toString().
 *    Everything below is ordinary JavaScript (template literals are fine here).
 *    It must not reference anything from the server half of this file.
 * ═══════════════════════════════════════════════════════════════════════════ */
function clientApp() {
  'use strict';

  /* ── 3.1 helpers ─────────────────────────────────────────────────────── */
  const CFG = window.__CFG || {};
  const d = document;
  const $ = (s, r) => (r || d).querySelector(s);
  const $$ = (s, r) => Array.from((r || d).querySelectorAll(s));
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const idle = (fn, timeout) => (window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: timeout || 1500 }) : setTimeout(fn, 60));
  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const httpsUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : '');
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtTime = (t) => {
    t = Math.max(0, Math.floor(Number(t) || 0));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h ? h + ':' + pad2(m) : m) + ':' + pad2(s);
  };
  const fmtDays = (sec) => {
    sec = Math.max(0, sec);
    const dd = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return dd ? dd + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : Math.max(1, m) + 'm';
  };
  const timeAgo = (ts) => {
    const s = Math.max(1, (Date.now() - ts) / 1000);
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  };

  /* ── 3.2 storage (localStorage with in-memory fallback) ──────────────── */
  const memStore = new Map();
  const LS = {
    get(k, def) {
      if (memStore.has(k)) return memStore.get(k);
      try { const v = localStorage.getItem('lg2:' + k); if (v == null) return def; const o = JSON.parse(v); memStore.set(k, o); return o; } catch { return def; }
    },
    set(k, v) {
      memStore.set(k, v);
      const s = JSON.stringify(v);
      try { localStorage.setItem('lg2:' + k, s); } catch { LS.prune(); try { localStorage.setItem('lg2:' + k, s); } catch { /* storage unavailable */ } }
    },
    del(k) { memStore.delete(k); try { localStorage.removeItem('lg2:' + k); } catch { /* ignore */ } },
    prune() {
      try {
        const rows = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.indexOf('lg2:c:') === 0) { let t = 0; try { t = JSON.parse(localStorage.getItem(k)).t || 0; } catch { /* corrupt */ } rows.push([k, t]); }
        }
        rows.sort((a, b) => a[1] - b[1]).slice(0, Math.max(5, Math.ceil(rows.length / 2))).forEach((r) => localStorage.removeItem(r[0]));
      } catch { /* ignore */ }
    },
  };
  const prefs = Object.assign({ audio: 'dub', autoplay: true, autoskip: false, volume: 1, muted: false, speed: 1, list: '', cc: 'en' }, LS.get('prefs', {}));
  const savePrefs = () => LS.set('prefs', prefs);

  /* ── 3.3 network ─────────────────────────────────────────────────────── */
  async function fetchJSON(url, opts) {
    opts = opts || {};
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeout || 25000);
    if (opts.signal) { if (opts.signal.aborted) ctl.abort(); else opts.signal.addEventListener('abort', () => ctl.abort(), { once: true }); }
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' }, cache: opts.cache });
      const text = await r.text();
      let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
      if (!r.ok) {
        const msg = j && (j.error || j.message || (j.errors && j.errors[0] && (j.errors[0].message || j.errors[0].detail))) || 'HTTP ' + r.status;
        const e = new Error(String(msg)); e.status = r.status; e.data = j;
        if (j && j.paused) { e.paused = true; e.blocked = !!j.blocked; e.retryAfter = Number(j.retryAfter) || 0; } // AniList is rate-limiting / blocking the server
        throw e;
      }
      if (j == null) { const e = new Error('Invalid response'); e.status = 502; throw e; }
      return j;
    } catch (err) {
      if (err && err.name === 'AbortError') { const e = new Error(opts.signal && opts.signal.aborted ? 'aborted' : 'timeout'); e.name = 'AbortError'; e.status = 0; e.timeout = !(opts.signal && opts.signal.aborted); throw e; }
      throw err;
    } finally { clearTimeout(timer); }
  }

  /** Small notice shown while the data on screen came from a backup source (Jikan / Kitsu) instead of AniList. */
  let bkEl = null, bkOff = false;
  const BK_NAMES = { jikan: 'Jikan (MyAnimeList)', kitsu: 'Kitsu', 'jikan+kitsu': 'Jikan and Kitsu' };
  function markBackup(src) {
    if (!src) { if (bkEl) bkEl.hidden = true; return; }
    if (bkOff) return;
    if (!bkEl) {
      bkEl = d.createElement('div'); bkEl.className = 'bk-note'; bkEl.setAttribute('role', 'status');
      bkEl.innerHTML = '<span></span><button type="button" aria-label="Dismiss">' + ic('close') + '</button>';
      bkEl.querySelector('button').addEventListener('click', () => { bkOff = true; bkEl.hidden = true; });
      d.body.appendChild(bkEl);
    }
    bkEl.firstChild.textContent = 'AniList is unavailable right now, so this page uses ' + (BK_NAMES[src] || 'a backup source') + '. Some details, like banners and recommendations, may be missing.';
    bkEl.hidden = false;
  }

  const gqlFlight = new Map();
  /** AniList, always through our own cached proxy. The browser never talks to AniList directly: that would bypass the
   *  cache and the server-side pause, and could get this visitor's own connection blocked. */
  function gql(query, vars, opts) {
    const q = query.replace(/\s+/g, ' ').trim();
    const v = vars && Object.keys(vars).length ? JSON.stringify(vars) : '';
    const key = q + '|' + v;
    if (!(opts && opts.signal) && gqlFlight.has(key)) return gqlFlight.get(key);
    const p = (async () => {
      let j;
      try {
        j = await fetchJSON('/gql?q=' + encodeURIComponent(q) + (v ? '&v=' + encodeURIComponent(v) : ''), opts);
      } catch (e) {
        if (e && e.status == null && e.name !== 'AbortError') { const err = new Error('Could not reach the server. Check your connection and try again.'); err.status = 0; throw err; }
        throw e;
      }
      if (j.errors && !j.data) { const err = new Error(j.errors[0].message || 'AniList error'); err.status = 400; throw err; }
      markBackup(j.source);
      return j.data;
    })();
    if (!(opts && opts.signal)) { gqlFlight.set(key, p); p.then(() => gqlFlight.delete(key), () => gqlFlight.delete(key)); }
    return p;
  }

  /** Stale-while-revalidate over localStorage: paints cached data instantly, refreshes in the background. */
  async function swr(key, ttl, fetcher, onData) {
    const hit = LS.get('c:' + key, null);
    let served = false;
    if (hit && typeof hit.s === 'string') {
      try { onData(JSON.parse(hit.s), true); served = true; } catch { /* corrupt entry */ }
      if (served && Date.now() - hit.t < ttl) return;
    }
    try {
      const fresh = await fetcher();
      const s = JSON.stringify(fresh);
      LS.set('c:' + key, { t: Date.now(), s });
      if (!served || (hit && hit.s !== s)) onData(fresh, false);
    } catch (err) { if (!served) throw err; }
  }

  /* ── 3.4 media helpers ───────────────────────────────────────────────── */
  const MEDIA = new Map();
  const reg = (list) => { (list || []).forEach((m) => { if (m && m.id) MEDIA.set(m.id, Object.assign(MEDIA.get(m.id) || {}, m)); }); return list; };
  const mTitle = (m) => (m && m.title && (m.title.english || m.title.romaji || m.title.native)) || 'Untitled';
  const isManga = (m) => !!m && (m.type === 'MANGA' || m.format === 'MANGA' || m.format === 'NOVEL' || m.format === 'ONE_SHOT');
  const FORMATS = { TV: 'TV', TV_SHORT: 'TV Short', MOVIE: 'Movie', SPECIAL: 'Special', OVA: 'OVA', ONA: 'ONA', MUSIC: 'Music', MANGA: 'Manga', NOVEL: 'Novel', ONE_SHOT: 'One-shot' };
  const fmtFormat = (f) => FORMATS[f] || (f ? String(f).replace(/_/g, ' ') : '');
  const score = (m) => (m && m.averageScore ? (m.averageScore / 10).toFixed(1) : '');
  const metaLine = (m) => {
    const bits = [fmtFormat(m.format)];
    if (m.episodes) bits.push(m.episodes + ' ep'); else if (m.chapters) bits.push(m.chapters + ' ch');
    if (m.seasonYear) bits.push(m.seasonYear);
    return bits.filter(Boolean).join(' · ');
  };
  const cleanDesc = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&rsquo;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
  const seasonNow = () => { const dt = new Date(), m = dt.getMonth() + 1; return { season: m <= 3 ? 'WINTER' : m <= 6 ? 'SPRING' : m <= 9 ? 'SUMMER' : 'FALL', year: dt.getFullYear() }; };
  const seasonNext = () => { const c = seasonNow(), o = ['WINTER', 'SPRING', 'SUMMER', 'FALL'], i = (o.indexOf(c.season) + 1) % 4; return { season: o[i], year: i === 0 ? c.year + 1 : c.year }; };
  const cap = (s) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : '');

  /* ── 3.5 icons ───────────────────────────────────────────────────────── */
  const ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    flame: '<path d="M12 3c.6 3 4.5 4.8 4.5 9.6A4.5 4.5 0 0 1 12 17.5a4.5 4.5 0 0 1-4.5-4.9c0-1.8.9-3 1.9-3.9.4 1 .9 1.5 1.7 1.7C11 8.2 11.2 5.5 12 3z"/><path d="M12 21a2.5 2.5 0 0 0 2.5-2.5"/>',
    calendar: '<rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M3 9.5h18M8 3v3M16 3v3"/>',
    star: '<path class="f" d="M12 2.8l2.8 5.8 6.4.9-4.6 4.5 1.1 6.3L12 17.3l-5.7 3 1.1-6.3L2.8 9.5l6.4-.9z"/>',
    trophy: '<path d="M8 4h8v6a4 4 0 0 1-8 0zM8 6H4.5a1 1 0 0 0-1 1 4 4 0 0 0 4 4M16 6h3.5a1 1 0 0 1 1 1 4 4 0 0 1-4 4M12 14v4M8.5 21h7"/>',
    play: '<path class="f" d="M7.5 5.2v13.6a.6.6 0 0 0 .9.5l11-6.8a.6.6 0 0 0 0-1L8.4 4.7a.6.6 0 0 0-.9.5z"/>',
    pause: '<rect class="f" x="6" y="5" width="4" height="14" rx="1.2"/><rect class="f" x="14" y="5" width="4" height="14" rx="1.2"/>',
    next: '<path class="f" d="M6 6.2v11.6a.5.5 0 0 0 .8.4l8.4-5.8a.5.5 0 0 0 0-.8L6.8 5.8a.5.5 0 0 0-.8.4z"/><path d="M18.5 5.5v13"/>',
    prev: '<path class="f" d="M18 6.2v11.6a.5.5 0 0 1-.8.4l-8.4-5.8a.5.5 0 0 1 0-.8l8.4-5.8a.5.5 0 0 1 .8.4z"/><path d="M5.5 5.5v13"/>',
    back10: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4v4.5H9"/><text x="12" y="15.2" text-anchor="middle" font-size="7.4" font-weight="700" style="fill:currentColor;stroke:none" font-family="system-ui,sans-serif">10</text>',
    fwd10: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v4.5H15"/><text x="12" y="15.2" text-anchor="middle" font-size="7.4" font-weight="700" style="fill:currentColor;stroke:none" font-family="system-ui,sans-serif">10</text>',
    volume: '<path d="M4 9.5v5h3.5L13 19V5L7.5 9.5z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
    volLow: '<path d="M4 9.5v5h3.5L13 19V5L7.5 9.5z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
    mute: '<path d="M4 9.5v5h3.5L13 19V5L7.5 9.5z"/><path d="m17 9.5 5 5M22 9.5l-5 5"/>',
    fullscreen: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>',
    exitFs: '<path d="M3 8h3a2 2 0 0 0 2-2V3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M21 16h-3a2 2 0 0 0-2 2v3"/>',
    pip: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><rect class="f" x="12" y="11" width="6.5" height="5" rx="1"/>',
    cc: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.2 10.3a2.2 2.2 0 1 0 0 3.4M17.2 10.3a2.2 2.2 0 1 0 0 3.4"/>',
    sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    chevL: '<path d="m15 5-7 7 7 7"/>',
    chevR: '<path d="m9 5 7 7-7 7"/>',
    chevD: '<path d="m6 9 6 6 6-6"/>',
    arrowL: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5H6.5A2.5 2.5 0 0 0 4 21z"/><path d="M4 18.5V5.5M8.5 7.5h7"/>',
    shuffle: '<path d="M16 4h4v4M20 4 4 20M20 16v4h-4M14.5 14.5 20 20M4 4l5 5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7.5V12l3 2"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.01"/>',
    alert: '<path d="M12 3.5 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2v.01"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v6h-6"/>',
    list: '<path d="M8.5 6H21M8.5 12H21M8.5 18H21M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    download: '<path d="M12 3.5v12M7 11l5 5 5-5M4.5 20h15"/>',
    bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15zM10 21a2 2 0 0 0 4 0"/>',
    zap: '<path class="f" d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5zM3 12.5l9 5 9-5M3 16.5l9 5 9-5"/>',
    expand: '<path d="M5 9V5h4M19 9V5h-4M5 15v4h4M19 15v4h-4"/>',
    arrows: '<path d="M7 7 3 12l4 5M17 7l4 5-4 5"/>',
    scroll: '<path d="M8 3v18M4.5 17.5 8 21l3.5-3.5M16 21V3M12.5 6.5 16 3l3.5 3.5"/>',
    page: '<rect x="5" y="3" width="14" height="18" rx="2.5"/>',
    pages2: '<rect x="2.5" y="4" width="9" height="16" rx="2"/><rect x="12.5" y="4" width="9" height="16" rx="2"/>',
  };
  const ic = (n, cls) => '<svg class="ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[n] || '') + '</svg>';
  const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="lgg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5bd0ff"/><stop offset="1" stop-color="#1b7fb0"/></linearGradient></defs><rect x="2" y="2" width="28" height="28" rx="8.5" fill="url(#lgg)"/><path d="M11 8.5v15h10.5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="21.5" cy="11" r="2.2" fill="#fff"/></svg>';

  /* ── 3.6 toasts ──────────────────────────────────────────────────────── */
  function toast(msg, o) {
    o = o || {};
    const box = $('#toasts'); if (!box) return;
    const el = d.createElement('div');
    el.className = 'toast' + (o.kind ? ' toast-' + o.kind : '');
    el.setAttribute('role', 'status');
    el.innerHTML = '<span>' + esc(msg) + '</span>' + (o.action ? '<button type="button" class="toast-act">' + esc(o.action) + '</button>' : '');
    if (o.action) $('.toast-act', el).addEventListener('click', () => { el.remove(); if (o.onAction) o.onAction(); });
    box.appendChild(el);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, o.ms || 3600);
  }

  /* ── 3.7 shared templates ────────────────────────────────────────────── */
  /** Poster card. `o`: rank, label (overlay text), progress (0-100), remove (id), href */
  function cardHtml(m, o) {
    o = o || {};
    const t = mTitle(m);
    const cover = httpsUrl(m.cover || (m.coverImage && (m.coverImage.large || m.coverImage.medium)));
    const color = (m.coverImage && /^#[0-9a-f]{3,8}$/i.test(m.coverImage.color || '') && m.coverImage.color) || (/^#[0-9a-f]{3,8}$/i.test(m.color || '') ? m.color : '');
    const sc = score(m);
    const href = o.href || '/detail/' + m.id;
    return '<a class="card' + (o.cls ? ' ' + o.cls : '') + '" href="' + esc(href) + '" data-id="' + m.id + '"' + (color ? ' style="--c:' + color + '"' : '') + '>' +
      '<div class="card-art">' + (cover ? '<img src="' + esc(cover) + '" alt="" loading="lazy" decoding="async" draggable="false">' : '') +
      (sc ? '<span class="chip chip-score">' + ic('star') + sc + '</span>' : '') +
      (o.label ? '<span class="chip chip-label">' + esc(o.label) + '</span>' : '') +
      (o.remove ? '<button type="button" class="card-x" data-remove="' + m.id + '" aria-label="Remove from list">' + ic('close') + '</button>' : '') +
      (o.progress != null ? '<div class="card-prog"><i style="width:' + clamp(o.progress, 0, 100) + '%"></i></div>' : '') +
      '</div><div class="card-t">' + esc(t) + '</div><div class="card-m">' + esc(o.sub || metaLine(m)) + '</div></a>';
  }
  const skelCard = () => '<div class="card sk-card" aria-hidden="true"><div class="card-art sk"></div><div class="sk sk-l"></div><div class="sk sk-l s"></div></div>';
  const skelRail = (title, n) => '<section class="rail" aria-busy="true"><div class="rail-h"><h2>' + esc(title || '') + '</h2></div><div class="rail-t">' + Array(n || 8).fill(skelCard()).join('') + '</div></section>';
  const skelGrid = (n) => '<div class="grid" aria-busy="true">' + Array(n || 18).fill(skelCard()).join('') + '</div>';

  function railHtml(id, title, items, o) {
    o = o || {};
    if (!items || !items.length) return '';
    return '<section class="rail' + (o.cls ? ' ' + o.cls : '') + '" id="rail-' + id + '"><div class="rail-h"><h2>' + esc(title) + '</h2>' +
      '<div class="rail-ctl">' + (o.more ? '<a class="rail-more" href="' + esc(o.more) + '">See all' + ic('chevR') + '</a>' : '') +
      '<button type="button" class="rail-b" data-dir="-1" aria-label="Scroll left">' + ic('chevL') + '</button><button type="button" class="rail-b" data-dir="1" aria-label="Scroll right">' + ic('chevR') + '</button></div></div>' +
      '<div class="rail-t" role="list">' + items.join('') + '</div></section>';
  }

  /** Mark images loaded (fade-in) and wire rail arrows within `root`. */
  function hydrate(root) {
    $$('img', root).forEach((im) => {
      if (im.complete && im.naturalWidth) im.classList.add('ld');
      else if (im.complete) im.classList.add('ld', 'bad');
    });
    $$('.rail', root).forEach(railState);
  }
  d.addEventListener('load', (e) => { const t = e.target; if (t && t.tagName === 'IMG') t.classList.add('ld'); }, true);
  d.addEventListener('error', (e) => { const t = e.target; if (t && t.tagName === 'IMG') t.classList.add('ld', 'bad'); }, true);

  function railState(rail) {
    const t = $('.rail-t', rail); if (!t) return;
    const upd = () => {
      rail.classList.toggle('can-l', t.scrollLeft > 8);
      rail.classList.toggle('can-r', t.scrollLeft + t.clientWidth < t.scrollWidth - 8);
    };
    if (!t._wired) { t._wired = true; t.addEventListener('scroll', upd, { passive: true }); }
    upd(); requestAnimationFrame(upd);
  }
  d.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.rail-b');
    if (!b) return;
    const t = $('.rail-t', b.closest('.rail'));
    t.scrollBy({ left: Number(b.dataset.dir) * Math.max(240, t.clientWidth * 0.85), behavior: reduceMotion() ? 'auto' : 'smooth' });
  });
  window.addEventListener('resize', debounce(() => $$('.rail').forEach(railState), 150));

  /** Accepts a message or an Error. AniList pauses (blocked / rate limited) get their own heading instead of "Something went wrong". */
  const errorBlock = (err, retry) => {
    const o = err && typeof err === 'object' ? err : null;
    const msg = o ? o.message : err;
    const title = o && o.blocked ? 'AniList is blocking this server' : o && o.paused ? 'AniList is busy' : 'Something went wrong';
    return '<div class="empty"><div class="empty-i">' + ic(o && o.paused ? 'info' : 'alert') + '</div><h3>' + esc(title) + '</h3><p>' + esc(msg || 'Please try again.') + '</p>' + (retry ? '<button type="button" class="btn" data-retry>' + ic('refresh') + 'Try again</button>' : '') + '</div>';
  };
  const emptyBlock = (title, msg, href, cta) => '<div class="empty"><div class="empty-i">' + ic('search') + '</div><h3>' + esc(title) + '</h3><p>' + esc(msg || '') + '</p>' + (href ? '<a class="btn" href="' + esc(href) + '">' + esc(cta || 'Go home') + '</a>' : '') + '</div>';

  /* ── 3.8 app state, auth, progress ───────────────────────────────────── */
  const state = { user: LS.get('auth', null), authReady: false, authFailed: false };
  const isAuthed = () => !!state.user;
  const emit = (name, detail) => d.dispatchEvent(new CustomEvent(name, { detail }));

  /* Continue list: instant from localStorage, reconciled with D1 in the background. */
  const cwKey = () => 'cw:' + (state.user ? state.user.id : 'anon');
  const cwList = () => LS.get(cwKey(), []).filter((e) => e && e.id && e.title);
  const parseNum = (label) => { const m = String(label || '').match(/(\d+(?:\.\d+)?)/); return m ? m[1] : ''; };
  const fromRow = (r) => ({ id: Number(r.anilist_id), type: r.type, title: r.title, cover: r.cover_image || '', label: r.episode_or_chapter || '', pos: r.position_seconds || 0, dur: r.duration_seconds || 0, page: r.page_index || 0, ts: Number(r.updated_at) || 0 });
  const pending = new Map();
  let pushTimer = 0;

  function pushPending() {
    clearTimeout(pushTimer); pushTimer = 0;
    if (!state.user) { pending.clear(); return; }
    const uid = state.user.id;
    pending.forEach((e) => {
      fetch('/api/progress', {
        method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: uid, anilistId: e.id, type: e.type, title: e.title, coverImage: e.cover || null, episodeOrChapter: e.label, positionSeconds: e.type === 'anime' ? Math.round(e.pos || 0) : null, durationSeconds: e.type === 'anime' ? Math.round(e.dur || 0) : null, pageIndex: e.type === 'manga' ? (e.page || 0) : null }),
      }).catch(() => {});
    });
    pending.clear();
  }
  function cwSave(e, flush) {
    e.ts = Date.now();
    const list = cwList().filter((x) => x.id !== e.id);
    list.unshift(e);
    LS.set(cwKey(), list.slice(0, 60));
    pending.set(e.id, e);
    if (flush) pushPending(); else if (!pushTimer) pushTimer = setTimeout(pushPending, 15000);
    emit('cw:update');
  }
  function cwRemove(id) {
    LS.set(cwKey(), cwList().filter((x) => x.id !== id));
    if (state.user) fetch('/api/progress/' + id + '?user=' + encodeURIComponent(state.user.id), { method: 'DELETE', keepalive: true }).catch(() => {});
    emit('cw:update');
  }
  const cwGet = (id) => cwList().find((x) => x.id === id) || null;
  async function cwSync() {
    if (!state.user) return;
    const uid = state.user.id;
    try {
      const j = await fetchJSON('/api/progress?user=' + encodeURIComponent(uid) + '&limit=60', { timeout: 12000 });
      if (!state.user || state.user.id !== uid) return;
      const remote = (j.items || []).map(fromRow);
      const byId = new Map();
      cwList().concat(remote).forEach((e) => { const o = byId.get(e.id); if (!o || e.ts > o.ts) byId.set(e.id, e); });
      LS.set(cwKey(), Array.from(byId.values()).sort((a, b) => b.ts - a.ts).slice(0, 60));
      emit('cw:update');
    } catch { /* offline or D1 not configured: local list still works */ }
  }
  window.addEventListener('pagehide', pushPending);
  d.addEventListener('visibilitychange', () => { if (d.visibilityState === 'hidden') pushPending(); });

  const watchedKey = (id) => 'w:' + id;
  const watchedSet = (id) => new Set(LS.get(watchedKey(id), []));
  function markWatched(id, ep) { const s = watchedSet(id); s.add(Number(ep)); LS.set(watchedKey(id), Array.from(s).slice(-3000)); }

  /* Clerk is loaded lazily and never blocks public data: a cached identity paints the app immediately. */
  const auth = { loading: false };
  function loadClerk() {
    if (!CFG.pk || !CFG.cu || auth.loading) return;
    auth.loading = true;
    const s = d.createElement('script');
    s.async = true; s.crossOrigin = 'anonymous';
    s.setAttribute('data-clerk-publishable-key', CFG.pk);
    s.src = CFG.cu + '/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
    s.onload = () => initClerk(0);
    s.onerror = () => { state.authFailed = true; if (!state.user) renderRoute(); renderHeader(); };
    d.head.appendChild(s);
  }
  function initClerk(n) {
    const C = window.Clerk;
    if (!C) { if (n < 100) setTimeout(() => initClerk(n + 1), 100); else { state.authFailed = true; renderRoute(); } return; }
    Promise.resolve(C.load({})).then(() => { state.authReady = true; syncUser(); paintGateNote(); if (C.addListener) C.addListener(syncUser); }).catch(() => { state.authFailed = true; if (!state.user) renderRoute(); renderHeader(); });
  }
  function paintGateNote() { const n = $('#gNote'); if (n) n.textContent = state.authFailed ? 'Sign-in could not be loaded. Check your connection and refresh.' : state.authReady ? '' : 'Preparing secure sign-in…'; }
  function syncUser() {
    const u = window.Clerk && window.Clerk.user;
    const before = state.user ? state.user.id : null;
    if (u) {
      const email = u.primaryEmailAddress && u.primaryEmailAddress.emailAddress || '';
      state.user = { id: u.id, name: u.username || u.firstName || (email ? email.split('@')[0] : 'Member'), email, img: u.imageUrl || '' };
      LS.set('auth', state.user);
    } else { state.user = null; LS.del('auth'); }
    renderHeader();
    if ((state.user ? state.user.id : null) !== before) { renderRoute(); if (state.user) cwSync(); }
  }
  const clerkDo = (fn) => { const C = window.Clerk; if (C && state.authReady) { try { C[fn](); } catch { /* ignore */ } } else { toast('Sign-in is still loading…'); loadClerk(); } };

  /* ── 3.9 home data (inline from the edge when warm, else /home.json) ─── */
  let homeInline;
  function readInline() {
    if (homeInline !== undefined) return homeInline;
    homeInline = null;
    const el = $('#home-data');
    if (el) { try { const j = JSON.parse(el.textContent); homeInline = j && j.data || null; if (homeInline) markBackup(j.source); } catch { /* ignore */ } el.remove(); }
    if (homeInline) LS.set('c:home', { t: Date.now(), s: JSON.stringify(homeInline) });
    return homeInline;
  }
  let homeTries = 0;
  function loadHome(onData) {
    const inl = readInline();
    if (inl) { onData(inl, true); }
    let more = false;
    const p = swr('home', 5 * 60 * 1000, async () => { const j = await fetchJSON('/home.json', { timeout: 30000 }); if (!j.data) throw new Error('No data'); markBackup(j.source); more = !!j.more; return j.data; }, (data, cached) => { if (!(inl && cached)) onData(data, cached); });
    // While AniList is unavailable the server fills the page from Jikan / Kitsu a few rails at a time ("more"): ask again for the rest.
    return p.then(() => {
      if (!more || homeTries >= 4) { if (!more) homeTries = 0; return; }
      homeTries++;
      const h = LS.get('c:home', null); if (h) LS.set('c:home', { t: 0, s: h.s }); // the partial copy must not count as fresh
      setTimeout(() => { loadHome(onData).catch(() => {}); }, 1200);
    });
  }

  /* ── 3.10 router ─────────────────────────────────────────────────────── */
  const ROUTES = [
    ['home', /^\/$/], ['detail', /^\/detail\/(\d+)$/], ['watch', /^\/watch\/(\d+)$/], ['read', /^\/read\/(\d+)$/],
    ['browse', /^\/browse\/([a-z]+)$/], ['search', /^\/search$/], ['library', /^\/library$/],
  ];
  const resolveRoute = (p) => {
    p = p.length > 1 ? p.replace(/\/+$/, '') : p;
    for (const [name, re] of ROUTES) { const m = p.match(re); if (m) return { name, params: m.slice(1) }; }
    return { name: 'nf', params: [] };
  };
  let current = null, navSeq = 0, firstRender = true;

  function transition(fn) {
    if (!firstRender && d.startViewTransition && !reduceMotion()) { try { d.startViewTransition(fn); return; } catch { /* fall through */ } }
    fn();
  }

  function renderRoute(o) {
    o = o || {};
    const seq = ++navSeq;
    const r = resolveRoute(location.pathname);
    const query = new URLSearchParams(location.search);
    const apply = () => {
      if (seq !== navSeq) return;
      if (current && current.destroy) { try { current.destroy(); } catch (e) { console.error(e); } }
      current = null;
      const host = $('#view'); if (!host) return;
      host.className = 'view view-' + r.name;
      host.innerHTML = '';
      const el = d.createElement('div'); el.className = 'page'; host.appendChild(el); // fresh element per route: its listeners die with it
      setNavActive(r);
      const ctx = { el, params: r.params, query, live: () => seq === navSeq, seq };
      try {
        if (!isAuthed() && r.name !== 'nf') current = gateView(ctx);
        else current = (VIEWS[r.name] || VIEWS.nf)(ctx) || {};
      } catch (e) { console.error(e); el.innerHTML = errorBlock(e); }
      el.classList.add('view-in');
      if (!o.keepScroll) window.scrollTo(0, o.y || 0);
      const boot = $('#boot'); if (boot) boot.remove();
      firstRender = false;
    };
    transition(apply);
  }

  function navigate(href, o) {
    o = o || {};
    let u; try { u = new URL(href, location.href); } catch { return; }
    if (u.origin !== location.origin) { location.href = href; return; }
    const target = u.pathname + u.search;
    if (target === location.pathname + location.search && !o.force) { window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' }); return; }
    try { history.replaceState({ y: window.scrollY }, ''); } catch { /* ignore */ }
    history[o.replace ? 'replaceState' : 'pushState']({ y: 0 }, '', target + u.hash);
    renderRoute();
  }
  window.addEventListener('popstate', (e) => renderRoute({ y: (e.state && e.state.y) || 0 }));
  d.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.target || a.hasAttribute('download') || a.hasAttribute('data-native')) return;
    let u; try { u = new URL(a.href, location.href); } catch { return; }
    if (u.origin !== location.origin || resolveRoute(u.pathname).name === 'nf') return;
    e.preventDefault();
    const img = $('.card-art img', a);
    if (img && d.startViewTransition) { img.style.viewTransitionName = 'cover'; setTimeout(() => { img.style.viewTransitionName = ''; }, 900); }
    navigate(a.getAttribute('href'));
  });

  /* ── 3.11 header, search, profile menu, tab bar ──────────────────────── */
  const NAV = [
    { id: 'home', label: 'Home', icon: 'home', href: '/' },
    { id: 'trending', label: 'Trending', icon: 'flame', href: '/browse/trending' },
    { id: 'seasonal', label: 'Season', icon: 'calendar', href: '/browse/seasonal' },
    { id: 'top', label: 'Top Rated', icon: 'trophy', href: '/browse/top' },
    { id: 'manga', label: 'Manga', icon: 'book', href: '/browse/manga' },
    { id: 'random', label: 'Surprise', icon: 'shuffle', href: '/browse/random' },
  ];
  const TABS = [NAV[0], NAV[1], NAV[2], NAV[4], { id: 'library', label: 'Library', icon: 'history', href: '/library' }];
  const initials = (n) => String(n || 'U').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  function avatarHtml(u, cls) {
    return '<span class="avatar ' + (cls || '') + '">' + (u.img ? '<img src="' + esc(u.img) + '" alt="" referrerpolicy="no-referrer">' : esc(initials(u.name))) + '</span>';
  }

  function buildShell() {
    $('#app').innerHTML = '<header class="hdr" id="hdr"></header><main id="view" class="view" tabindex="-1"></main><nav class="tabbar" id="tabbar" aria-label="Primary">' +
      TABS.map((n) => '<a class="tab" href="' + n.href + '" data-nav="' + n.id + '">' + ic(n.icon) + '<span>' + n.label + '</span></a>').join('') + '</nav><div class="toasts" id="toasts" aria-live="polite"></div>';
    renderHeader();
  }

  function renderHeader() {
    const h = $('#hdr'); if (!h) return;
    const u = state.user;
    // Clerk re-announces the same user when it finishes loading; rebuilding the header then would wipe a search the user is typing.
    const sig = u ? u.id + '|' + u.name + '|' + u.img : 'out';
    if (h.dataset.sig === sig && h.firstChild) { setNavActive(resolveRoute(location.pathname)); return; }
    h.dataset.sig = sig;
    const keep = $('#sinput') ? $('#sinput').value : '';
    h.innerHTML = '<div class="hdr-in"><a class="brand" href="/" aria-label="The Ledger home"><span class="brand-mark">' + LOGO + '</span><span class="brand-name">The Ledger</span></a>' +
      '<nav class="pnav" id="pnav" aria-label="Primary">' + NAV.map((n) => '<a class="pnav-i" href="' + n.href + '" data-nav="' + n.id + '" title="' + n.label + '">' + ic(n.icon) + '<span>' + n.label + '</span></a>').join('') + '</nav>' +
      '<div class="hdr-r">' + (u ? '<form class="sbox" id="sbox" role="search" autocomplete="off" action="/search">' + ic('search') + '<input id="sinput" name="q" type="search" placeholder="Search anime & manga" aria-label="Search" spellcheck="false" autocomplete="off"><kbd>/</kbd><div class="sug" id="sug" role="listbox"></div></form>' +
      '<a class="icon-btn only-m" href="/search" aria-label="Search">' + ic('search') + '</a>' : '') +
      (u ? '<div class="prof"><button type="button" class="prof-btn" id="profBtn" aria-haspopup="menu" aria-expanded="false" aria-label="Account menu">' + avatarHtml(u) + '<span class="prof-name">' + esc(u.name) + '</span>' + ic('chevD', 'prof-c') + '</button><div class="menu" id="profMenu" role="menu" hidden></div></div>'
        : '<button type="button" class="btn btn-sm" id="hdrSign">Sign in</button>') + '</div></div>';
    if (keep && $('#sinput')) $('#sinput').value = keep;
    const r = resolveRoute(location.pathname);
    setNavActive(r);
    wireSearch();
  }

  function navIdFor(r) {
    if (r.name === 'home') return 'home';
    if (r.name === 'browse') return r.params[0];
    if (r.name === 'library') return 'library';
    return '';
  }
  function setNavActive(r) {
    const id = navIdFor(r);
    $$('[data-nav]').forEach((a) => { const on = a.dataset.nav === id; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    const si = $('#sinput'); if (si && r.name !== 'search' && d.activeElement !== si) si.value = '';
  }

  function profileMenuHtml() {
    const u = state.user;
    return '<div class="menu-head">' + avatarHtml(u, 'lg') + '<div><b>' + esc(u.name) + '</b><small>' + esc(u.email || 'Signed in') + '</small></div></div>' +
      '<a class="menu-i" role="menuitem" href="/library">' + ic('history') + 'Continue watching</a>' +
      '<button type="button" class="menu-i" role="menuitem" data-act="account">' + ic('user') + 'Manage account</button><div class="menu-sep"></div>' +
      '<label class="menu-sw"><span>Autoplay next episode</span><input type="checkbox" role="switch" data-pref="autoplay"' + (prefs.autoplay ? ' checked' : '') + '><i></i></label>' +
      '<label class="menu-sw"><span>Skip intros automatically</span><input type="checkbox" role="switch" data-pref="autoskip"' + (prefs.autoskip ? ' checked' : '') + '><i></i></label>' +
      '<div class="menu-seg"><span>Preferred audio</span><div class="seg" role="group"><button type="button" data-audio="sub" class="' + (prefs.audio === 'sub' ? 'on' : '') + '">Sub</button><button type="button" data-audio="dub" class="' + (prefs.audio === 'dub' ? 'on' : '') + '">Dub</button></div></div>' +
      '<div class="menu-sep"></div><button type="button" class="menu-i danger" role="menuitem" data-act="signout">' + ic('logout') + 'Sign out</button>';
  }
  function toggleProfile(force) {
    const btn = $('#profBtn'), menu = $('#profMenu'); if (!btn || !menu) return;
    const open = force == null ? menu.hidden : force;
    if (open) menu.innerHTML = profileMenuHtml();
    menu.hidden = !open; btn.setAttribute('aria-expanded', String(open));
  }
  d.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('#profBtn')) { toggleProfile(); return; }
    const act = t.closest('#profMenu [data-act]');
    if (act) { toggleProfile(false); if (act.dataset.act === 'signout') { const C = window.Clerk; if (C) Promise.resolve(C.signOut()).catch(() => {}); } else clerkDo('openUserProfile'); return; }
    const au = t.closest('#profMenu [data-audio]');
    if (au) { prefs.audio = au.dataset.audio; savePrefs(); $$('#profMenu [data-audio]').forEach((b) => b.classList.toggle('on', b === au)); return; }
    if (t.closest('#profMenu a')) { toggleProfile(false); return; }
    if (t.closest('#hdrSign')) { clerkDo('openSignIn'); return; }
    if (!t.closest('#profMenu')) toggleProfile(false);
    if (!t.closest('#sbox')) closeSug();
  });
  d.addEventListener('change', (e) => { const p = e.target.dataset && e.target.dataset.pref; if (p) { prefs[p] = e.target.checked; savePrefs(); } });

  /* live search suggestions */
  const SUG_Q = 'query($s:String){Page(page:1,perPage:7){media(search:$s,sort:SEARCH_MATCH,isAdult:false){id type format title{romaji english} coverImage{medium color} episodes chapters seasonYear averageScore}}}';
  const sugCache = new Map();
  let sugItems = [], sugIdx = -1, sugSeq = 0;
  function closeSug() { const b = $('#sug'); if (b) { b.classList.remove('open'); b.innerHTML = ''; } sugItems = []; sugIdx = -1; }
  function renderSug(media, q) {
    const b = $('#sug'); if (!b) return;
    sugItems = media; sugIdx = -1;
    b.innerHTML = media.length ? media.map((m, i) => '<a class="sug-i" role="option" href="/detail/' + m.id + '" data-i="' + i + '"><img src="' + esc(httpsUrl(m.coverImage && m.coverImage.medium)) + '" alt="" loading="lazy"><span><b>' + esc(mTitle(m)) + '</b><small>' + esc((m.type === 'MANGA' ? 'Manga' : fmtFormat(m.format) || 'Anime') + (m.seasonYear ? ' · ' + m.seasonYear : '') + (m.averageScore ? ' · ★ ' + (m.averageScore / 10).toFixed(1) : '')) + '</small></span></a>').join('') + '<a class="sug-all" href="/search?q=' + encodeURIComponent(q) + '">See all results for “' + esc(q) + '” ' + ic('chevR') + '</a>'
      : '<div class="sug-none">No matches for “' + esc(q) + '”</div>';
    b.classList.add('open');
  }
  function wireSearch() {
    const input = $('#sinput'), form = $('#sbox'); if (!input) return;
    const run = debounce(async () => {
      const q = input.value.trim(); const seq = ++sugSeq;
      if (q.length < 2) { closeSug(); return; }
      const k = q.toLowerCase();
      if (sugCache.has(k)) { renderSug(sugCache.get(k), q); return; }
      try { const data = await gql(SUG_Q, { s: q }); if (seq !== sugSeq) return; reg(data.Page.media); sugCache.set(k, data.Page.media); renderSug(data.Page.media, q); } catch { if (seq === sugSeq) closeSug(); }
    }, 220);
    input.addEventListener('input', run);
    input.addEventListener('focus', () => { if (input.value.trim().length >= 2 && !sugItems.length) run(); else if (sugItems.length) $('#sug').classList.add('open'); });
    input.addEventListener('keydown', (e) => {
      const open = $('#sug').classList.contains('open');
      if (e.key === 'ArrowDown' && open && sugItems.length) { e.preventDefault(); sugIdx = (sugIdx + 1) % sugItems.length; }
      else if (e.key === 'ArrowUp' && open && sugItems.length) { e.preventDefault(); sugIdx = (sugIdx - 1 + sugItems.length) % sugItems.length; }
      else if (e.key === 'Escape') { closeSug(); input.blur(); return; } else return;
      $$('.sug-i').forEach((el, i) => el.classList.toggle('on', i === sugIdx));
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (sugIdx >= 0 && sugItems[sugIdx]) { const id = sugItems[sugIdx].id; closeSug(); navigate('/detail/' + id); return; }
      const q = input.value.trim(); closeSug(); input.blur();
      if (q) navigate('/search?q=' + encodeURIComponent(q));
    });
  }
  d.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || '')) && !e.target.isContentEditable) {
      const i = $('#sinput') || $('#bigSearch'); if (i) { e.preventDefault(); i.focus(); i.select(); }
    }
  });

  /* ── 3.12 sign-in gate ───────────────────────────────────────────────── */
  function gateView(ctx) {
    const el = ctx.el;
    el.innerHTML = '<section class="gate"><div class="gate-wall" id="gateWall" aria-hidden="true"></div><div class="gate-card"><span class="brand-mark lg">' + LOGO + '</span><h1>Your anime &amp; manga index</h1><p>Sign in to browse, stream and pick up exactly where you left off — on any device.</p>' +
      (CFG.pk ? '<div class="gate-btns"><button type="button" class="btn btn-lg" id="gSign">Sign in</button><button type="button" class="btn btn-lg btn-ghost" id="gUp">Create account</button></div><p class="gate-note" id="gNote">' + (state.authFailed ? 'Sign-in could not be loaded. Check your connection and refresh.' : state.authReady ? '' : 'Preparing secure sign-in…') + '</p>'
        : '<p class="gate-note">Sign-in is not configured for this site (missing Clerk keys).</p>') + '</div></section>';
    const wall = $('#gateWall', el);
    loadHome((data) => {
      if (!ctx.live() || !wall) return;
      const items = ((data.trending && data.trending.media) || []).concat((data.popular && data.popular.media) || []).filter((m) => m.coverImage && httpsUrl(m.coverImage.large)).slice(0, 36);
      const rows = [0, 1, 2].map((r) => items.filter((_, i) => i % 3 === r));
      wall.innerHTML = rows.map((row, i) => '<div class="wall-row r' + i + '">' + row.concat(row).map((m) => '<img src="' + esc(m.coverImage.large) + '" alt="" loading="lazy" decoding="async">').join('') + '</div>').join('');
      hydrate(wall);
    }).catch(() => {});
    const si = $('#gSign', el), su = $('#gUp', el);
    if (si) si.addEventListener('click', () => clerkDo('openSignIn'));
    if (su) su.addEventListener('click', () => clerkDo('openSignUp'));
    d.title = 'Sign in · The Ledger';
    if (CFG.pk && !state.authReady) loadClerk();
    return {};
  }

  /* ── 3.13 home ───────────────────────────────────────────────────────── */
  const skelHero = () => '<section class="hero hero-sk" aria-busy="true"><div class="hero-s on"><div class="sk hero-bg"></div><div class="hero-scrim"></div><div class="hero-c"><div class="sk sk-pill"></div><div class="sk sk-h1"></div><div class="sk sk-l" style="width:60%"></div><div class="sk sk-l" style="width:48%"></div><div class="sk sk-btn"></div></div></div></section>';

  function nextAirText(m) {
    const n = m.nextAiringEpisode;
    if (!n || !n.airingAt) return '';
    const left = n.airingAt - Date.now() / 1000;
    return left > 0 ? 'Ep ' + n.episode + ' in ' + fmtDays(left) : '';
  }

  function heroHtml(items) {
    const slides = items.map((m, i) => {
      const bg = httpsUrl(m.bannerImage) || httpsUrl(m.coverImage && m.coverImage.extraLarge) || httpsUrl(m.coverImage && m.coverImage.large);
      const sc = score(m);
      const desc = cleanDesc(m.description).slice(0, 260);
      const air = nextAirText(m);
      const genres = (m.genres || []).slice(0, 3).join(' · ');
      return '<article class="hero-s' + (i === 0 ? ' on' : '') + '" data-id="' + m.id + '" aria-roledescription="slide" aria-label="' + (i + 1) + ' of ' + items.length + '"' + (m.coverImage && m.coverImage.color ? ' style="--c:' + esc(m.coverImage.color) + '"' : '') + '>' +
        '<img class="hero-bg" src="' + esc(bg) + '" alt="" decoding="async"' + (i === 0 ? ' fetchpriority="high"' : ' loading="lazy"') + '>' +
        '<div class="hero-scrim"></div><div class="hero-c"><div class="hero-badges"><span class="badge badge-acc">' + ic('flame') + '#' + (i + 1) + ' Trending</span>' +
        (m.format ? '<span class="badge">' + esc(fmtFormat(m.format)) + '</span>' : '') + (sc ? '<span class="badge">' + ic('star') + sc + '</span>' : '') + (air ? '<span class="badge">' + esc(air) + '</span>' : '') + '</div>' +
        '<h1 class="hero-t">' + esc(mTitle(m)) + '</h1>' + (genres ? '<div class="hero-g">' + esc(genres) + '</div>' : '') +
        (desc ? '<p class="hero-d">' + esc(desc) + (desc.length >= 260 ? '…' : '') + '</p>' : '') +
        '<div class="hero-a"><a class="btn btn-lg" href="/watch/' + m.id + '">' + ic('play') + 'Watch now</a><a class="btn btn-lg btn-glass" href="/detail/' + m.id + '">' + ic('info') + 'Details</a></div></div></article>';
    }).join('');
    return '<section class="hero" id="hero" aria-roledescription="carousel" aria-label="Featured anime">' + slides +
      '<button type="button" class="hero-arrow l" data-hero="-1" aria-label="Previous">' + ic('chevL') + '</button><button type="button" class="hero-arrow r" data-hero="1" aria-label="Next">' + ic('chevR') + '</button>' +
      '<div class="hero-dots" role="tablist">' + items.map((_, i) => '<button type="button" role="tab" class="hero-dot' + (i === 0 ? ' on' : '') + '" data-go="' + i + '" aria-label="Slide ' + (i + 1) + '"><i></i></button>').join('') + '</div></section>';
  }

  function initHero(root) {
    const hero = $('#hero', root); if (!hero) return () => {};
    const slides = $$('.hero-s', hero), dots = $$('.hero-dot', hero);
    if (slides.length < 2) { $$('.hero-arrow,.hero-dots', hero).forEach((e) => e.remove()); return () => {}; }
    let idx = 0, alive = true;
    const go = (i) => {
      idx = (i + slides.length) % slides.length;
      slides.forEach((s, k) => { s.classList.toggle('on', k === idx); s.setAttribute('aria-hidden', String(k !== idx)); });
      dots.forEach((b, k) => { b.classList.remove('on'); if (k === idx) { void b.offsetWidth; b.classList.add('on'); } });
    };
    hero.addEventListener('click', (e) => {
      const a = e.target.closest('[data-hero]'); if (a) { go(idx + Number(a.dataset.hero)); return; }
      const g = e.target.closest('[data-go]'); if (g) { go(Number(g.dataset.go)); return; }
      if (!e.target.closest('a,button')) { const s = slides[idx]; if (s) navigate('/detail/' + s.dataset.id); }
    });
    // The dot's CSS animation is the timer: when its fill finishes, advance. Hover/focus pauses it for free.
    hero.addEventListener('animationend', (e) => { if (alive && e.animationName === 'dotfill') go(idx + 1); });
    let x0 = null;
    hero.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') x0 = e.clientX; });
    hero.addEventListener('pointerup', (e) => { if (x0 == null) return; const dx = e.clientX - x0; x0 = null; if (Math.abs(dx) > 50) go(idx + (dx < 0 ? 1 : -1)); });
    hero.addEventListener('pointercancel', () => { x0 = null; });
    d.addEventListener('visibilitychange', onVis);
    function onVis() { hero.classList.toggle('paused', d.hidden); }
    go(0);
    return () => { alive = false; d.removeEventListener('visibilitychange', onVis); };
  }

  function rankRail(items) {
    if (!items.length) return '';
    return '<section class="rail rail-rank" id="rail-top"><div class="rail-h"><h2>Top 10 Anime</h2><div class="rail-ctl"><a class="rail-more" href="/browse/top">See all' + ic('chevR') + '</a><button type="button" class="rail-b" data-dir="-1" aria-label="Scroll left">' + ic('chevL') + '</button><button type="button" class="rail-b" data-dir="1" aria-label="Scroll right">' + ic('chevR') + '</button></div></div><div class="rail-t" role="list">' +
      items.slice(0, 10).map((m, i) => '<a class="rcard" href="/detail/' + m.id + '" data-id="' + m.id + '"' + (m.coverImage && m.coverImage.color ? ' style="--c:' + esc(m.coverImage.color) + '"' : '') + '><span class="rcard-n">' + (i + 1) + '</span><span class="rcard-art"><img src="' + esc(httpsUrl(m.coverImage && m.coverImage.large)) + '" alt="" loading="lazy" decoding="async" draggable="false"></span><span class="rcard-i"><b>' + esc(mTitle(m)) + '</b><small>' + esc(score(m) ? '★ ' + score(m) + ' · ' : '') + esc(fmtFormat(m.format)) + '</small></span></a>').join('') + '</div></section>';
  }

  function continueRail() {
    const list = cwList().slice(0, 20);
    if (!list.length) return '';
    const cards = list.map((e) => {
      const m = { id: e.id, title: { english: e.title }, cover: e.cover, format: e.type === 'manga' ? 'MANGA' : '' };
      const pct = e.type === 'anime' && e.dur ? clamp((e.pos / e.dur) * 100, 2, 100) : e.type === 'manga' && e.page ? 35 : 3;
      const left = e.type === 'anime' && e.dur && e.dur - e.pos > 30 ? Math.round((e.dur - e.pos) / 60) + ' min left' : timeAgo(e.ts);
      const href = e.type === 'anime' ? '/watch/' + e.id + (parseNum(e.label) ? '?ep=' + parseNum(e.label) : '') : '/read/' + e.id;
      return cardHtml(m, { href, progress: pct, remove: true, label: e.label, sub: left });
    });
    return railHtml('continue', 'Continue', cards, { more: '/library', cls: 'rail-cw' });
  }

  function homeSections(data) {
    const med = (k) => reg(((data[k] && data[k].media) || []).filter((m) => m && !m.isAdult));
    const seen = new Set();
    const recent = ((data.recent && data.recent.airingSchedules) || []).filter((s) => {
      const m = s && s.media; if (!m || m.isAdult || m.format === 'MUSIC' || seen.has(m.id)) return false; seen.add(m.id); return true;
    }).slice(0, 24).map((s) => Object.assign({}, s.media, { _ep: s.episode, _at: s.airingAt }));
    reg(recent);
    return { trending: med('trending'), recent, top: med('top'), season: med('season'), popular: med('popular'), manga: med('manga'), trendingManga: med('trendingManga'), upcoming: med('upcoming') };
  }

  function homeView(ctx) {
    const el = ctx.el;
    d.title = 'The Ledger — Anime & Manga';
    el.innerHTML = '<div id="heroBox">' + skelHero() + '</div><div id="cwBox"></div><div id="homeBody">' + skelRail('Just aired') + skelRail('Trending now') + skelRail('Top 10 Anime') + '</div>';
    let stopHero = () => {}, rendered = false;
    const cwBox = $('#cwBox', el);
    const renderCw = () => { if (!ctx.live()) return; cwBox.innerHTML = continueRail(); hydrate(cwBox); };
    renderCw();
    const onCw = () => renderCw();
    d.addEventListener('cw:update', onCw);
    const onClick = (e) => {
      const x = e.target.closest('[data-remove]');
      if (x) { e.preventDefault(); e.stopPropagation(); cwRemove(Number(x.dataset.remove)); }
      const r = e.target.closest('[data-retry]'); if (r) load();
    };
    el.addEventListener('click', onClick, true);

    const render = (data) => {
      if (!ctx.live()) return;
      const s = homeSections(data);
      const heroItems = s.trending.filter((m) => m.bannerImage).slice(0, 7);
      const fallback = heroItems.length >= 3 ? heroItems : s.trending.filter((m) => m.coverImage && m.coverImage.extraLarge).slice(0, 6);
      stopHero(); $('#heroBox', el).innerHTML = fallback.length ? heroHtml(fallback) : '';
      stopHero = initHero(el);
      const mk = (list, o) => list.map((m) => cardHtml(m, o));
      $('#homeBody', el).innerHTML =
        railHtml('recent', 'Just aired', s.recent.map((m) => cardHtml(m, { label: m._ep ? 'EP ' + m._ep : 'AIRING', sub: m._at ? timeAgo(m._at * 1000) : '' })), { more: '/browse/trending' }) +
        railHtml('trending', 'Trending now', mk(s.trending), { more: '/browse/trending' }) +
        rankRail(s.top) +
        railHtml('season', 'This season', mk(s.season), { more: '/browse/seasonal' }) +
        railHtml('popular', 'All-time favourites', mk(s.popular), { more: '/browse/popular' }) +
        railHtml('manga', 'Best manga', mk(s.manga), { more: '/browse/manga' }) +
        railHtml('tmanga', 'Trending manga', mk(s.trendingManga), { more: '/browse/manga' }) +
        railHtml('upcoming', 'Coming soon', mk(s.upcoming), { more: '/browse/upcoming' });
      hydrate(el); rendered = true;
    };
    const load = () => {
      loadHome((data) => render(data)).catch((e) => { if (!rendered && ctx.live()) { $('#heroBox', el).innerHTML = ''; $('#homeBody', el).innerHTML = errorBlock(e, true); } });
    };
    load();
    if (isAuthed()) cwSync();
    return { destroy() { stopHero(); d.removeEventListener('cw:update', onCw); } };
  }

  /* ── 3.14 library (everything you've started) ────────────────────────── */
  function libraryView(ctx) {
    const el = ctx.el; d.title = 'Library · The Ledger';
    let tab = 'all';
    const draw = () => {
      if (!ctx.live()) return;
      const list = cwList().filter((e) => tab === 'all' || e.type === tab);
      const cards = list.map((e) => cardHtml({ id: e.id, title: { english: e.title }, cover: e.cover, format: e.type === 'manga' ? 'MANGA' : '' }, {
        href: e.type === 'anime' ? '/watch/' + e.id + (parseNum(e.label) ? '?ep=' + parseNum(e.label) : '') : '/read/' + e.id,
        progress: e.type === 'anime' && e.dur ? clamp((e.pos / e.dur) * 100, 2, 100) : e.page ? 35 : 3, remove: true, label: e.label, sub: timeAgo(e.ts),
      }));
      $('#libBody', el).innerHTML = cards.length ? '<div class="grid">' + cards.join('') + '</div>' : emptyBlock('Nothing here yet', 'Start an episode or chapter and it will show up here, ready to resume.', '/', 'Browse the index');
      hydrate($('#libBody', el));
      $$('.seg button', el).forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    };
    el.innerHTML = '<div class="page-h"><h1>Library</h1><div class="seg" role="group">' + ['all', 'anime', 'manga'].map((t) => '<button type="button" data-tab="' + t + '">' + cap(t) + '</button>').join('') + '</div></div><div id="libBody"></div>';
    el.addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab]'); if (t) { tab = t.dataset.tab; draw(); }
      const x = e.target.closest('[data-remove]'); if (x) { e.preventDefault(); e.stopPropagation(); cwRemove(Number(x.dataset.remove)); }
    }, true);
    const onCw = () => draw();
    d.addEventListener('cw:update', onCw);
    draw(); cwSync();
    return { destroy() { d.removeEventListener('cw:update', onCw); } };
  }

  /* ── 3.15 browse, search ─────────────────────────────────────────────── */
  const LIST_FIELDS = 'id type title{romaji english} coverImage{large color} averageScore episodes chapters format status seasonYear';
  /** Builds a paged AniList query. Only internal constants are inlined; user text always goes through a variable. */
  function listQuery(o) {
    const decl = ['$page:Int'], args = [], vars = { page: o.page || 1 };
    if (o.type) args.push('type:' + o.type);
    if (o.format) args.push('format:' + o.format);
    if (o.season) { decl.push('$season:MediaSeason', '$year:Int'); args.push('season:$season', 'seasonYear:$year'); vars.season = o.season; vars.year = o.year; }
    if (o.search) { decl.push('$search:String'); args.push('search:$search'); vars.search = o.search; }
    if (o.genre) { decl.push('$genre:String'); args.push('genre:$genre'); vars.genre = o.genre; }
    args.push('sort:' + o.sort, 'isAdult:false');
    return { q: 'query(' + decl.join(',') + '){Page(page:$page,perPage:' + (o.per || 30) + '){pageInfo{hasNextPage} media(' + args.join(',') + '){' + LIST_FIELDS + '}}}', v: vars };
  }

  const BROWSE = {
    trending: { title: 'Trending', sub: 'What everyone is watching right now.', q: { type: 'ANIME', sort: 'TRENDING_DESC' } },
    top: { title: 'Top rated', sub: 'The highest-scoring anime on AniList.', q: { type: 'ANIME', sort: 'SCORE_DESC' } },
    popular: { title: 'All-time favourites', sub: 'Most popular anime of all time.', q: { type: 'ANIME', sort: 'POPULARITY_DESC' } },
    seasonal: { title: 'This season', sub: 'Everything airing, most popular first.', season: true },
    upcoming: { title: 'Coming soon', sub: 'Next season’s most anticipated shows.', q: { type: 'ANIME', sort: 'POPULARITY_DESC' }, next: true },
    manga: { title: 'Top manga', sub: 'The best-reviewed manga.', q: { type: 'MANGA', format: 'MANGA', sort: 'SCORE_DESC' } },
    random: { title: 'Surprise me', sub: 'A random page of popular anime. Shuffle until something looks good.', q: { type: 'ANIME', sort: 'POPULARITY_DESC' }, random: true },
  };

  /** Shared infinite-scroll grid. `makeQuery(page)` → {q, v}. */
  function infiniteGrid(ctx, host, makeQuery, o) {
    o = o || {};
    host.innerHTML = skelGrid(18);
    let page = 0, more = true, busy = false, started = false, io = null, gen = 0;
    const seen = new Set();
    const sentinel = d.createElement('div'); sentinel.className = 'sentinel';
    async function next() {
      if (busy || !more || !ctx.live()) return;
      busy = true; const my = gen;
      try {
        const { q, v } = makeQuery(page + 1);
        const data = await gql(q, v);
        if (my !== gen || !ctx.live()) return;
        const media = reg(data.Page.media.filter((m) => !seen.has(m.id)));
        media.forEach((m) => seen.add(m.id));
        page += 1; more = !!data.Page.pageInfo.hasNextPage && !o.single;
        let grid = $('.grid:not([aria-busy])', host);
        if (!started) { started = true; host.innerHTML = ''; }
        if (!media.length && !grid) { host.innerHTML = emptyBlock(o.emptyTitle || 'No results', o.emptyMsg || 'Try a different search.', '/', 'Back home'); return; }
        if (!grid) { grid = d.createElement('div'); grid.className = 'grid'; host.appendChild(grid); host.appendChild(sentinel); }
        grid.insertAdjacentHTML('beforeend', media.map((m) => cardHtml(m)).join(''));
        hydrate(grid);
        if (!more) sentinel.remove();
      } catch (e) {
        if (my !== gen || !ctx.live()) return;
        if (!started) { host.innerHTML = errorBlock(e, true); } else { toast(e && e.message || 'Could not load more', { kind: 'err', action: 'Retry', onAction: next }); }
      } finally { busy = false; }
      if (more && sentinel.isConnected && io) { /* re-arm observer in case the sentinel stayed visible */ io.unobserve(sentinel); io.observe(sentinel); }
    }
    io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) next(); }, { rootMargin: '900px 0px' }) : null;
    const startObs = () => { if (io) io.observe(sentinel); };
    const onRetry = (e) => { if (e.target.closest('[data-retry]')) { started = false; page = 0; more = true; seen.clear(); host.innerHTML = skelGrid(18); next(); } };
    host.addEventListener('click', onRetry);
    next().then(startObs);
    return { reset() { gen += 1; page = 0; more = true; busy = false; started = false; seen.clear(); host.innerHTML = skelGrid(18); if (io) io.unobserve(sentinel); next().then(startObs); }, destroy() { gen += 1; host.removeEventListener('click', onRetry); if (io) io.disconnect(); } };
  }

  function browseView(ctx) {
    const el = ctx.el, mode = ctx.params[0], cfg = BROWSE[mode];
    if (!cfg) return VIEWS.nf(ctx);
    d.title = cfg.title + ' · The Ledger';
    const cur = seasonNow();
    let season = (ctx.query.get('season') || cur.season).toUpperCase(), year = parseInt(ctx.query.get('year') || cur.year, 10) || cur.year;
    if (['WINTER', 'SPRING', 'SUMMER', 'FALL'].indexOf(season) < 0) season = cur.season;
    const years = []; for (let y = cur.year + 1; y >= 1990; y--) years.push(y);
    el.innerHTML = '<div class="page-h"><div><h1>' + esc(cfg.title) + '</h1><p class="page-sub" id="bSub">' + esc(cfg.sub) + '</p></div>' +
      (cfg.season ? '<div class="filters"><div class="seg" role="group" aria-label="Season">' + ['WINTER', 'SPRING', 'SUMMER', 'FALL'].map((s) => '<button type="button" data-season="' + s + '" class="' + (s === season ? 'on' : '') + '">' + cap(s) + '</button>').join('') + '</div><select id="bYear" aria-label="Year">' + years.map((y) => '<option' + (y === year ? ' selected' : '') + '>' + y + '</option>').join('') + '</select></div>' : '') +
      (cfg.random ? '<button type="button" class="btn" id="bShuffle">' + ic('shuffle') + 'Shuffle</button>' : '') + '</div><div id="bGrid"></div>';
    const host = $('#bGrid', el);
    const nxt = seasonNext();
    let randPage = 1 + Math.floor(Math.random() * 25);
    const makeQuery = (page) => {
      const o = Object.assign({}, cfg.q || {}, { page: cfg.random ? randPage : page });
      if (cfg.season) { o.type = 'ANIME'; o.sort = 'POPULARITY_DESC'; o.season = season; o.year = year; }
      if (cfg.next) { o.season = nxt.season; o.year = nxt.year; }
      return listQuery(o);
    };
    let grid = infiniteGrid(ctx, host, makeQuery, { single: !!cfg.random });
    const refresh = () => { grid.reset(); };
    el.addEventListener('click', (e) => {
      const s = e.target.closest('[data-season]');
      if (s) { season = s.dataset.season; $$('[data-season]', el).forEach((b) => b.classList.toggle('on', b === s)); history.replaceState(history.state, '', '/browse/seasonal?season=' + season + '&year=' + year); refresh(); }
      if (e.target.closest('#bShuffle')) { randPage = 1 + Math.floor(Math.random() * 25); refresh(); }
    });
    const yr = $('#bYear', el);
    if (yr) yr.addEventListener('change', () => { year = parseInt(yr.value, 10); history.replaceState(history.state, '', '/browse/seasonal?season=' + season + '&year=' + year); refresh(); });
    return { destroy() { grid.destroy(); } };
  }

  const GENRES = ['Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller'];
  function searchView(ctx) {
    const el = ctx.el;
    let q = (ctx.query.get('q') || '').trim(), type = ctx.query.get('type') || 'all', genre = ctx.query.get('genre') || '';
    d.title = (q ? q + ' · ' : '') + 'Search · The Ledger';
    el.innerHTML = '<div class="page-h"><h1>Search</h1></div><form class="bigsearch" id="bigForm" role="search">' + ic('search') + '<input id="bigSearch" type="search" placeholder="Search anime, manga…" autocomplete="off" spellcheck="false" aria-label="Search" value="' + esc(q) + '"></form>' +
      '<div class="chips" id="sTypes" role="group">' + [['all', 'All'], ['anime', 'Anime'], ['manga', 'Manga']].map((t) => '<button type="button" class="chip-b' + (t[0] === type ? ' on' : '') + '" data-type="' + t[0] + '">' + t[1] + '</button>').join('') + '</div><div id="sBody"></div>';
    const host = $('#sBody', el), input = $('#bigSearch', el);
    let grid = null;
    const url = () => '/search?' + (q ? 'q=' + encodeURIComponent(q) : '') + (type !== 'all' ? (q ? '&' : '') + 'type=' + type : '') + (genre ? ((q || type !== 'all') ? '&' : '') + 'genre=' + encodeURIComponent(genre) : '');
    const run = () => {
      if (grid) { grid.destroy(); grid = null; }
      history.replaceState(history.state, '', url());
      d.title = (q ? q + ' · ' : '') + 'Search · The Ledger';
      if (!q && !genre) {
        host.innerHTML = '<h2 class="sec-t">Browse by genre</h2><div class="chips wrap">' + GENRES.map((g) => '<a class="chip-b" href="/search?genre=' + encodeURIComponent(g) + (type !== 'all' ? '&type=' + type : '') + '">' + esc(g) + '</a>').join('') + '</div>';
        return;
      }
      grid = infiniteGrid(ctx, host, (page) => listQuery({ page, type: type === 'all' ? '' : type.toUpperCase(), search: q || '', genre: genre || '', sort: q ? 'SEARCH_MATCH' : 'POPULARITY_DESC' }), { emptyTitle: 'Nothing found', emptyMsg: q ? 'No results for “' + q + '”. Check the spelling or try the romaji title.' : 'No titles in this genre.' });
    };
    const typed = debounce(() => { q = input.value.trim(); genre = ''; run(); }, 320);
    input.addEventListener('input', typed);
    $('#bigForm', el).addEventListener('submit', (e) => { e.preventDefault(); q = input.value.trim(); genre = ''; run(); input.blur(); });
    $('#sTypes', el).addEventListener('click', (e) => { const b = e.target.closest('[data-type]'); if (!b) return; type = b.dataset.type; $$('#sTypes .chip-b', el).forEach((x) => x.classList.toggle('on', x === b)); run(); });
    run();
    if (!q && !genre && window.matchMedia('(hover: hover)').matches) input.focus();
    return { destroy() { if (grid) grid.destroy(); } };
  }

  /* ── 3.16 detail ─────────────────────────────────────────────────────── */
  const DETAIL_Q = 'query($id:Int){Media(id:$id){id idMal type format status season seasonYear episodes chapters volumes duration averageScore meanScore popularity favourites genres source countryOfOrigin isAdult description(asHtml:false) bannerImage coverImage{large extraLarge color} title{romaji english native} synonyms startDate{year month day} endDate{year month day} studios(isMain:true){nodes{name}} trailer{id site} nextAiringEpisode{airingAt episode} tags{name rank isMediaSpoiler} relations{edges{relationType(version:2) node{id type format status seasonYear averageScore episodes chapters title{romaji english} coverImage{large color}}}} recommendations(sort:RATING_DESC,perPage:14){nodes{mediaRecommendation{id type format status seasonYear averageScore episodes chapters isAdult title{romaji english} coverImage{large color}}}}}}';
  const CHAIN_FIELDS = 'id type format status season seasonYear title{romaji english} coverImage{large color} averageScore episodes chapters startDate{year month day} relations{edges{relationType(version:2) node{id type format}}}';
  const fmtDate = (dt) => (dt && dt.year ? [dt.year, dt.month ? pad2(dt.month) : '', dt.day ? pad2(dt.day) : ''].filter(Boolean).join('-') : '');
  const dateVal = (m) => { const s = m.startDate || {}; return (s.year || 9999) * 10000 + (s.month || 1) * 100 + (s.day || 1); };
  const neighbors = (edges, type) => (edges || []).filter((e) => (e.relationType === 'PREQUEL' || e.relationType === 'SEQUEL') && e.node && e.node.type === type).map((e) => e.node.id);

  /** Walk PREQUEL/SEQUEL links to collect every season/movie/OVA of the franchise (one batched request per level). */
  async function franchise(m) {
    const nodes = new Map([[m.id, m]]);
    let frontier = neighbors(m.relations && m.relations.edges, m.type);
    for (let level = 0; level < 8 && frontier.length; level++) {
      const ids = Array.from(new Set(frontier)).filter((id) => !nodes.has(id)).slice(0, 14);
      if (!ids.length) break;
      const data = await gql('query{' + ids.map((id, i) => 'a' + i + ':Media(id:' + Number(id) + '){' + CHAIN_FIELDS + '}').join(' ') + '}');
      frontier = [];
      ids.forEach((id, i) => { const n = data['a' + i]; if (n) { nodes.set(n.id, n); frontier = frontier.concat(neighbors(n.relations && n.relations.edges, n.type)); } });
    }
    return Array.from(nodes.values()).sort((a, b) => dateVal(a) - dateVal(b));
  }

  function modal(html, cls) {
    const back = d.createElement('div'); back.className = 'modal-b';
    back.innerHTML = '<div class="modal ' + (cls || '') + '" role="dialog" aria-modal="true">' + html + '<button type="button" class="modal-x" aria-label="Close">' + ic('close') + '</button></div>';
    const prev = d.activeElement;
    const close = () => { back.classList.add('out'); setTimeout(() => back.remove(), 180); d.removeEventListener('keydown', onKey); if (prev && prev.focus) prev.focus(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('.modal-x')) close(); });
    d.addEventListener('keydown', onKey);
    d.body.appendChild(back); requestAnimationFrame(() => back.classList.add('in'));
    const f = $('.modal-x', back); if (f) f.focus();
    return close;
  }

  function detailView(ctx) {
    const id = Number(ctx.params[0]);
    const el = ctx.el;
    const hint = MEDIA.get(id);
    const hintCover = hint && httpsUrl(hint.coverImage && hint.coverImage.large);
    d.title = (hint ? mTitle(hint) + ' · ' : '') + 'The Ledger';
    el.innerHTML = '<section class="d-hero"' + (hint && hint.coverImage && hint.coverImage.color ? ' style="--c:' + esc(hint.coverImage.color) + '"' : '') + '><div class="d-in"><div class="d-cover' + (hintCover ? '' : ' sk') + '">' + (hintCover ? '<img src="' + esc(hintCover) + '" alt="">' : '') + '</div><div class="d-info">' +
      (hint ? '<h1>' + esc(mTitle(hint)) + '</h1><div class="d-kicker">' + esc(metaLine(hint)) + '</div>' : '<div class="sk sk-h1"></div><div class="sk sk-l" style="width:40%"></div>') +
      '<div class="sk sk-l" style="width:70%;margin-top:18px"></div><div class="sk sk-l" style="width:56%"></div><div class="sk sk-btn" style="margin-top:22px"></div></div></div></section><div class="d-body"><div class="sk sk-l" style="width:30%;height:18px"></div><div class="sk sk-l"></div><div class="sk sk-l"></div><div class="sk sk-l" style="width:80%"></div></div>';
    hydrate(el);
    let timer = 0, dead = false;
    const stopFns = [];

    const render = (m) => {
      if (!ctx.live()) return;
      reg([m]);
      const manga = isManga(m);
      const title = mTitle(m);
      const banner = httpsUrl(m.bannerImage);
      const cover = httpsUrl(m.coverImage && (m.coverImage.extraLarge || m.coverImage.large));
      const color = m.coverImage && m.coverImage.color ? m.coverImage.color : '';
      const pct = m.averageScore || 0;
      const studios = (m.studios && m.studios.nodes || []).map((s) => s.name).join(', ');
      const cw = cwGet(m.id);
      const released = m.status !== 'NOT_YET_RELEASED';
      const cwEp = cw && parseNum(cw.label);
      const primary = !released ? '<span class="btn btn-lg btn-off">Not yet released</span>' :
        manga ? '<a class="btn btn-lg" href="/read/' + m.id + '">' + ic('book') + (cw ? 'Continue ' + esc(cw.label || 'reading') : 'Read now') + '</a>'
          : '<a class="btn btn-lg" id="dWatch" href="/watch/' + m.id + (cwEp ? '?ep=' + cwEp : '') + '">' + ic('play') + (cw && cwEp ? 'Resume Ep ' + esc(cwEp) : 'Watch now') + '</a>';
      const trailer = m.trailer && m.trailer.site === 'youtube' && /^[\w-]{6,20}$/.test(m.trailer.id || '') ? '<button type="button" class="btn btn-lg btn-glass" id="dTrailer" data-yt="' + esc(m.trailer.id) + '">' + ic('play') + 'Trailer</button>' : '';
      const kicker = [fmtFormat(m.format), m.status ? cap(m.status.replace(/_/g, ' ').toLowerCase()) : '', m.seasonYear ? (m.season ? cap(m.season) + ' ' : '') + m.seasonYear : ''].filter(Boolean).join(' · ');
      const stats = [
        m.episodes ? m.episodes + ' episodes' : '', m.chapters ? m.chapters + ' chapters' : '', m.volumes ? m.volumes + ' volumes' : '',
        m.duration ? m.duration + ' min' : '', m.popularity ? (m.popularity >= 1000 ? Math.round(m.popularity / 1000) + 'k' : m.popularity) + ' fans' : '',
      ].filter(Boolean);
      const ring = pct ? '<div class="ring" style="--p:' + pct + '" title="Average score ' + pct + '%"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15.5"/><circle class="v" cx="18" cy="18" r="15.5" pathLength="100" stroke-dasharray="' + pct + ' 100"/></svg><b>' + (pct / 10).toFixed(1) + '</b></div>' : '';
      const facts = [
        ['Format', fmtFormat(m.format)], ['Status', m.status ? cap(m.status.replace(/_/g, ' ').toLowerCase()) : ''], [manga ? 'Chapters' : 'Episodes', m.episodes || m.chapters || ''], ['Duration', m.duration ? m.duration + ' min per episode' : ''],
        ['Season', m.seasonYear ? (m.season ? cap(m.season) + ' ' : '') + m.seasonYear : ''], ['Started', fmtDate(m.startDate)], ['Ended', fmtDate(m.endDate)], ['Studio', studios], ['Source', m.source ? cap(m.source.replace(/_/g, ' ').toLowerCase()) : ''], ['Country', m.countryOfOrigin || ''],
      ].filter((f) => f[1] !== '' && f[1] != null);
      const tags = (m.tags || []).filter((t) => !t.isMediaSpoiler && t.rank >= 50).slice(0, 8);
      const alt = [m.title.romaji && m.title.romaji !== title ? m.title.romaji : '', m.title.native].filter(Boolean).join(' · ');
      const desc = cleanDesc(m.description);
      d.title = title + ' · The Ledger';
      el.innerHTML = '<section class="d-hero"' + (color ? ' style="--c:' + esc(color) + '"' : '') + '>' + (banner ? '<img class="d-bg" src="' + esc(banner) + '" alt="" decoding="async">' : cover ? '<img class="d-bg blur" src="' + esc(cover) + '" alt="" decoding="async">' : '') + '<div class="d-fade"></div>' +
        '<div class="d-in"><div class="d-cover">' + (cover ? '<img src="' + esc(cover) + '" alt="' + esc(title) + ' cover" decoding="async">' : '') + '</div><div class="d-info">' +
        '<button type="button" class="d-back" data-back>' + ic('arrowL') + 'Back</button><div class="d-kicker">' + esc(kicker) + '</div><h1>' + esc(title) + '</h1>' + (alt ? '<div class="d-alt">' + esc(alt) + '</div>' : '') +
        '<div class="d-stats">' + ring + '<div class="d-stat-l">' + stats.map((s) => '<span>' + esc(s) + '</span>').join('') + '</div></div>' +
        ((m.genres || []).length ? '<div class="chips">' + m.genres.map((g) => '<a class="chip-b" href="/search?genre=' + encodeURIComponent(g) + '">' + esc(g) + '</a>').join('') + '</div>' : '') +
        '<div class="d-actions">' + primary + trailer + '</div><div class="d-air" id="dAir"></div></div></div></section>' +
        '<div class="d-body"><div class="d-main"><section><h2 class="sec-t">Synopsis</h2>' + (desc ? '<p class="d-syn clamp" id="dSyn">' + esc(desc) + '</p><button type="button" class="link-b" id="dMore" hidden>Read more</button>' : '<p class="muted">No synopsis available.</p>') + '</section>' +
        (tags.length ? '<section><h2 class="sec-t">Tags</h2><div class="chips wrap">' + tags.map((t) => '<span class="chip-b flat" title="' + t.rank + '%">' + esc(t.name) + '</span>').join('') + '</div></section>' : '') + '</div>' +
        '<aside class="d-facts"><h2 class="sec-t">Details</h2><dl>' + facts.map((f) => '<div><dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd></div>').join('') + '</dl></aside></div>' +
        '<div class="d-rails" id="dRails"><div id="chainBox">' + skelRail(manga ? 'Volumes & related' : 'Seasons & movies', 6) + '</div><div id="relBox"></div><div id="recBox"></div></div>';
      hydrate(el);
      const syn = $('#dSyn', el), more = $('#dMore', el);
      if (syn && more && syn.scrollHeight > syn.clientHeight + 4) { more.hidden = false; more.addEventListener('click', () => { const open = syn.classList.toggle('clamp'); more.textContent = open ? 'Read more' : 'Show less'; }); }
      // next-airing countdown
      const n = m.nextAiringEpisode;
      if (n && n.airingAt && m.status === 'RELEASING') {
        const air = $('#dAir', el);
        const tick = () => { const left = n.airingAt - Date.now() / 1000; air.innerHTML = left > 0 ? ic('bell') + '<span>Episode <b>' + n.episode + '</b> airs in <b>' + fmtDays(left) + '</b></span>' : ''; air.classList.toggle('on', left > 0); };
        tick(); timer = setInterval(tick, 30000);
      }
      const tr = $('#dTrailer', el);
      if (tr) tr.addEventListener('click', () => modal('<div class="trailer"><iframe src="https://www.youtube-nocookie.com/embed/' + esc(tr.dataset.yt) + '?autoplay=1&rel=0" title="Trailer" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>', 'modal-wide'));
      // Warm the watch page as soon as intent is clear.
      const dw = $('#dWatch', el);
      if (dw) { const w = () => prefetchWatch(m.id); dw.addEventListener('pointerenter', w, { once: true }); dw.addEventListener('touchstart', w, { once: true, passive: true }); idle(w, 3000); }

      // related (non-chain) + recommendations
      const REL = { ADAPTATION: 'Adaptation', SIDE_STORY: 'Side story', SPIN_OFF: 'Spin-off', ALTERNATIVE: 'Alternative', PARENT: 'Parent story', SUMMARY: 'Summary', CHARACTER: 'Shared characters', OTHER: 'Related', COMPILATION: 'Compilation', CONTAINS: 'Contains' };
      const rel = (m.relations && m.relations.edges || []).filter((e) => e.node && e.relationType !== 'PREQUEL' && e.relationType !== 'SEQUEL' && REL[e.relationType]);
      reg(rel.map((e) => e.node));
      $('#relBox', el).innerHTML = rel.length ? railHtml('rel', 'Related', rel.map((e) => cardHtml(e.node, { sub: REL[e.relationType] + (e.node.format ? ' · ' + fmtFormat(e.node.format) : '') }))) : '';
      const recs = (m.recommendations && m.recommendations.nodes || []).map((r) => r.mediaRecommendation).filter((x) => x && !x.isAdult);
      reg(recs);
      $('#recBox', el).innerHTML = recs.length ? railHtml('rec', 'You might also like', recs.map((x) => cardHtml(x))) : '';
      hydrate(el);

      // all seasons rail (async, cached)
      const chainTarget = $('#chainBox', el);
      const hasLinks = neighbors(m.relations && m.relations.edges, m.type).length > 0;
      if (!hasLinks) { chainTarget.innerHTML = ''; return; }
      let tvIdx = 0;
      const drawChain = (list) => {
        if (!ctx.live() || !chainTarget.isConnected) return;
        if (!list || list.length < 2) { chainTarget.innerHTML = ''; return; }
        reg(list);
        const cards = list.map((x) => {
          let sub = fmtFormat(x.format) || '';
          if (x.format === 'TV' || x.format === 'TV_SHORT') { tvIdx += 1; sub = 'Season ' + tvIdx; }
          if (x.startDate && x.startDate.year) sub += (sub ? ' · ' : '') + x.startDate.year;
          return cardHtml(x, { sub, cls: x.id === m.id ? 'on' : '' });
        });
        chainTarget.innerHTML = railHtml('chain', manga ? 'Volumes & related' : 'Seasons & movies', cards);
        hydrate(chainTarget);
        const on = $('.card.on', chainTarget), track = $('.rail-t', chainTarget);
        if (on && track) track.scrollLeft = Math.max(0, on.offsetLeft - track.clientWidth / 2 + on.clientWidth / 2);
      };
      swr('chain:' + m.id, 3 * 24 * 3600 * 1000, () => franchise(m), (list) => { tvIdx = 0; drawChain(list); }).catch(() => { chainTarget.innerHTML = ''; });
    };

    const load = () => swr('d:' + id, 30 * 60 * 1000, async () => (await gql(DETAIL_Q, { id })).Media, (m) => { if (!m) throw new Error('Not found'); render(m); })
      .catch((e) => { if (!ctx.live()) return; el.innerHTML = e && (e.status === 404 || /not found/i.test(e.message || '')) ? emptyBlock('Title not found', 'This record is not in the index.', '/', 'Back home') : errorBlock(e, true); });
    el.addEventListener('click', (e) => { if (e.target.closest('[data-retry]')) { el.innerHTML = ''; load(); } const b = e.target.closest('[data-back]'); if (b) { if (history.length > 1) history.back(); else navigate('/'); } });
    const onCw = () => { const w = $('#dWatch', el); const cw = cwGet(id); if (w && cw && parseNum(cw.label)) { w.setAttribute('href', '/watch/' + id + '?ep=' + parseNum(cw.label)); } };
    d.addEventListener('cw:update', onCw);
    load();
    return { destroy() { dead = true; clearInterval(timer); d.removeEventListener('cw:update', onCw); stopFns.forEach((f) => f()); } };
  }

  function nfView(ctx) {
    d.title = 'Not found · The Ledger';
    ctx.el.innerHTML = '<div class="empty big"><div class="nf-code">404</div><h3>This record isn’t in the index</h3><p>The page you’re looking for doesn’t exist or may have moved.</p><a class="btn btn-lg" href="/">Back home</a></div>';
    return {};
  }

  const VIEWS = { home: homeView, detail: detailView, watch: watchView, read: readView, browse: browseView, search: searchView, library: libraryView, nf: nfView };

  /* ── 3.17 player: libraries, subtitles, stream helpers ───────────────── */
  const proxyUrl = (u, ref) => {
    if (!u) return u;
    let out = (CFG.proxy || '') + encodeURIComponent(u);
    if (CFG.refParam && ref) out += '&' + CFG.refParam + '=' + encodeURIComponent(ref);
    return out;
  };
  const origFromProxy = (u) => { try { const x = new URL(u); const o = x.searchParams.get('url'); return o || u; } catch { return u; } };

  const scriptP = new Map();
  function loadScriptOnce(urls) {
    const key = urls[0];
    if (scriptP.has(key)) return scriptP.get(key);
    const p = new Promise((resolve, reject) => {
      let i = 0;
      const tryNext = () => {
        if (i >= urls.length) { reject(new Error('Could not load the video engine (blocked network?)')); return; }
        const s = d.createElement('script'); s.src = urls[i++]; s.async = true;
        s.onload = () => resolve(); s.onerror = () => { s.remove(); tryNext(); };
        d.head.appendChild(s);
      };
      tryNext();
    });
    p.catch(() => scriptP.delete(key));
    scriptP.set(key, p);
    return p;
  }
  const getHls = () => (window.Hls ? Promise.resolve(window.Hls) : loadScriptOnce(['https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.17/hls.min.js', 'https://unpkg.com/hls.js@1.5.17/dist/hls.min.js']).then(() => window.Hls));
  const getDash = () => (window.dashjs ? Promise.resolve(window.dashjs) : loadScriptOnce(['https://cdnjs.cloudflare.com/ajax/libs/dashjs/4.7.4/dash.all.min.js', 'https://cdn.jsdelivr.net/npm/dashjs@4.7.4/dist/dash.all.min.js']).then(() => window.dashjs));

  /* FlixCloud (ReAnime): manifests may be base64+XOR, segments may be wrapped in PNG/WebP. See the Anivexa README. */
  const FLIX_XOR = Uint8Array.from([157, 42, 241, 71, 179, 142, 92, 112, 166, 25, 228, 59, 216, 98, 15, 197]);
  function b64Bytes(b64) { const bin = atob(String(b64).replace(/\s+/g, '')); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function flixDecrypt(text, keyB64) {
    const t = String(text).trim();
    if (t.indexOf('#EXTM3U') === 0) return t;
    const key = b64Bytes(keyB64), payload = b64Bytes(t), out = new Uint8Array(payload.length);
    for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ key[i % key.length];
    const s = new TextDecoder().decode(out).trim();
    if (s.indexOf('#EXTM3U') !== 0) throw new Error('FlixCloud manifest decrypt failed');
    return s;
  }
  function proxyManifest(text, base, ref) {
    const abs = (u) => { try { return proxyUrl(new URL(u, base).href, ref); } catch { return u; } };
    return text.split(/\r?\n/).map((line) => {
      const l = line.trim();
      if (!l) return line;
      if (l[0] === '#') return line.replace(/URI="([^"]+)"/g, (_, u) => 'URI="' + abs(u) + '"');
      return abs(l);
    }).join('\n');
  }
  function unwrapFlixSegment(buf) {
    const b = new Uint8Array(buf);
    const webp = b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
    const png = b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a;
    if (!webp && !png) return buf;
    const off = webp ? 12 : 8;
    const out = b.slice(off);
    if (b[off] !== 0x47) for (let i = 0; i < out.length; i++) out[i] ^= FLIX_XOR[i % FLIX_XOR.length];
    return out.buffer;
  }
  function makeFlixLoader(Hls, key, ref) {
    const Base = Hls.DefaultConfig.loader;
    return class FlixLoader extends Base {
      load(context, config, callbacks) {
        const isPl = context.type === 'manifest' || context.type === 'level' || context.type === 'audioTrack' || context.type === 'subtitleTrack';
        const ok = callbacks.onSuccess;
        const wrapped = Object.assign({}, callbacks, {
          onSuccess: (resp, stats, ctx, net) => {
            try {
              if (isPl && typeof resp.data === 'string' && resp.data.trim().indexOf('#EXTM3U') !== 0) resp.data = proxyManifest(flixDecrypt(resp.data, key), origFromProxy(ctx.url), ref);
              else if (!isPl && resp.data instanceof ArrayBuffer) resp.data = unwrapFlixSegment(resp.data);
            } catch { /* hand the response over untouched */ }
            ok(resp, stats, ctx, net);
          },
        });
        super.load(context, config, wrapped);
      }
    };
  }

  /* subtitles → WebVTT */
  function assToVtt(text) {
    const lines = text.replace(/\r/g, '').split('\n');
    let inEvents = false, cols = null, si = 1, ei = 2, ti = 9;
    const out = ['WEBVTT', ''];
    const time = (s) => { const m = String(s).trim().match(/(\d+):(\d{2}):(\d{2})[.:](\d{1,3})/); return m ? pad2(m[1]) + ':' + m[2] + ':' + m[3] + '.' + (m[4] + '00').slice(0, 3) : '00:00:00.000'; };
    for (const raw of lines) {
      const l = raw.trim();
      if (/^\[events\]/i.test(l)) { inEvents = true; continue; }
      if (/^\[/.test(l)) { inEvents = false; continue; }
      if (!inEvents) continue;
      if (/^format:/i.test(l)) { cols = l.slice(7).split(',').map((c) => c.trim().toLowerCase()); si = cols.indexOf('start'); ei = cols.indexOf('end'); ti = cols.indexOf('text'); continue; }
      if (/^dialogue:/i.test(l)) {
        const n = cols ? cols.length : 10;
        const parts = l.slice(9).split(',');
        const txt = parts.slice(ti >= 0 ? ti : n - 1).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').replace(/\\h/g, ' ').trim();
        if (!txt) continue;
        out.push(time(parts[si >= 0 ? si : 1]) + ' --> ' + time(parts[ei >= 0 ? ei : 2]), txt, '');
      }
    }
    return out.join('\n');
  }
  function toVtt(text) {
    text = String(text).replace(/^﻿/, '');
    if (/^\s*WEBVTT/.test(text)) return text;
    if (/\[events\]/i.test(text) || /^dialogue:/im.test(text)) return assToVtt(text);
    return 'WEBVTT\n\n' + text.replace(/\r/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  }
  const normRange = (r) => {
    if (!r) return null;
    let s, e;
    if (Array.isArray(r)) { s = Number(r[0]); e = Number(r[1]); } else { s = Number(r.start != null ? r.start : r.s != null ? r.s : r.startTime); e = Number(r.end != null ? r.end : r.e != null ? r.e : r.endTime); }
    return Number.isFinite(s) && Number.isFinite(e) && e > s && e > 0 ? { start: Math.max(0, s), end: e } : null;
  };

  /* ── 3.18 the player ─────────────────────────────────────────────────── */
  /**
   * createPlayer(root, cb) → controller.
   * cb: onFail(reason, {time}), onEnded(), onNext(auto), onPrev(), onTick({t, dur}), onState({playing})
   */
  function createPlayer(root, cb) {
    root.innerHTML =
      '<video class="pl-v" playsinline preload="auto"></video><div class="pl-embed"></div><div class="pl-shade"></div>' +
      '<div class="pl-top"><div class="pl-ttl"><b data-t="title"></b><small data-t="sub"></small></div></div>' +
      '<button type="button" class="pl-big" data-act="play" aria-label="Play">' + ic('play') + '</button>' +
      '<div class="pl-spin"><i></i><span data-t="cap"></span></div><div class="pl-flash" data-t="flash"></div>' +
      '<div class="pl-err" role="alert"><div class="pl-err-i">' + ic('alert') + '</div><b data-t="errTitle">Playback problem</b><p data-t="errMsg"></p><div class="pl-err-a" data-t="errActs"></div></div>' +
      '<button type="button" class="pl-skip" data-act="skip">Skip intro' + ic('chevR') + '</button>' +
      '<div class="pl-next"><button type="button" class="pl-next-b" data-act="next-up"><span class="pl-next-r"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="16"/><circle class="v" cx="18" cy="18" r="16" pathLength="100"/></svg>' + ic('next') + '</span><span><small data-t="nextHead">Up next</small><b data-t="nextLabel"></b></span></button><button type="button" class="pl-next-x" data-act="next-cancel" aria-label="Dismiss">' + ic('close') + '</button></div>' +
      '<div class="pl-end"><button type="button" data-act="replay">' + ic('refresh') + 'Replay</button></div>' +
      '<div class="pl-ctl"><div class="pl-seek" role="slider" aria-label="Seek" tabindex="0" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="pl-rail"><i class="pl-buf"></i><i class="pl-prog"></i><span class="pl-mk" data-t="mkIntro"></span><span class="pl-mk" data-t="mkOutro"></span></div><b class="pl-knob"></b><span class="pl-tip" data-t="tip">0:00</span></div>' +
      '<div class="pl-row"><div class="pl-g">' +
      '<button type="button" class="pl-btn" data-act="play" data-t="playBtn" aria-label="Play">' + ic('play') + '</button>' +
      '<button type="button" class="pl-btn hide-s" data-act="prev" aria-label="Previous episode">' + ic('prev') + '</button>' +
      '<button type="button" class="pl-btn" data-act="next" aria-label="Next episode">' + ic('next') + '</button>' +
      '<button type="button" class="pl-btn hide-s" data-act="back" aria-label="Back 10 seconds">' + ic('back10') + '</button>' +
      '<button type="button" class="pl-btn hide-s" data-act="fwd" aria-label="Forward 10 seconds">' + ic('fwd10') + '</button>' +
      '<div class="pl-vol"><button type="button" class="pl-btn" data-act="mute" data-t="muteBtn" aria-label="Mute">' + ic('volume') + '</button><input type="range" min="0" max="1" step="0.02" value="1" data-t="vol" aria-label="Volume"></div>' +
      '<span class="pl-time" data-t="time">0:00 / 0:00</span></div><div class="pl-g">' +
      '<button type="button" class="pl-btn" data-act="cc" aria-label="Subtitles" aria-haspopup="true">' + ic('cc') + '</button>' +
      '<button type="button" class="pl-btn" data-act="set" aria-label="Settings" aria-haspopup="true">' + ic('sliders') + '</button>' +
      '<button type="button" class="pl-btn hide-s" data-act="pip" data-t="pipBtn" aria-label="Picture in picture">' + ic('pip') + '</button>' +
      '<button type="button" class="pl-btn" data-act="fs" data-t="fsBtn" aria-label="Fullscreen">' + ic('fullscreen') + '</button></div></div></div>' +
      '<div class="pl-pop" data-t="pop" role="menu" hidden></div>';

    const T = {}; $$('[data-t]', root).forEach((e) => { T[e.dataset.t] = e; });
    const v = $('.pl-v', root), seek = $('.pl-seek', root), prog = $('.pl-prog', root), buf = $('.pl-buf', root), knob = $('.pl-knob', root), vol = T.vol, pop = T.pop;
    const offs = [];
    const on = (t, ev, fn, o) => { t.addEventListener(ev, fn, o); offs.push(() => t.removeEventListener(ev, fn, o)); };
    const S = { cur: null, hls: null, dash: null, started: false, failed: false, loadId: 0, ranges: { intro: null, outro: null }, skipped: {}, hasNext: false, hasPrev: false, nextLabel: '', nextDismissed: false, countdown: 0, levels: [], level: -1, subs: [], subSel: -1, subUrls: new Map(), watchdog: 0, idleT: 0, menu: '', seeking: false, raf: 0, resumeAt: 0, retries: 0, tracks: [], subAuto: true };

    /* chrome state helpers */
    // Native captions sit at the bottom edge; lift them above the control bar while it is visible.
    const cueLift = () => {
      const tt = v.textTracks && v.textTracks[0]; if (!tt || !tt.cues) return;
      const line = root.classList.contains('is-idle') || root.classList.contains('is-embed') ? -2 : (root.offsetHeight < 340 ? -6 : -5);
      for (let i = 0; i < tt.cues.length; i++) { const c = tt.cues[i]; if (c.snapToLines !== false && c.line !== line) { try { c.line = line; } catch { /* ignore */ } } }
    };
    const cls = (c, on_) => { root.classList.toggle(c, !!on_); if (c === 'is-idle') cueLift(); };
    const setT = (k, txt) => { if (T[k]) T[k].textContent = txt; };
    const setIcon = (btn, name) => { if (btn) btn.innerHTML = ic(name); };
    const loading = (on_, cap) => { cls('is-loading', on_); setT('cap', cap || ''); };
    function flash(html) { const f = T.flash; f.innerHTML = html; f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }

    function showErr(title, msg, acts) {
      loading(false); cls('is-error', true); cls('is-idle', false);
      setT('errTitle', title || 'Playback problem'); setT('errMsg', msg || '');
      T.errActs.innerHTML = (acts || []).map((a) => '<button type="button" class="btn btn-sm' + (a.ghost ? ' btn-glass' : '') + '" data-err="' + esc(a.id) + '">' + esc(a.label) + '</button>').join('');
    }
    function hideErr() { cls('is-error', false); }

    /* ── time / progress ── */
    const dur = () => (isFinite(v.duration) ? v.duration : 0);
    function paintTime() {
      const t = v.currentTime || 0, dd = dur();
      if (!S.seeking) {
        const p = dd ? clamp(t / dd, 0, 1) : 0;
        prog.style.transform = 'scaleX(' + p + ')'; knob.style.left = p * 100 + '%';
        seek.setAttribute('aria-valuenow', String(Math.round(p * 100)));
      }
      setT('time', fmtTime(t) + ' / ' + fmtTime(dd));
      if (v.buffered && v.buffered.length && dd) {
        let end = 0; for (let i = 0; i < v.buffered.length; i++) { if (v.buffered.start(i) <= t + 0.5 && v.buffered.end(i) >= t) end = v.buffered.end(i); }
        buf.style.transform = 'scaleX(' + clamp(end / dd, 0, 1) + ')';
      }
    }
    function loop() { paintTime(); if (!v.paused && !v.ended) S.raf = requestAnimationFrame(loop); }
    function markRanges() {
      const dd = dur(); if (!dd) return;
      [['mkIntro', S.ranges.intro], ['mkOutro', S.ranges.outro]].forEach(([k, r]) => {
        const e = T[k]; if (!r) { e.style.display = 'none'; return; }
        e.style.display = 'block'; e.style.left = (r.start / dd) * 100 + '%'; e.style.width = (Math.min(r.end, dd) - r.start) / dd * 100 + '%';
      });
    }
    function checkRanges() {
      const t = v.currentTime, dd = dur();
      let show = '';
      ['intro', 'outro'].forEach((k) => {
        const r = S.ranges[k];
        if (!r || show) return;
        if (t >= r.start - 0.5 && t < r.end - 1.5) {
          if (prefs.autoskip && !S.skipped[k] && !v.paused) { S.skipped[k] = true; v.currentTime = r.end; flash(ic('next') + '<span>Skipped ' + k + '</span>'); } else show = k;
        }
      });
      const btn = $('.pl-skip', root);
      btn.dataset.kind = show; btn.classList.toggle('on', !!show);
      if (show) btn.firstChild.textContent = 'Skip ' + show;
      // "up next" card: last 25 s of the episode (or while the outro plays)
      const near = dd > 60 && dd - t < 25 && S.hasNext && !S.nextDismissed;
      cls('show-next', near || S.countdown > 0);
    }

    let lastTick = 0;
    on(v, 'timeupdate', () => { checkRanges(); const n = Date.now(); if (n - lastTick > 1000) { lastTick = n; cb.onTick && cb.onTick({ t: v.currentTime, dur: dur() }); updateSession(); } });
    on(v, 'durationchange', () => { markRanges(); paintTime(); });
    on(v, 'loadedmetadata', () => { markRanges(); paintTime(); if (S.resumeAt > 1 && Math.abs(v.currentTime - S.resumeAt) > 2 && !S.hls) { try { v.currentTime = S.resumeAt; } catch { /* not seekable yet */ } } });
    on(v, 'play', () => { cls('is-playing', true); cls('is-ended', false); cancelAnimationFrame(S.raf); S.raf = requestAnimationFrame(loop); setIcon(T.playBtn, 'pause'); cb.onState && cb.onState({ playing: true }); wake(); });
    on(v, 'pause', () => { cls('is-playing', false); setIcon(T.playBtn, 'play'); paintTime(); cb.onState && cb.onState({ playing: false }); wake(); if (cb.onTick) cb.onTick({ t: v.currentTime, dur: dur(), pause: true }); });
    on(v, 'waiting', () => { if (S.started) loading(true, ''); });
    on(v, 'seeking', () => { if (S.started && !v.paused) loading(true, ''); });
    on(v, 'playing', () => { S.started = true; S.retries = 0; clearTimeout(S.watchdog); loading(false); hideErr(); });
    on(v, 'canplay', () => { if (S.started) loading(false); });
    on(v, 'ended', () => {
      cls('is-ended', true); cls('is-playing', false); setIcon(T.playBtn, 'play');
      if (cb.onEnded) cb.onEnded();
      if (S.hasNext && prefs.autoplay) startCountdown(); else if (S.hasNext) cls('show-next', true);
    });
    on(v, 'volumechange', () => { vol.value = v.muted ? 0 : v.volume; setIcon(T.muteBtn, v.muted || v.volume === 0 ? 'mute' : v.volume < 0.5 ? 'volLow' : 'volume'); });
    on(v, 'error', () => { if (S.cur && S.cur.type !== 'hls' && !S.failed) fail(v.error && v.error.message || 'The video could not be played', true); });
    on(v, 'enterpictureinpicture', () => cls('is-pip', true));
    on(v, 'leavepictureinpicture', () => cls('is-pip', false));

    function startCountdown() {
      cancelCountdown(); S.countdown = 5; cls('show-next', true);
      const ring = $('.pl-next-r .v', root); ring.style.transition = 'none'; ring.style.strokeDashoffset = '100'; void ring.getBoundingClientRect(); ring.style.transition = 'stroke-dashoffset 5s linear'; ring.style.strokeDashoffset = '0';
      setT('nextHead', 'Next episode in 5');
      S.cdT = setInterval(() => { S.countdown -= 1; if (S.countdown <= 0) { cancelCountdown(); cb.onNext && cb.onNext(true); } else setT('nextHead', 'Next episode in ' + S.countdown); }, 1000);
    }
    function cancelCountdown() { clearInterval(S.cdT); S.countdown = 0; setT('nextHead', 'Up next'); const ring = $('.pl-next-r .v', root); if (ring) { ring.style.transition = 'none'; ring.style.strokeDashoffset = '100'; } }

    /* ── actions ── */
    const toggle = () => { if (S.cur && S.cur.type === 'embed') return; if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); } else v.pause(); };
    function seekBy(sec, show) {
      if (!dur()) return;
      v.currentTime = clamp(v.currentTime + sec, 0, dur());
      if (show !== false) flash(ic(sec < 0 ? 'back10' : 'fwd10') + '<span>' + (sec < 0 ? '−' : '+') + Math.abs(sec) + 's</span>');
      paintTime();
    }
    function setVol(x) { v.volume = clamp(x, 0, 1); v.muted = v.volume === 0; prefs.volume = v.volume; prefs.muted = v.muted; savePrefs(); }
    function fsEl() { return d.fullscreenElement || d.webkitFullscreenElement; }
    function toggleFs() {
      if (fsEl()) { (d.exitFullscreen || d.webkitExitFullscreen).call(d); return; }
      const f = root.requestFullscreen || root.webkitRequestFullscreen;
      if (f) { Promise.resolve(f.call(root, { navigationUI: 'hide' })).then(() => { try { if (screen.orientation && screen.orientation.lock && matchMedia('(pointer:coarse)').matches) screen.orientation.lock('landscape').catch(() => {}); } catch { /* ignore */ } }).catch(() => {}); }
      else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
    }
    on(d, 'fullscreenchange', () => { const f = fsEl() === root; cls('is-fs', f); setIcon(T.fsBtn, f ? 'exitFs' : 'fullscreen'); if (!f) { try { screen.orientation && screen.orientation.unlock && screen.orientation.unlock(); } catch { /* ignore */ } } });
    function togglePip() { if (d.pictureInPictureElement) d.exitPictureInPicture().catch(() => {}); else if (v.requestPictureInPicture) v.requestPictureInPicture().catch(() => toast('Picture-in-picture is not available for this video')); }
    if (!d.pictureInPictureEnabled) T.pipBtn.style.display = 'none';

    /* ── popover menus (subtitles / settings) ── */
    function closeMenu() { S.menu = ''; pop.hidden = true; cls('pop-open', false); }
    function openMenu(kind) {
      if (S.menu === kind) { closeMenu(); return; }
      S.menu = kind; cls('pop-open', true);
      if (kind === 'cc') {
        pop.innerHTML = '<div class="pop-h">Subtitles</div>' + '<button type="button" class="pop-i' + (S.subSel < 0 ? ' on' : '') + '" data-sub="-1">Off' + (S.subSel < 0 ? ic('check') : '') + '</button>' +
          S.subs.map((s, i) => '<button type="button" class="pop-i' + (i === S.subSel ? ' on' : '') + '" data-sub="' + i + '">' + esc(s.label || s.srclang || 'Track ' + (i + 1)) + (i === S.subSel ? ic('check') : '') + '</button>').join('') +
          (S.subs.length ? '' : '<div class="pop-none">No subtitle tracks for this stream.</div>');
      } else {
        const lv = S.levels.length ? '<div class="pop-h">Quality</div><button type="button" class="pop-i' + (S.level === -1 ? ' on' : '') + '" data-q="-1">Auto' + (S.level === -1 ? ic('check') : '') + '</button>' + S.levels.map((l) => '<button type="button" class="pop-i' + (S.level === l.i ? ' on' : '') + '" data-q="' + l.i + '">' + l.h + 'p' + (S.level === l.i ? ic('check') : '') + '</button>').join('') : '';
        pop.innerHTML = lv + '<div class="pop-h">Speed</div>' + [0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => '<button type="button" class="pop-i' + (v.playbackRate === s ? ' on' : '') + '" data-speed="' + s + '">' + (s === 1 ? 'Normal' : s + '×') + (v.playbackRate === s ? ic('check') : '') + '</button>').join('');
      }
      pop.hidden = false; wake();
    }
    on(pop, 'click', (e) => {
      const sub = e.target.closest('[data-sub]'), q = e.target.closest('[data-q]'), sp = e.target.closest('[data-speed]');
      if (sub) { selectSub(Number(sub.dataset.sub), true); closeMenu(); }
      else if (q) { S.level = Number(q.dataset.q); if (S.hls) S.hls.currentLevel = S.level; closeMenu(); flash('<span>' + (S.level < 0 ? 'Auto quality' : S.levels.find((l) => l.i === S.level).h + 'p') + '</span>'); }
      else if (sp) { v.playbackRate = Number(sp.dataset.speed); prefs.speed = v.playbackRate; savePrefs(); closeMenu(); flash('<span>' + v.playbackRate + '×</span>'); }
    });
    on(d, 'pointerdown', (e) => { if (S.menu && !e.target.closest('.pl-pop') && !e.target.closest('[data-act=cc],[data-act=set]')) closeMenu(); });

    /* ── subtitles ── */
    async function selectSub(i, user) {
      $$('track', v).forEach((t) => t.remove());
      if (i < 0 || !S.subs[i]) { S.subSel = -1; if (user) { prefs.cc = 'off'; savePrefs(); } return; }
      const s = S.subs[i]; const myLoad = S.loadId;
      try {
        let url = S.subUrls.get(s.url);
        if (!url) {
          const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
          const r = await fetch(proxyUrl(s.url, S.cur && S.cur.referer), { signal: ctl.signal }); clearTimeout(t);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          url = URL.createObjectURL(new Blob([toVtt(await r.text())], { type: 'text/vtt' }));
          S.subUrls.set(s.url, url);
        }
        if (myLoad !== S.loadId) return;
        $$('track', v).forEach((t) => t.remove());
        const tr = d.createElement('track'); tr.kind = 'subtitles'; tr.label = s.label || 'Subtitles'; tr.srclang = s.srclang || 'en'; tr.src = url; tr.default = true;
        v.appendChild(tr); tr.track.mode = 'showing'; S.subSel = i; tr.addEventListener('load', cueLift); setTimeout(cueLift, 250);
        if (user) { prefs.cc = (s.srclang || 'en').slice(0, 2).toLowerCase(); savePrefs(); flash(ic('cc') + '<span>' + esc(s.label || 'Subtitles') + '</span>'); }
      } catch { if (user) toast('Could not load that subtitle track', { kind: 'err' }); }
    }
    function pickDefaultSub() {
      if (!S.subs.length || prefs.cc === 'off') { selectSub(-1); return; }
      const want = String(prefs.cc || 'en').slice(0, 2).toLowerCase();
      let i = S.subs.findIndex((s) => String(s.srclang || '').slice(0, 2).toLowerCase() === want && s.default);
      if (i < 0) i = S.subs.findIndex((s) => String(s.srclang || '').slice(0, 2).toLowerCase() === want);
      if (i < 0) i = S.subs.findIndex((s) => /english/i.test(s.label || ''));
      if (i < 0) i = S.subs.findIndex((s) => s.default);
      selectSub(i);
    }

    /* ── loading streams ── */
    function teardown() {
      clearTimeout(S.watchdog);
      if (S.hls) { try { S.hls.destroy(); } catch { /* ignore */ } S.hls = null; }
      if (S.dash) { try { S.dash.reset(); } catch { /* ignore */ } S.dash = null; }
      try { v.pause(); } catch { /* ignore */ }
      v.removeAttribute('src'); $$('track', v).forEach((t) => t.remove()); try { v.load(); } catch { /* ignore */ }
      T.pop.hidden = true; S.menu = ''; S.levels = []; S.level = -1; S.started = false; S.failed = false;
      T.mkIntro.style.display = T.mkOutro.style.display = 'none';
      $('.pl-embed', root).innerHTML = ''; cls('is-embed', false); cls('is-ended', false); cls('show-next', false); cancelCountdown();
      prog.style.transform = 'scaleX(0)'; buf.style.transform = 'scaleX(0)'; knob.style.left = '0%'; setT('time', '0:00 / 0:00');
    }
    // net = the video could not be fetched at all (video proxy / CDN unreachable or refusing), as opposed to a bad file or decode problem.
    function fail(reason, net) {
      if (S.failed) return;
      S.failed = true; clearTimeout(S.watchdog); loading(false);
      cb.onFail && cb.onFail(reason, { time: v.currentTime || S.resumeAt || 0, started: S.started, net: !!net && !S.started });
    }
    const armWatchdog = (ms) => { clearTimeout(S.watchdog); S.watchdog = setTimeout(() => { if (!S.started) fail('The stream took too long to start', true); }, ms || 25000); };
    const begin = () => { v.volume = prefs.volume; v.muted = prefs.muted; v.playbackRate = prefs.speed || 1; const p = v.play(); if (p && p.catch) p.catch(() => { loading(false); cls('is-idle', false); }); };

    async function loadHls(stream, o) {
      const Hls = await getHls();
      const my = S.loadId;
      if (Hls && Hls.isSupported()) {
        const conf = { enableWorker: true, lowLatencyMode: false, capLevelToPlayerSize: true, startFragPrefetch: true, maxBufferLength: 40, backBufferLength: 60, startPosition: o.resumeAt > 1 ? o.resumeAt : -1, manifestLoadingTimeOut: 9000, manifestLoadingMaxRetry: 1, levelLoadingTimeOut: 9000, levelLoadingMaxRetry: 1, fragLoadingMaxRetry: 4 };
        const key = stream.playlistKey;
        if (key) conf.loader = makeFlixLoader(Hls, key, stream.referer);
        const h = new Hls(conf); S.hls = h;
        h.on(Hls.Events.MANIFEST_PARSED, () => {
          if (my !== S.loadId) return;
          const seen = new Set();
          S.levels = h.levels.map((l, i) => ({ i, h: l.height || 0 })).filter((l) => l.h && !seen.has(l.h) && seen.add(l.h)).sort((a, b) => b.h - a.h);
          begin();
        });
        h.on(Hls.Events.ERROR, (_, data) => {
          if (my !== S.loadId || !data.fatal) return;
          const isNet = data.type === Hls.ErrorTypes.NETWORK_ERROR;
          if (isNet && S.started && S.retries < 2) { S.retries++; h.startLoad(); return; } // mid-playback hiccup: try again; a stream that never started fails straight away
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && S.retries < 2) { S.retries++; h.recoverMediaError(); return; }
          fail((data.details || 'stream error') + (data.response && data.response.code ? ' (' + data.response.code + ')' : ''), isNet);
        });
        h.loadSource(proxyUrl(stream.url, stream.referer)); h.attachMedia(v);
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = proxyUrl(stream.url, stream.referer);
        on(v, 'loadedmetadata', () => { if (o.resumeAt > 1) v.currentTime = o.resumeAt; begin(); }, { once: true });
      } else throw new Error('This browser cannot play HLS video');
    }
    function loadMp4(stream, o) {
      v.src = proxyUrl(stream.url, stream.referer);
      S.resumeAt = o.resumeAt || 0;
      on(v, 'loadedmetadata', () => { if (o.resumeAt > 1) v.currentTime = o.resumeAt; begin(); }, { once: true });
    }
    async function loadDash(stream, o) {
      const dashjs = await getDash(); const my = S.loadId;
      const p = dashjs.MediaPlayer().create(); S.dash = p;
      p.extend('RequestModifier', () => ({
        modifyRequestURL: (u) => proxyUrl(u, stream.referer),
        modifyRequestHeader: (xhr) => { Object.keys(stream.headers || {}).forEach((k) => { try { xhr.setRequestHeader(k, stream.headers[k]); } catch { /* ignore */ } }); return xhr; },
      }), true);
      p.on('error', () => { if (my === S.loadId) fail('DASH playback failed'); });
      p.initialize(v, stream.url, false);
      if (o.resumeAt > 1) p.seek(o.resumeAt);
      on(v, 'canplay', () => { if (my === S.loadId) begin(); }, { once: true });
    }
    function loadEmbed(stream) {
      cls('is-embed', true); loading(false);
      const f = d.createElement('iframe');
      f.src = stream.url; f.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture'; f.allowFullscreen = true;
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-forms'); f.referrerPolicy = 'origin'; f.title = 'Embedded player';
      $('.pl-embed', root).appendChild(f);
      S.started = true;
    }

    async function load(stream, o) {
      o = o || {};
      S.loadId += 1; const my = S.loadId;
      teardown(); S.cur = stream; S.resumeAt = o.resumeAt || 0; S.skipped = {}; S.nextDismissed = false; hideErr();
      if (S.subAuto === false) selectSub(-1); else pickDefaultSub();
      if (stream.type === 'embed') { loadEmbed(stream); return; }
      loading(true, o.caption || ''); armWatchdog(stream.type === 'dash' ? 45000 : 25000);
      try {
        if (stream.type === 'hls') await loadHls(stream, o);
        else if (stream.type === 'mp4') loadMp4(stream, o);
        else if (stream.type === 'dash') await loadDash(stream, o);
        else throw new Error('Unsupported stream type: ' + stream.type);
      } catch (e) { if (my === S.loadId) fail(e && e.message || 'load failed'); }
    }

    /* ── pointer, keyboard, controls wiring ── */
    function wake() {
      cls('is-idle', false); clearTimeout(S.idleT);
      S.idleT = setTimeout(() => { if (!v.paused && !S.menu && !root.matches('.is-error') && !root.querySelector('.pl-ctl:hover')) cls('is-idle', true); }, 2800);
    }
    on(root, 'pointermove', wake); on(root, 'pointerdown', wake);
    on(root, 'pointerleave', () => { if (!v.paused && !S.menu) { clearTimeout(S.idleT); S.idleT = setTimeout(() => cls('is-idle', true), 600); } });

    let lastTap = 0;
    on($('.pl-shade', root), 'pointerup', (e) => {
      if (e.button > 0 || (S.cur && S.cur.type === 'embed')) return;
      const touch = e.pointerType !== 'mouse', now = Date.now();
      if (S.menu) { closeMenu(); return; }
      if (touch) {
        const r = root.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
        if (now - lastTap < 320) { lastTap = 0; if (x < 0.35) seekBy(-10); else if (x > 0.65) seekBy(10); else toggle(); return; }
        lastTap = now; cls('is-idle', root.classList.contains('is-idle') ? false : !v.paused);
        if (!root.classList.contains('is-idle')) wake();
      } else { toggle(); }
    });
    on($('.pl-shade', root), 'dblclick', (e) => { if (e.pointerType === 'touch') return; toggle(); toggleFs(); });

    on(root, 'click', (e) => {
      const b = e.target.closest('[data-act]'); const er = e.target.closest('[data-err]');
      if (er) { cb.onErrorAction && cb.onErrorAction(er.dataset.err); return; }
      if (!b) return;
      switch (b.dataset.act) {
        case 'play': toggle(); break;
        case 'prev': cb.onPrev && cb.onPrev(); break;
        case 'next': cb.onNext && cb.onNext(false); break;
        case 'next-up': cancelCountdown(); cb.onNext && cb.onNext(false); break;
        case 'next-cancel': cancelCountdown(); S.nextDismissed = true; cls('show-next', false); break;
        case 'back': seekBy(-10); break;
        case 'fwd': seekBy(10); break;
        case 'mute': if (v.muted || v.volume === 0) { v.muted = false; if (v.volume === 0) v.volume = 0.6; } else v.muted = true; prefs.muted = v.muted; prefs.volume = v.volume; savePrefs(); break;
        case 'cc': openMenu('cc'); break;
        case 'set': openMenu('set'); break;
        case 'pip': togglePip(); break;
        case 'fs': toggleFs(); break;
        case 'replay': v.currentTime = 0; toggle(); break;
        case 'skip': { const k = b.dataset.kind; if (k && S.ranges[k]) { v.currentTime = S.ranges[k].end; S.skipped[k] = true; } break; }
        default: break;
      }
    });
    on(vol, 'input', () => setVol(Number(vol.value)));

    /* seek bar: drag to scrub, applied on release (keeps HLS from thrashing) */
    function seekFrac(e) { const r = seek.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); }
    function showTip(e) { const f = seekFrac(e), r = seek.getBoundingClientRect(); T.tip.textContent = fmtTime(f * dur()); T.tip.style.left = clamp(f * r.width, 24, r.width - 24) + 'px'; }
    on(seek, 'pointermove', (e) => { showTip(e); if (S.seeking) { const f = seekFrac(e); prog.style.transform = 'scaleX(' + f + ')'; knob.style.left = f * 100 + '%'; } });
    on(seek, 'pointerdown', (e) => { if (!dur()) return; S.seeking = true; seek.setPointerCapture(e.pointerId); cls('is-scrub', true); const f = seekFrac(e); prog.style.transform = 'scaleX(' + f + ')'; knob.style.left = f * 100 + '%'; showTip(e); });
    on(seek, 'pointerup', (e) => { if (!S.seeking) return; S.seeking = false; cls('is-scrub', false); v.currentTime = seekFrac(e) * dur(); paintTime(); });
    on(seek, 'pointercancel', () => { S.seeking = false; cls('is-scrub', false); });
    on(seek, 'keydown', (e) => { if (e.key === 'ArrowLeft') { seekBy(-5, false); e.preventDefault(); e.stopPropagation(); } else if (e.key === 'ArrowRight') { seekBy(5, false); e.preventDefault(); e.stopPropagation(); } });

    on(d, 'keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || '') || e.target.isContentEditable || d.querySelector('.modal-b')) return;
      if (S.cur && S.cur.type === 'embed') return;
      const k = e.key; let used = true;
      if (k === ' ' || k === 'k') toggle();
      else if (k === 'ArrowLeft' || k === 'j') seekBy(k === 'j' ? -10 : -5);
      else if (k === 'ArrowRight' || k === 'l') seekBy(k === 'l' ? 10 : 5);
      else if (k === 'ArrowUp') { setVol(v.volume + 0.05); flash(ic('volume') + '<span>' + Math.round(v.volume * 100) + '%</span>'); }
      else if (k === 'ArrowDown') { setVol(v.volume - 0.05); flash(ic('volLow') + '<span>' + Math.round(v.volume * 100) + '%</span>'); }
      else if (k === 'm') { v.muted = !v.muted; prefs.muted = v.muted; savePrefs(); }
      else if (k === 'f') toggleFs();
      else if (k === 'c') { if (S.subs.length) selectSub(S.subSel >= 0 ? -1 : Math.max(0, S.subs.findIndex((s) => /^en/i.test(s.srclang || '')) ), true); }
      else if (k === 'n' || k === 'N') cb.onNext && cb.onNext(false);
      else if (k === 'p' || k === 'P') cb.onPrev && cb.onPrev();
      else if (k === '>' || k === '<') { const sp = [0.5, 0.75, 1, 1.25, 1.5, 2]; const i = sp.indexOf(v.playbackRate); v.playbackRate = sp[clamp((i < 0 ? 2 : i) + (k === '>' ? 1 : -1), 0, sp.length - 1)]; prefs.speed = v.playbackRate; savePrefs(); flash('<span>' + v.playbackRate + '×</span>'); }
      else if (/^[0-9]$/.test(k)) { if (dur()) v.currentTime = (Number(k) / 10) * dur(); }
      else used = false;
      if (used) { e.preventDefault(); wake(); }
    });

    /* media session (lock-screen / media-key controls) */
    let sessionMeta = null;
    function updateSession() {
      if (!('mediaSession' in navigator) || !dur()) return;
      try { navigator.mediaSession.setPositionState({ duration: dur(), playbackRate: v.playbackRate || 1, position: Math.min(v.currentTime, dur()) }); } catch { /* ignore */ }
    }
    function setSession(meta) {
      if (!('mediaSession' in navigator)) return;
      sessionMeta = meta;
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: meta.title || '', artist: meta.sub || '', album: 'The Ledger', artwork: meta.cover ? [{ src: meta.cover, sizes: '460x650', type: 'image/jpeg' }] : [] });
        navigator.mediaSession.setActionHandler('play', () => toggle()); navigator.mediaSession.setActionHandler('pause', () => toggle());
        navigator.mediaSession.setActionHandler('seekbackward', () => seekBy(-10)); navigator.mediaSession.setActionHandler('seekforward', () => seekBy(10));
        navigator.mediaSession.setActionHandler('previoustrack', S.hasPrev ? () => cb.onPrev && cb.onPrev() : null);
        navigator.mediaSession.setActionHandler('nexttrack', S.hasNext ? () => cb.onNext && cb.onNext(false) : null);
      } catch { /* unsupported action */ }
    }

    setIcon(T.playBtn, 'play'); vol.value = prefs.muted ? 0 : prefs.volume; v.volume = prefs.volume; v.muted = prefs.muted;
    return {
      el: root, video: v,
      load,
      stop() { S.loadId += 1; teardown(); S.cur = null; },
      setMeta(m) { setT('title', m.title || ''); setT('sub', m.sub || ''); setSession(m); },
      setSubtitles(list, o) { S.subs = (list || []).filter((s) => s && httpsUrl(s.url)); S.subSel = -1; S.subAuto = !(o && o.auto === false); /* applied by load(), after teardown() has cleared the previous tracks */ },
      setRanges(r) { S.ranges = { intro: normRange(r && r.intro), outro: normRange(r && r.outro) }; markRanges(); },
      setNav(o) { S.hasNext = !!o.hasNext; S.hasPrev = !!o.hasPrev; S.nextLabel = o.nextLabel || ''; setT('nextLabel', S.nextLabel); $('[data-act=next]', root).disabled = !S.hasNext; $('[data-act=prev]', root).disabled = !S.hasPrev; if (sessionMeta) setSession(sessionMeta); },
      loading, showError: showErr, hideError: hideErr,
      time: () => v.currentTime || 0, duration: dur, paused: () => v.paused,
      pauseNow() { try { v.pause(); } catch { /* ignore */ } },
      destroy() { S.loadId += 1; clearTimeout(S.idleT); clearInterval(S.cdT); cancelAnimationFrame(S.raf); teardown(); offs.forEach((f) => f()); S.subUrls.forEach((u) => URL.revokeObjectURL(u)); if (fsEl() === root) { try { d.exitFullscreen(); } catch { /* ignore */ } } if ('mediaSession' in navigator) { try { navigator.mediaSession.metadata = null; } catch { /* ignore */ } } },
    };
  }

  /* ── 3.19 watch: providers, episode lists, stream normalising ────────── */
  const PROVIDERS = {
    anikoto: 'AniKoto', aniwaves: 'AniWaves', reanime: 'ReAnime', animegg: 'AnimeGG', kaa: 'KickAss', animenosub: 'AnimeNoSub',
    senshi: 'Senshi', anipm: 'Ani.pm', anizone: 'AniZone', animedunya: 'AnimeDunya', mkissa: 'MKissa', animeonsen: 'AnimeOnsen',
  };
  const PROVIDER_ORDER = ['anikoto', 'aniwaves', 'reanime', 'animegg', 'kaa', 'animenosub', 'senshi', 'anipm', 'anizone', 'animedunya', 'mkissa', 'animeonsen'];

  let lastWarm = 0;
  function warm() { const n = Date.now(); if (n - lastWarm < 240000) return; lastWarm = n; fetch('/warm', { cache: 'no-store' }).catch(() => {}); }

  const coverOf = (m) => httpsUrl(m && (m.cover || (m.coverImage && (m.coverImage.large || m.coverImage.medium))));

  function normEp(e) {
    if (!e || typeof e !== 'object') return null;
    const n = Number(e.number != null ? e.number : e.episode != null ? e.episode : e.n);
    if (!Number.isFinite(n) || n <= 0) return null;
    const path = typeof e.id === 'string' && /^watch\/[a-z0-9]+\/\d+\/(?:sub|dub)\/[a-z0-9]+-\d+$/i.test(e.id) ? e.id : '';
    return { n, title: String(e.title || ''), img: httpsUrl(e.image || e.thumbnail || ''), dur: Number(e.duration) || 0, filler: !!e.filler, desc: String(e.description || ''), air: e.airDate || '', path };
  }
  /** Accepts { provider: { episodes: {sub,dub} } }, { episodes: {...} }, or a flat array. Never throws. */
  function normalizeEpisodes(j, p) {
    const out = { sub: [], dub: [], error: '' };
    if (!j || typeof j !== 'object') { out.error = 'Empty response'; return out; }
    let node = j;
    if (!Array.isArray(j)) {
      if (j[p] && typeof j[p] === 'object') node = j[p];
      else if (j.data && typeof j.data === 'object') node = j.data[p] && typeof j.data[p] === 'object' ? j.data[p] : j.data;
      if (node.error && !node.episodes) { out.error = String(node.error); return out; }
    }
    const eps = Array.isArray(node) ? node : node.episodes != null ? node.episodes : node;
    const take = (list, audio) => {
      const seen = new Map();
      (Array.isArray(list) ? list : []).forEach((e) => { const x = normEp(e); if (x && !seen.has(x.n)) seen.set(x.n, x); });
      out[audio] = Array.from(seen.values()).sort((a, b) => a.n - b.n);
    };
    if (Array.isArray(eps)) { take(eps.filter((e) => !e || e.audio !== 'dub'), 'sub'); take(eps.filter((e) => e && e.audio === 'dub'), 'dub'); }
    else if (eps && typeof eps === 'object') { take(eps.sub || eps.SUB, 'sub'); take(eps.dub || eps.DUB, 'dub'); }
    return out;
  }
  const goodList = (v) => !!v && !v.error && (v.sub.length > 0 || v.dub.length > 0);

  /* compact per-title cache so a revisit can start before the network answers */
  const compactEps = (list) => list.map((e) => [e.n, e.title, e.dur, e.filler ? 1 : 0]);
  const expandEps = (arr) => (Array.isArray(arr) ? arr : []).map((a) => ({ n: a[0], title: a[1] || '', img: '', dur: a[2] || 0, filler: !!a[3], desc: '', air: '', path: '' }));
  function writeEpCache(id, p, v) { try { LS.set('c:eps:' + id, { t: Date.now(), s: JSON.stringify({ p, sub: compactEps(v.sub), dub: compactEps(v.dub) }) }); } catch { /* ignore */ } }
  function readEpCache(id) {
    const h = LS.get('c:eps:' + id, null);
    if (!h || typeof h.s !== 'string') return null;
    try { const o = JSON.parse(h.s); if (!PROVIDERS[o.p]) return null; return { t: h.t || 0, p: o.p, v: { sub: expandEps(o.sub), dub: expandEps(o.dub), error: '', cached: true } }; } catch { return null; }
  }

  /** One request per provider, all at once. Results stream in as they arrive; shared by prefetch and the watch page. */
  const epMem = new Map();
  function epRace(id) {
    let r = epMem.get(id);
    if (r && Date.now() - r.t < 300000) return r;
    r = { t: Date.now(), res: new Map(), subs: new Set(), pending: PROVIDER_ORDER.length, waking: false, wroteCache: false, done: null };
    r.sub = (fn) => { r.res.forEach((v, k) => { try { fn(k, v); } catch (e) { console.error(e); } }); r.subs.add(fn); return () => r.subs.delete(fn); };
    const one = async (p) => {
      let v = null;
      for (let a = 0; a < 4 && !v; a++) {
        try { v = normalizeEpisodes(await fetchJSON('/api/episodes/' + p + '/' + id + '?map=false', { timeout: 45000 }), p); r.waking = false; }
        catch (e) {
          const wake = (e.data && e.data.waking) || e.status === 502 || e.status === 503 || e.status === 504;
          if (wake && a < 3) { r.waking = true; await sleep(3500 * (a + 1)); continue; }
          v = { sub: [], dub: [], error: (e && e.message) || 'failed' };
        }
      }
      r.res.set(p, v); r.pending -= 1;
      if (goodList(v) && !r.wroteCache) { const old = readEpCache(id); if (!old || Date.now() - old.t > 600000) { r.wroteCache = true; writeEpCache(id, p, v); } }
      r.subs.forEach((fn) => { try { fn(p, v); } catch (e) { console.error(e); } });
    };
    r.done = Promise.all(PROVIDER_ORDER.map(one));
    epMem.set(id, r);
    return r;
  }
  /** Called from the detail page on hover/idle: wakes the API and fetches episode lists ahead of the click. */
  function prefetchWatch(id) { warm(); try { epRace(Number(id)); } catch { /* ignore */ } }

  /* ── stream normalising ── */
  const pickRange = (...c) => { for (const x of c) { const r = normRange(x); if (r) return r; } return null; };
  function normSubs(list) {
    return (Array.isArray(list) ? list : []).map((s) => {
      if (!s || typeof s !== 'object') return null;
      const url = httpsUrl(s.url || s.file || s.src || '');
      if (!url) return null;
      const kind = String(s.kind || '').toLowerCase();
      if (kind && kind !== 'captions' && kind !== 'subtitles' && kind !== 'subtitle') return null;
      return { url, label: String(s.label || s.lang || s.title || s.language || ''), srclang: String(s.srclang || s.lang || s.language || '').slice(0, 5), default: !!s.default };
    }).filter(Boolean);
  }
  const TYPE_RANK = { hls: 0, mp4: 1, dash: 2, embed: 3 };
  function normStream(s, i, intro, outro, subs) {
    if (!s || typeof s !== 'object') return null;
    const url = httpsUrl(s.url || s.file || s.src || '');
    if (!url) return null;
    let type = String(s.type || '').toLowerCase();
    if (type === 'm3u8') type = 'hls';
    if (!type) type = /\.m3u8(\?|$)/i.test(url) ? 'hls' : /\.mpd(\?|$)/i.test(url) ? 'dash' : /\.mp4(\?|$)/i.test(url) ? 'mp4' : 'embed';
    if (!(type in TYPE_RANK)) return null;
    const own = normSubs(s.subtitles);
    const bits = [s.server || 'Server', s.variant, s.subtitleType === 'hardsub' ? 'Hardsub' : s.subtitleType === 'softsub' ? 'Softsub' : '', s.quality].filter((x) => x && (typeof x === 'string' || typeof x === 'number'));
    return {
      url, type, server: String(s.server || 'Server'), label: bits.join(' · '), referer: httpsUrl(s.referer || ''),
      headers: s.headers && typeof s.headers === 'object' ? s.headers : null, playlistKey: type === 'hls' ? String(s.playlist_key || s.key || '') : '',
      subtitles: own.length ? own : subs, intro: pickRange(s.intro, s.intro_chapter) || intro, outro: pickRange(s.outro, s.outro_chapter) || outro,
      hard: s.subtitleType === 'hardsub', pri: Number(s.priority) || 0, i,
    };
  }
  function normWatch(j) {
    const t = j && typeof j === 'object' ? j : {};
    const intro = pickRange(t.intro, t.intro_start != null ? { start: t.intro_start, end: t.intro_end } : null);
    const outro = pickRange(t.outro, t.outro_start != null ? { start: t.outro_start, end: t.outro_end } : null);
    const subs = normSubs(t.subtitles);
    const seen = new Set();
    return (Array.isArray(t.streams) ? t.streams : []).map((s, i) => normStream(s, i, intro, outro, subs)).filter((s) => s && !seen.has(s.url) && seen.add(s.url))
      .sort((a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type] || (a.hard ? 1 : 0) - (b.hard ? 1 : 0) || b.pri - a.pri || a.i - b.i);
  }

  let pxBadUntil = 0; // when the video proxy failed recently: until then streams go straight to the provider's own player
  const watchMem = new Map();
  function fetchWatch(id, prov, audio, ep) {
    const key = prov + '|' + audio + '|' + id + '|' + ep.n;
    const hit = watchMem.get(key);
    if (hit && Date.now() - hit.t < 45000) return hit.p;
    const path = ep.path ? '/api/' + ep.path : '/api/watch/' + prov + '/' + id + '/' + audio + '/' + prov + '-' + ep.n;
    const p = (async () => {
      for (let a = 0; ; a++) {
        try { return normWatch(await fetchJSON(path, { timeout: 45000 })); }
        catch (e) { if (a < 1 && e.data && e.data.waking) { await sleep(4000); continue; } throw e; }
      }
    })();
    watchMem.set(key, { t: Date.now(), p });
    p.catch(() => watchMem.delete(key));
    if (watchMem.size > 24) watchMem.delete(watchMem.keys().next().value);
    return p;
  }

  const WATCH_Q = 'query($id:Int){Media(id:$id){id type format status episodes duration averageScore genres title{romaji english native} coverImage{large color} bannerImage nextAiringEpisode{episode airingAt}}}';
  const fmtEpDur = (x) => (x > 300 ? Math.round(x / 60) + 'm' : x > 0 ? Math.round(x) + 'm' : '');

  /* ── 3.20 watch view ─────────────────────────────────────────────────── */
  function watchView(ctx) {
    const el = ctx.el, id = Number(ctx.params[0]);
    const S = {
      m: MEDIA.get(id) || null, lists: new Map(), prov: '', audio: prefs.audio === 'sub' ? 'sub' : 'dub', audioExplicit: false, audioSwapped: false,
      ep: 0, resumeAt: 0, cur: null, tried: new Set(), embedPass: false, embedFallback: null, token: 0, began: false, race: null, unsub: null,
      raceStart: Date.now(), remembered: LS.get('prov:' + id, ''), view: LS.get('epview', 'list'), range: 0, destroyed: false, tick: null, lastSave: 0,
      prefetched: false, okMarked: false, waitT: 0, noteT: 0, userRange: false, netFails: 0, checkText: '',
    };
    const watched = () => watchedSet(id);

    el.innerHTML =
      '<div class="watch"><div class="watch-main"><div class="player" id="player"></div>' +
      '<div class="wctl" id="wctl"><div class="wctl-g"><div class="seg" id="wAudio" role="group" aria-label="Audio"><button type="button" data-audio="sub">Sub</button><button type="button" data-audio="dub">Dub</button></div>' +
      '<label class="sel"><span class="sr">Server</span><select id="wProv" aria-label="Provider"><option>Finding servers…</option></select>' + ic('chevD') + '</label></div>' +
      '<div class="wctl-g wctl-nav"><button type="button" class="btn btn-sm btn-glass" data-wnav="-1">' + ic('prev') + '<span>Prev</span></button><button type="button" class="btn btn-sm btn-glass" data-wnav="1"><span>Next</span>' + ic('next') + '</button></div></div>' +
      '<div class="wsrv" id="wSrv" aria-label="Stream servers"></div><div class="wnote" id="wNote" role="status"></div>' +
      '<section class="winfo"><a class="wcover" id="wCover" href="/detail/' + id + '"><span class="sk"></span></a><div class="winfo-t"><h1 id="wTitle"><span class="sk sk-l"></span></h1><p class="winfo-s" id="wSub"></p><p class="winfo-d" id="wDesc"></p><div class="winfo-a" id="wAir"></div></div></section></div>' +
      '<aside class="eps" id="eps" aria-label="Episodes"><div class="eps-h"><h2>Episodes <span id="epCount"></span></h2><div class="seg seg-ic" id="epView" role="group" aria-label="Layout"><button type="button" data-epview="list" aria-label="List">' + ic('list') + '</button><button type="button" data-epview="grid" aria-label="Grid">' + ic('grid') + '</button></div></div>' +
      '<div class="eps-tabs" id="epTabs"></div><div class="eps-b" id="epBody">' + Array(8).fill('<div class="ep sk-ep"><span class="sk sk-n"></span><span class="sk sk-l"></span></div>').join('') + '</div></aside></div>';

    const $s = (sel) => $(sel, el);

    /* ── the player ── */
    const player = createPlayer($s('#player'), {
      onFail: (reason, info) => {
        if (S.destroyed || !S.cur) return;
        if (info && info.started && info.time > 5) S.resumeAt = info.time;
        const c = S.cur, tok = S.token;
        if (info && info.net) S.netFails += 1;
        // The video itself can't be fetched (proxy / CDN down, blocked or refusing): every other server goes through the same door,
        // so stop cycling and use the provider's own embedded player instead.
        if (S.netFails >= 2 && !S.embedPass && useEmbed(tok, 'The video proxy isn’t answering (' + String(reason || '').slice(0, 50) + ') — using the provider’s own player')) { pxBadUntil = Date.now() + 300000; return; }
        const next = c.all.findIndex((s, k) => k > c.idx && (S.embedPass || s.type !== 'embed'));
        if (next >= 0) { toast((c.all[c.idx] ? (c.all[c.idx].server || 'Server') + ' failed' : 'Failed') + ' (' + String(reason || '').slice(0, 40) + ') — switching to ' + (c.all[next].server || 'another server') + '…'); playIdx(next, tok); return; }
        nextProvider(tok, reason);
      },
      onEnded: () => { saveProgress(true, true); },
      onNext: (auto) => { const n = neighbor(1); if (n) { selectEpisode(n.n, { auto }); } else if (auto) toast('That was the latest episode'); },
      onPrev: () => { const n = neighbor(-1); if (n) selectEpisode(n.n); },
      onTick: (t) => {
        S.tick = t;
        if (t.dur && t.t > t.dur * 0.85 && !S.marked) { S.marked = true; markWatched(id, S.ep); paintEpisodes(); }
        if (t.pause || Date.now() - S.lastSave > 20000) saveProgress(false);
        if (t.dur && t.dur - t.t < 40 && !S.prefetched) { S.prefetched = true; const nx = neighbor(1); if (nx && S.prov) fetchWatch(id, S.prov, S.audio, nx).catch(() => {}); }
      },
      onState: (st) => { if (st.playing && S.cur && S.cur.all[S.cur.idx] && S.cur.all[S.cur.idx].type !== 'embed') pxBadUntil = 0; if (st.playing && !S.okMarked && S.cur) { S.okMarked = true; S.remembered = S.cur.prov; LS.set('prov:' + id, S.cur.prov); const l = S.lists.get(S.cur.prov); if (l && goodList(l) && !l.cached) writeEpCache(id, S.cur.prov, l); } },
      onErrorAction: (a) => {
        if (a === 'retry') { S.tried = new Set(); S.embedPass = false; S.embedFallback = null; startEpisode(S.ep, { resumeAt: S.resumeAt }); }
        else if (a === 'reload') { resetRace(); }
        else if (a === 'next') { const n = neighbor(1); if (n) selectEpisode(n.n); }
        else if (a === 'back') navigate('/detail/' + id);
        else if (a === 'check') runCheck();
        else if (a === 'copy') { try { navigator.clipboard.writeText(S.checkText).then(() => toast('Copied')).catch(() => toast('Could not copy — select the text instead')); } catch { toast('Could not copy — select the text instead'); } }
      },
    });

    /* ── helpers over the provider lists ── */
    const provHas = (p, a) => { const l = S.lists.get(p); return !!(l && !l.error && l[a] && l[a].length); };
    const provEp = (p, a, n) => { const l = S.lists.get(p); return l && !l.error && l[a] ? l[a].find((e) => e.n === n) || null : null; };
    const anyHas = (a) => Array.from(S.lists.keys()).some((p) => provHas(p, a));
    const listErrors = () => PROVIDER_ORDER.map((p) => { const l = S.lists.get(p); return l && l.error ? PROVIDERS[p] + ': ' + String(l.error).slice(0, 40) : ''; }).filter(Boolean).slice(0, 4).join(' · ');
    const curList = () => { const l = S.lists.get(S.prov); return (l && !l.error && l[S.audio]) || []; };
    // The list shown to the viewer is the most complete one for this audio, not just the server that happened to answer first;
    // picking an episode the current server lacks moves to one that has it (see selectEpisode).
    const epList = () => { let best = curList(); S.lists.forEach((l) => { const a = l && !l.error && l[S.audio]; if (a && a.length > best.length) best = a; }); return best; };
    const rankProviders = (audio, n) => {
      const order = (S.remembered ? [S.remembered] : []).concat(PROVIDER_ORDER).filter((p, i, a) => a.indexOf(p) === i);
      return order.filter((p) => (n ? !!provEp(p, audio, n) : provHas(p, audio)));
    };
    function neighbor(dir) {
      const l = epList(); if (!l.length) return null;
      const i = l.findIndex((e) => e.n === S.ep);
      if (i < 0) return dir > 0 ? l[0] : null;
      return l[i + dir] || null;
    }

    /* ── painting ── */
    function paintHead() {
      const m = S.m, t = m ? mTitle(m) : '';
      const ep = epList().find((e) => e.n === S.ep) || null;
      $s('#wTitle').innerHTML = m ? '<a href="/detail/' + id + '">' + esc(t) + '</a>' : '<span class="sk sk-l"></span>';
      $s('#wSub').textContent = S.ep ? 'Episode ' + S.ep + (ep && ep.title && !/^episode\s*\d+$/i.test(ep.title) ? ' · ' + ep.title : '') + (S.audio ? ' · ' + (S.audio === 'dub' ? 'Dubbed' : 'Subbed') : '') : '';
      $s('#wDesc').textContent = ep && ep.desc ? cleanDesc(ep.desc).slice(0, 380) : m && m.description ? cleanDesc(m.description).slice(0, 280) : '';
      const cover = coverOf(m);
      $s('#wCover').innerHTML = cover ? '<img src="' + esc(cover) + '" alt="" decoding="async">' : '<span class="sk"></span>';
      hydrate($s('#wCover'));
      if (m) d.title = t + (S.ep ? ' – Ep ' + S.ep : '') + ' · The Ledger';
      player.setMeta({ title: t || 'Loading…', sub: S.ep ? 'Episode ' + S.ep + (ep && ep.title && !/^episode\s*\d+$/i.test(ep.title) ? ' · ' + ep.title : '') : '', cover });
      const na = m && m.nextAiringEpisode;
      $s('#wAir').innerHTML = na && na.airingAt ? '<span class="chip-air">' + ic('bell') + 'Episode ' + na.episode + ' airs in ' + fmtDays(na.airingAt - Date.now() / 1000) + '</span>' : '';
    }
    function paintControls() {
      const seg = $s('#wAudio');
      $$('[data-audio]', seg).forEach((b) => {
        const a = b.dataset.audio, none = S.lists.size >= 1 && !anyHas(a) && (!S.race || S.race.pending === 0);
        b.classList.toggle('on', a === S.audio); b.disabled = none; b.title = none ? 'Not available on any server for this title' : '';
      });
      const sel = $s('#wProv');
      const rows = PROVIDER_ORDER.map((p) => {
        const l = S.lists.get(p);
        if (l && l.error) return '';
        if (!l) return S.race && S.race.pending > 0 ? '<option value="' + p + '" disabled>' + esc(PROVIDERS[p]) + ' · checking…</option>' : '';
        const a = l[S.audio].length ? l[S.audio] : l[S.audio === 'dub' ? 'sub' : 'dub'];
        if (!a.length) return '';
        return '<option value="' + p + '"' + (p === S.prov ? ' selected' : '') + '>' + esc(PROVIDERS[p]) + ' · ' + (l[S.audio].length ? l[S.audio].length + ' ep' : S.audio === 'dub' ? 'sub only' : 'dub only') + '</option>';
      }).join('');
      sel.innerHTML = rows || '<option>' + (S.race && S.race.pending === 0 ? 'No servers found' : 'Finding servers…') + '</option>';
      if (S.prov && rows) sel.value = S.prov;
      const srv = $s('#wSrv'), c = S.cur;
      srv.innerHTML = c && c.all.length > 1 ? c.all.map((s, i) => '<button type="button" class="srv' + (i === c.idx ? ' on' : '') + '" data-srv="' + i + '">' + esc(s.label || s.server) + (s.type === 'embed' ? ' <small>embed</small>' : '') + '</button>').join('') : '';
      const nx = neighbor(1), pv = neighbor(-1);
      $$('[data-wnav]', el).forEach((b) => { b.disabled = !(Number(b.dataset.wnav) > 0 ? nx : pv); });
      player.setNav({ hasNext: !!nx, hasPrev: !!pv, nextLabel: nx ? 'Episode ' + nx.n : '' });
    }
    function paintNote() {
      const n = $s('#wNote'); let msg = '';
      if (S.race && S.race.waking && !S.began) msg = 'Waking up the streaming server — the first load of the day can take up to a minute.';
      else if (S.race && S.race.pending > 0 && !S.began && Date.now() - S.raceStart > 12000) msg = 'Still looking for servers (' + (PROVIDER_ORDER.length - S.race.pending) + ' of ' + PROVIDER_ORDER.length + ' have answered)…';
      else if (S.audioSwapped && S.audio === 'sub' && !S.audioExplicit) msg = 'No dub found for this episode, so you are watching with subtitles.';
      n.textContent = msg; n.classList.toggle('on', !!msg);
    }
    function rangeSize(len) { return len > 600 ? 100 : len > 150 ? 50 : 25; }
    function paintEpisodes() {
      const list = epList(), body = $s('#epBody'), tabs = $s('#epTabs');
      $$('[data-epview]', el).forEach((b) => b.classList.toggle('on', b.dataset.epview === S.view));
      $s('#epCount').textContent = list.length ? '(' + list.length + ')' : '';
      if (!list.length) {
        tabs.innerHTML = '';
        const done = S.race ? S.race.pending === 0 : true;
        body.innerHTML = done && S.lists.size ? '<div class="eps-empty">' + ic('info') + '<p>No episodes found on this server.</p></div>' : Array(8).fill('<div class="ep sk-ep"><span class="sk sk-n"></span><span class="sk sk-l"></span></div>').join('');
        return;
      }
      const size = rangeSize(list.length), groups = Math.ceil(list.length / size);
      if (!S.userRange) { const i = list.findIndex((e) => e.n === S.ep); S.range = i >= 0 ? Math.floor(i / size) : S.range; }
      S.range = clamp(S.range, 0, groups - 1);
      tabs.innerHTML = groups > 1 ? Array.from({ length: groups }, (_, g) => { const a = list[g * size].n, b = list[Math.min(list.length, (g + 1) * size) - 1].n; return '<button type="button" class="eps-tab' + (g === S.range ? ' on' : '') + '" data-range="' + g + '">' + a + '–' + b + '</button>'; }).join('') : '';
      const w = watched(), part = list.slice(S.range * size, (S.range + 1) * size);
      body.className = 'eps-b ' + (S.view === 'grid' ? 'is-grid' : 'is-list');
      body.innerHTML = part.map((e) => {
        const cur = e.n === S.ep, seen = w.has(e.n);
        if (S.view === 'grid') return '<button type="button" class="ep-g' + (cur ? ' on' : '') + (seen ? ' w' : '') + (e.filler ? ' f' : '') + '" data-n="' + e.n + '" title="' + esc(e.title || 'Episode ' + e.n) + '"' + (cur ? ' aria-current="true"' : '') + '>' + e.n + '</button>';
        const meta = [fmtEpDur(e.dur), e.filler ? 'Filler' : '', seen && !cur ? 'Watched' : ''].filter(Boolean).join(' · ');
        return '<button type="button" class="ep' + (cur ? ' on' : '') + (seen ? ' w' : '') + '" data-n="' + e.n + '"' + (cur ? ' aria-current="true"' : '') + '>' +
          (e.img ? '<span class="ep-img"><img src="' + esc(e.img) + '" alt="" loading="lazy" decoding="async"></span>' : '') +
          '<span class="ep-n">' + e.n + '</span><span class="ep-t"><b>' + esc(e.title || 'Episode ' + e.n) + '</b>' + (meta ? '<small>' + esc(meta) + '</small>' : '') + '</span>' +
          (cur ? '<i class="ep-st">' + ic('play') + '</i>' : seen ? '<i class="ep-st ok">' + ic('check') + '</i>' : '') + '</button>';
      }).join('');
      hydrate(body);
      const on = $('.on', body); if (on && S.view !== 'grid') { const top = on.offsetTop - body.offsetTop - 8; if (Math.abs(body.scrollTop - top) > body.clientHeight / 2) body.scrollTop = Math.max(0, top - 40); }
    }
    const paintAll = () => { paintHead(); paintControls(); paintEpisodes(); paintNote(); };

    /* ── choosing what to play ── */
    function choose(final) {
      const wants = S.audioExplicit ? [S.audio] : [S.audio, S.audio === 'dub' ? 'sub' : 'dub'];
      for (const a of wants) {
        if (S.ep) { const p = rankProviders(a, S.ep)[0]; if (p) return { prov: p, audio: a, ep: S.ep }; }
        else { const p = rankProviders(a, 0)[0]; if (p) { const l = S.lists.get(p)[a]; return { prov: p, audio: a, ep: l[0].n }; } }
      }
      if (!final) return null;
      // asked-for episode is missing everywhere (not aired yet?): fall back to the closest one that exists
      for (const a of wants) {
        const p = rankProviders(a, 0)[0];
        if (p) { const l = S.lists.get(p)[a]; const below = l.filter((e) => e.n <= S.ep); return { prov: p, audio: a, ep: (below.length ? below[below.length - 1] : l[0]).n, fallback: true }; }
      }
      return null;
    }
    function maybeBegin() {
      if (S.began || S.destroyed || !ctx.live()) return;
      const final = !S.race || S.race.pending === 0;
      const cand = choose(final);
      if (!cand) {
        if (final && S.lists.size) {
          player.loading(false);
          const why = listErrors();
          player.showError('No episodes found', 'None of the servers have episodes for this title yet. Check back soon, or try again in a moment.' + (why ? ' (' + why + ')' : ''), [{ id: 'reload', label: 'Search again' }, { id: 'check', label: 'Run check', ghost: true }, { id: 'back', label: 'Back to details', ghost: true }]);
        }
        return;
      }
      // give a remembered-good server a moment to answer before settling for whichever came first
      // (and, failing that, the best-ranked server a short moment: the quickest answer isn't always the best server)
      const pref = S.remembered || PROVIDER_ORDER[0], grace = S.remembered ? 1800 : 600;
      if (pref && cand.prov !== pref && !S.lists.has(pref) && !final && Date.now() - S.raceStart < grace) {
        clearTimeout(S.waitT); S.waitT = setTimeout(maybeBegin, Math.max(30, grace - (Date.now() - S.raceStart))); return;
      }
      S.began = true; clearTimeout(S.waitT);
      if (cand.audio !== S.audio) { S.audioSwapped = true; S.audio = cand.audio; }
      if (cand.fallback) toast('Episode ' + S.ep + ' is not available yet — starting at episode ' + cand.ep);
      S.prov = cand.prov;
      startEpisode(cand.ep, { resumeAt: cand.ep === S.ep ? S.resumeAt : 0 });
    }

    function startEpisode(n, o) {
      o = o || {};
      S.ep = n; S.tried = new Set(); S.embedPass = false; S.embedFallback = null; S.netFails = 0; S.cur = null; S.tick = null; S.marked = false; S.prefetched = false; S.okMarked = false; S.userRange = false;
      S.resumeAt = o.resumeAt || 0;
      const tok = ++S.token;
      try { history.replaceState(history.state, '', '/watch/' + id + '?ep=' + n); } catch { /* ignore */ }
      paintAll();
      player.hideError(); player.loading(true, 'Finding a stream…');
      loadFrom(S.prov, tok);
    }

    async function loadFrom(prov, tok) {
      S.tried.add(prov);
      const epObj = provEp(prov, S.audio, S.ep) || { n: S.ep, path: '' };
      let streams;
      try { streams = await fetchWatch(id, prov, S.audio, epObj); }
      catch (e) { if (tok !== S.token || S.destroyed) return; nextProvider(tok, (e && e.message) || 'request failed'); return; }
      if (tok !== S.token || S.destroyed) return;
      if (!streams.length) { nextProvider(tok, 'No streams'); return; }
      if (Date.now() < pxBadUntil && streams.some((s) => s.type === 'embed')) { // the video proxy failed a moment ago: go straight to the provider's player
        S.embedPass = true; S.prov = prov; S.cur = { prov, all: streams, idx: streams.findIndex((s) => s.type === 'embed') };
        paintControls(); playIdx(S.cur.idx, tok); return;
      }
      const first = streams.findIndex((s) => S.embedPass || s.type !== 'embed');
      if (first < 0) { if (!S.embedFallback) S.embedFallback = { prov, all: streams, idx: -1 }; nextProvider(tok, 'Only embedded players'); return; }
      S.prov = prov; S.cur = { prov, all: streams, idx: first };
      paintControls();
      playIdx(first, tok);
    }

    async function nextProvider(tok, reason) {
      if (tok !== S.token || S.destroyed) return;
      if (S.netFails >= 4) { // several different servers could not even start downloading: more tries won't help
        player.loading(false);
        player.showError('The video isn’t loading', 'Several servers didn’t answer (' + String(reason || 'no response').slice(0, 80) + '). The video proxy may be offline, or this network may be blocking it. “Run check” shows which step fails.',
          [{ id: 'retry', label: 'Try again' }, { id: 'check', label: 'Run check', ghost: true }, { id: 'back', label: 'Details', ghost: true }]);
        return;
      }
      ensureRace();
      const pick = () => rankProviders(S.audio, S.ep).find((p) => !S.tried.has(p));
      let p = pick();
      if (!p && S.race && S.race.pending > 0) {
        player.loading(true, 'Checking other servers…');
        await Promise.race([S.race.done, sleep(15000)]);
        if (tok !== S.token || S.destroyed) return;
        p = pick();
      }
      if (!p && !S.audioExplicit && !S.audioSwapped) {
        const other = S.audio === 'dub' ? 'sub' : 'dub';
        if (rankProviders(other, S.ep).length) { S.audioSwapped = true; S.audio = other; S.tried = new Set(); p = pick(); paintNote(); toast('Switched to ' + (other === 'sub' ? 'subtitled' : 'dubbed') + ' audio for this episode'); }
      }
      if (p) { player.loading(true, 'Trying ' + PROVIDERS[p] + '…'); if (S.cur) toast('Trying ' + PROVIDERS[p] + '…'); S.prov = p; paintControls(); loadFrom(p, tok); return; }
      if (!S.embedPass && S.embedFallback) {
        S.embedPass = true; S.cur = S.embedFallback; S.prov = S.cur.prov; S.cur.idx = S.cur.all.findIndex((s) => s.type === 'embed');
        paintControls(); playIdx(S.cur.idx, tok); return;
      }
      player.loading(false);
      player.showError('Couldn’t start this episode', 'We tried ' + S.tried.size + ' server' + (S.tried.size === 1 ? '' : 's') + ' for episode ' + S.ep + (reason ? ' (' + String(reason).slice(0, 80) + ')' : '') + '. Streams change often — try again in a moment.',
        [{ id: 'retry', label: 'Try again' }, { id: 'check', label: 'Run check', ghost: true }, { id: 'next', label: 'Next episode', ghost: true }, { id: 'back', label: 'Details', ghost: true }]);
    }

    /** Switch to the embedded player of the current (or fallback) server. Returns false when there is none. */
    function useEmbed(tok, why) {
      let c = S.cur, i = c ? c.all.findIndex((s) => s.type === 'embed') : -1;
      if (i < 0 && S.embedFallback) { c = S.embedFallback; i = c.all.findIndex((s) => s.type === 'embed'); if (i >= 0) { S.cur = c; S.prov = c.prov; } }
      if (i < 0) return false;
      S.embedPass = true; if (why) toast(why);
      paintControls(); playIdx(i, tok); return true;
    }

    /** Step-by-step connection test, run from this browser so it sees what the viewer sees. Result is shown (and copyable) in the player. */
    async function runCheck() {
      const out = [], tok = S.token;
      const timed = async (url) => {
        const t = performance.now(), ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 12000);
        try { const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' }); const txt = await r.text(); return { r, txt, ms: Math.round(performance.now() - t) }; }
        catch (e) { return { err: e && e.name === 'AbortError' ? 'no answer within 12 s' : 'blocked or unreachable', ms: Math.round(performance.now() - t) }; }
        finally { clearTimeout(to); }
      };
      const add = (ok, label, detail) => out.push((ok ? '✓ ' : '✗ ') + label + (detail ? ' — ' + detail : ''));
      player.hideError(); player.loading(true, 'Checking the connection…');
      const prov = (S.cur && S.cur.prov) || PROVIDER_ORDER[0];
      const ep = await timed('/api/episodes/' + prov + '/' + id + '?map=false');
      if (ep.err) add(false, 'Episode list (' + PROVIDERS[prov] + ')', ep.err);
      else { let n = ''; try { const v = normalizeEpisodes(JSON.parse(ep.txt), prov); n = v.sub.length + ' sub / ' + v.dub.length + ' dub'; if (v.error) n = v.error; } catch { n = 'unreadable answer'; } add(ep.r.ok, 'Episode list (' + PROVIDERS[prov] + ')', 'HTTP ' + ep.r.status + ', ' + ep.ms + ' ms, ' + n); }
      let hls = S.cur && S.cur.all.find((s) => s.type === 'hls');
      if (!hls) { try { const l = S.lists.get(prov), e1 = l && !l.error && (l.sub[0] || l.dub[0]); if (e1) { const st = await fetchWatch(id, prov, l.sub[0] ? 'sub' : 'dub', e1); hls = st.find((s) => s.type === 'hls'); } } catch { /* reported below */ } }
      if (!hls) add(false, 'Stream link', 'no HLS stream available from ' + PROVIDERS[prov]);
      else {
        add(true, 'Stream link', new URL(hls.url).hostname);
        const m = await timed(proxyUrl(hls.url, hls.referer));
        if (m.err) add(false, 'Video proxy', m.err + ' (' + new URL(CFG.proxy || location.href).hostname + ') — the proxy may be offline, or this network blocks it');
        else { const head = m.txt.slice(0, 40).replace(/\s+/g, ' '); add(m.r.ok && /^\s*#EXTM3U/.test(m.txt), 'Video proxy', 'HTTP ' + m.r.status + ', ' + m.ms + ' ms, replied “' + head + '”'); }
      }
      S.checkText = out.join('\n') + '\n' + new Date().toISOString() + ' · title ' + id + ' · ' + (navigator.userAgent.match(/(Chrome|Firefox|Safari)\/[\d.]+/) || [''])[0];
      if (tok !== S.token || S.destroyed) return;
      player.loading(false);
      player.showError('Connection check', S.checkText, [{ id: 'retry', label: 'Try again' }, { id: 'copy', label: 'Copy details', ghost: true }, { id: 'back', label: 'Details', ghost: true }]);
    }

    function playIdx(i, tok) {
      if (tok !== S.token || S.destroyed || !S.cur) return;
      const c = S.cur, s = c.all[i]; if (!s) return;
      c.idx = i;
      player.setSubtitles(s.type === 'embed' || s.hard ? [] : s.subtitles, { auto: S.audio !== 'dub' });
      player.setRanges({ intro: s.intro, outro: s.outro });
      player.load(s, { resumeAt: S.resumeAt, caption: (PROVIDERS[c.prov] || '') + (s.server && s.server !== PROVIDERS[c.prov] ? ' · ' + s.server : '') });
      paintControls();
    }

    function selectEpisode(n, o) {
      if (!n) return;
      if (!provEp(S.prov, S.audio, n)) { const p = rankProviders(S.audio, n)[0]; if (p) S.prov = p; else if (!provEp(S.prov, S.audio, n) && epList().length) { toast('Episode ' + n + ' is not available on this server'); return; } }
      saveProgress(true);
      const cw = cwGet(id);
      const ro = cw && Number(parseNum(cw.label)) === n && cw.pos > 10 && !(cw.dur && cw.pos > cw.dur - 40) ? cw.pos : 0;
      player.pauseNow();
      startEpisode(n, { resumeAt: ro, auto: o && o.auto });
      if (!(o && o.auto)) { const pe = $s('#player'); if (pe && pe.getBoundingClientRect().top < 0) pe.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' }); }
    }

    /* ── progress ── */
    function saveProgress(flush, ended) {
      if (!S.m || !S.ep || !S.tick) return;
      const t = S.tick.t, dur = S.tick.dur;
      if (!ended && (t < 5 || !dur)) return;
      S.lastSave = Date.now();
      const finished = ended || (dur && t > dur - 30);
      if (finished) { markWatched(id, S.ep); S.marked = true; }
      let ep = S.ep, pos = t;
      if (finished) { const nx = neighbor(1); if (nx) { ep = nx.n; } pos = 0; }
      cwSave({ id, type: 'anime', title: mTitle(S.m), cover: coverOf(S.m), label: 'Episode ' + ep, pos, dur: finished ? 0 : dur, page: 0 }, flush);
    }
    const onHide = () => saveProgress(true);
    window.addEventListener('pagehide', onHide);

    /* ── events ── */
    el.addEventListener('click', (e) => {
      const t = e.target;
      const b = t.closest('[data-n]');
      if (b && el.contains(b)) { const n = Number(b.dataset.n); if (n !== S.ep) selectEpisode(n); else player.video.paused && player.video.play().catch(() => {}); return; }
      const au = t.closest('[data-audio]');
      if (au && !au.disabled) {
        const a = au.dataset.audio; if (a === S.audio) return;
        const have = provEp(S.prov, a, S.ep) ? S.prov : rankProviders(a, S.ep)[0];
        if (!have && S.lists.size) { toast((a === 'dub' ? 'Dubbed' : 'Subbed') + ' audio is not available for episode ' + S.ep); return; }
        S.audioExplicit = true; S.audioSwapped = false; prefs.audio = a; savePrefs();
        const keep = player.time() > 3 ? player.time() : S.resumeAt;
        S.audio = a; if (have) S.prov = have;
        saveProgress(false); startEpisode(S.ep, { resumeAt: keep }); return;
      }
      const sv = t.closest('[data-srv]');
      if (sv && S.cur) { const i = Number(sv.dataset.srv); if (i !== S.cur.idx) { if (S.cur.all[i].type === 'embed') S.embedPass = true; S.resumeAt = player.time() > 3 ? player.time() : S.resumeAt; playIdx(i, S.token); } return; }
      const rg = t.closest('[data-range]');
      if (rg) { S.range = Number(rg.dataset.range); S.userRange = true; paintEpisodes(); return; }
      const ev = t.closest('[data-epview]');
      if (ev) { S.view = ev.dataset.epview; LS.set('epview', S.view); paintEpisodes(); return; }
      const nv = t.closest('[data-wnav]');
      if (nv && !nv.disabled) { const n = neighbor(Number(nv.dataset.wnav)); if (n) selectEpisode(n.n); }
    });
    $s('#wProv').addEventListener('focus', () => ensureRace());
    $s('#wProv').addEventListener('change', (e) => {
      const p = e.target.value; if (!PROVIDERS[p] || p === S.prov) return;
      let a = S.audio;
      if (!provHas(p, a)) { if (S.audioExplicit) { toast(PROVIDERS[p] + ' has no ' + (a === 'dub' ? 'dub' : 'sub') + ' for this title'); paintControls(); return; } a = a === 'dub' ? 'sub' : 'dub'; }
      if (!provEp(p, a, S.ep)) { toast('Episode ' + S.ep + ' is not on ' + PROVIDERS[p]); paintControls(); return; }
      S.audio = a; S.prov = p; S.remembered = p; LS.set('prov:' + id, p);
      const keep = player.time() > 3 ? player.time() : S.resumeAt;
      startEpisode(S.ep, { resumeAt: keep });
    });
    const onVis = () => { if (d.visibilityState === 'hidden') saveProgress(false); };
    d.addEventListener('visibilitychange', onVis);

    /* ── data: media, race, optimistic start ── */
    function ensureRace() {
      if (S.race || S.destroyed) return;
      S.raceStart = Date.now();
      S.race = epRace(id);
      S.unsub = S.race.sub((p, v) => {
        if (S.destroyed) return;
        const before = epList().length;
        S.lists.set(p, v);
        paintControls(); if (p === S.prov || !S.prov || epList().length !== before) paintEpisodes(); paintNote();
        maybeBegin();
      });
      S.race.done.then(() => { if (S.destroyed) return; paintControls(); paintEpisodes(); paintNote(); maybeBegin(); clearInterval(S.noteT); });
      clearInterval(S.noteT); S.noteT = setInterval(paintNote, 1500);
    }
    function resetRace() {
      epMem.delete(id); if (S.unsub) S.unsub(); S.race = null; S.lists.clear(); S.began = false; S.prov = ''; S.tried = new Set();
      player.hideError(); player.loading(true, 'Looking for servers…'); paintAll(); warm(); ensureRace();
    }

    // episode to start with: ?ep=, else where the continue list left off, else the first one
    const cw = cwGet(id), cwEp = cw && cw.type === 'anime' ? Number(parseNum(cw.label)) || 0 : 0;
    const qEp = Math.floor(Number(ctx.query.get('ep'))) || 0;
    if (qEp > 0) { S.ep = qEp; if (cw && cwEp === qEp && cw.pos > 10 && !(cw.dur && cw.pos > cw.dur - 40)) S.resumeAt = cw.pos; }
    else if (cwEp) { S.ep = cwEp; S.resumeAt = cw.pos > 10 && !(cw.dur && cw.pos > cw.dur - 40) ? cw.pos : 0; }

    paintAll();
    player.loading(true, 'Finding a stream…');
    warm();

    // 1) metadata (instant from cache, refreshed in the background)
    swr('wm:' + id, 6 * 3600 * 1000, () => gql(WATCH_Q, { id }).then((dd) => dd.Media), (m) => {
      if (S.destroyed || !m) return;
      reg([m]); S.m = Object.assign(S.m || {}, m);
      if (isManga(S.m)) { navigate('/read/' + id, { replace: true }); return; }
      paintHead();
    }).catch(() => { if (!S.m) paintHead(); });

    // 2) episodes: cached list first (starts playing immediately on a revisit), then the live race
    const cached = readEpCache(id);
    if (cached) { S.lists.set(cached.p, cached.v); S.remembered = S.remembered || cached.p; S.raceStart = Date.now(); paintControls(); paintEpisodes(); maybeBegin(); }
    if (!cached || Date.now() - cached.t > 600000) ensureRace();
    else setTimeout(() => { if (!S.destroyed) ensureRace(); }, 4000);

    // 3) optimistic start: with a known episode and no cached list, ask the likeliest server for the stream while the race runs
    if (!S.began && !cached && S.ep > 0) {
      const gp = S.remembered || PROVIDER_ORDER[0];
      const tok0 = S.token;
      fetchWatch(id, gp, S.audio, { n: S.ep, path: '' }).then((streams) => {
        if (S.destroyed || S.began || tok0 !== S.token || !streams.length) return;
        if (!streams.some((s) => s.type !== 'embed')) return;
        S.began = true; S.prov = gp; S.tried = new Set([gp]); S.embedPass = false; S.embedFallback = null;
        const first = streams.findIndex((s) => s.type !== 'embed');
        S.cur = { prov: gp, all: streams, idx: first };
        const tok = ++S.token;
        try { history.replaceState(history.state, '', '/watch/' + id + '?ep=' + S.ep); } catch { /* ignore */ }
        paintAll(); playIdx(first, tok);
      }).catch(() => { /* the race will pick a server */ });
    }

    return {
      destroy() {
        saveProgress(true);
        S.destroyed = true; S.token += 1;
        clearTimeout(S.waitT); clearInterval(S.noteT);
        if (S.unsub) S.unsub();
        window.removeEventListener('pagehide', onHide); d.removeEventListener('visibilitychange', onVis);
        player.destroy();
      },
    };
  }

  /* ── 3.21 manga reader (MangaDex) ────────────────────────────────────── */
  const READ_Q = 'query($id:Int){Media(id:$id){id type format isAdult countryOfOrigin chapters title{romaji english native} synonyms coverImage{large color}}}';
  const normT = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
  const mdTitles = (a) => { const t = (a && a.title) || {}, out = Object.values(t); (a && a.altTitles || []).forEach((o) => out.push(...Object.values(o))); return out.map(normT).filter(Boolean); };

  /** Find the MangaDex entry for an AniList id: exact AniList link first, else a title match the user can confirm. */
  async function mdResolve(m, id) {
    const saved = LS.get('mdmap:' + id, '');
    if (/^[0-9a-f-]{36}$/.test(saved)) return { id: saved, candidates: [] };
    const terms = [m.title && m.title.romaji, m.title && m.title.english].concat(m.synonyms || []).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).slice(0, 3);
    const seen = new Map();
    for (const term of terms) {
      let j; try { j = await fetchJSON('/md/manga?limit=12&order%5Brelevance%5D=desc&title=' + encodeURIComponent(term), { timeout: 20000 }); } catch (e) { if (!seen.size && term === terms[terms.length - 1]) throw e; continue; }
      for (const x of (j.data || [])) {
        seen.set(x.id, x);
        if (x.attributes && x.attributes.links && String(x.attributes.links.al) === String(id)) { LS.set('mdmap:' + id, x.id); return { id: x.id, candidates: [] }; }
      }
    }
    const wanted = new Set([m.title && m.title.romaji, m.title && m.title.english, m.title && m.title.native].concat(m.synonyms || []).map(normT).filter(Boolean));
    const list = Array.from(seen.values());
    const eq = list.find((x) => mdTitles(x.attributes).some((t) => wanted.has(t)));
    if (eq) { LS.set('mdmap:' + id, eq.id); return { id: eq.id, candidates: [] }; }
    return { id: '', candidates: list.slice(0, 6).map((x) => ({ id: x.id, title: (x.attributes.title && (x.attributes.title.en || Object.values(x.attributes.title)[0])) || 'Untitled', year: x.attributes.year || '' })) };
  }

  async function mdFeed(mdId) {
    const out = [];
    for (let off = 0; off < 2000; off += 500) {
      const j = await fetchJSON('/md/manga/' + mdId + '/feed?limit=500&offset=' + off + '&translatedLanguage%5B%5D=en&order%5Bchapter%5D=asc&includeExternalUrl=0&includeEmptyPages=0', { timeout: 25000 });
      (j.data || []).forEach((c) => { const a = c.attributes || {}; if (!a.externalUrl && a.pages > 0) out.push({ id: c.id, ch: a.chapter == null ? '' : String(a.chapter), vol: a.volume || '', title: a.title || '', pages: a.pages }); });
      if (off + 500 >= (j.total || 0)) break;
    }
    // one entry per chapter number: keep the longest upload (usually the complete one)
    const byNum = new Map();
    out.forEach((c) => { const k = c.ch === '' ? 'one:' + c.id : c.ch; const o = byNum.get(k); if (!o || c.pages > o.pages) byNum.set(k, c); });
    return Array.from(byNum.values()).sort((a, b) => (a.ch === '' ? -1 : 0) - (b.ch === '' ? -1 : 0) || Number(a.ch) - Number(b.ch));
  }
  const chLabel = (c) => (c.ch === '' ? 'Oneshot' : 'Chapter ' + c.ch);

  function readView(ctx) {
    const el = ctx.el, id = Number(ctx.params[0]);
    const saved = LS.get('reader', {});
    const S = {
      m: MEDIA.get(id) || null, md: '', chapters: [], ci: -1, page: 0, data: [], dataSaver: [], base: '', hash: '', total: 0,
      mode: '', rtl: undefined, fit: saved.fit || 'height', saver: !!saved.saver, proxy: !!LS.get('rdproxy', false),
      ui: true, destroyed: false, seq: 0, io: null, saveT: 0, preloaded: new Set(), pop: false,
    };
    const cw = cwGet(id), cwCh = cw && cw.type === 'manga' ? parseNum(cw.label) : '';
    const wantCh = ctx.query.get('ch') || cwCh;
    const wantPage = ctx.query.get('p') != null ? Number(ctx.query.get('p')) || 0 : (cw && cw.type === 'manga' && String(cwCh) === String(wantCh) ? cw.page || 0 : 0);

    el.innerHTML = '<div class="reader" id="reader"><div class="rd-load" id="rdLoad">' + '<div class="rd-skel"><span class="sk"></span></div><p>Loading chapters…</p></div></div>';
    const root = $('#reader', el);
    // Layout is remembered per kind of title: Japanese manga (paged, right-to-left) vs. webtoons / manhwa (scroll).
    const grp = () => (S.m && S.m.countryOfOrigin && S.m.countryOfOrigin !== 'JP' ? 'o' : 'j');
    const natRtl = () => grp() === 'j';
    const persist = () => { const cur = LS.get('reader', {}); const g = Object.assign({}, cur[grp()]); g.mode = S.mode; if (S.mode !== 'vertical') g.rtl = S.rtl; cur[grp()] = g; cur.fit = S.fit; cur.saver = S.saver; LS.set('reader', cur); };
    const title = () => (S.m ? mTitle(S.m) : 'Manga');
    const fail = (msg, retry) => { if (S.destroyed) return; root.innerHTML = errorBlock(msg, retry); };

    /* ── data ── */
    async function start() {
      try {
        if (!S.m || S.m.countryOfOrigin === undefined) {
          const m = await swr('rm:' + id, 6 * 3600 * 1000, async () => (await gql(READ_Q, { id })).Media, (mm) => { if (mm) { reg([mm]); S.m = Object.assign(S.m || {}, mm); } }).then(() => S.m);
          if (!S.m) { const mm = (await gql(READ_Q, { id })).Media; reg([mm]); S.m = Object.assign(S.m || {}, mm); }
        }
      } catch (e) { if (!S.m) { fail(e.message, true); return; } }
      if (S.destroyed) return;
      if (S.m.type === 'ANIME') { navigate('/watch/' + id, { replace: true }); return; }
      if (S.m.isAdult) { root.innerHTML = emptyBlock('Not available', 'This title is restricted and can’t be read here.', '/', 'Back home'); return; }
      const sg = saved[grp()] || {};
      if (!S.mode) S.mode = sg.mode || (grp() === 'o' ? 'vertical' : 'single');
      if (S.rtl === undefined) S.rtl = S.mode !== 'vertical' && (typeof sg.rtl === 'boolean' ? sg.rtl : natRtl());
      d.title = title() + ' · Read · The Ledger';
      try {
        const r = await mdResolve(S.m, id);
        if (S.destroyed) return;
        if (!r.id) { chooser(r.candidates); return; }
        S.md = r.id;
        await swr('mdf:' + r.id, 30 * 60 * 1000, () => mdFeed(r.id), (list) => { S.chapters = list; if (S.ci >= 0) paintChapterSel(); }).catch((e) => { if (!S.chapters.length) throw e; });
      } catch (e) { fail(e && e.message || 'Could not reach MangaDex', true); return; }
      if (S.destroyed) return;
      if (!S.chapters.length) { root.innerHTML = emptyBlock('No English chapters yet', 'MangaDex has no readable English chapters for this title.', '/detail/' + id, 'Back to details') + (S.md ? '<p class="rd-ext"><a href="https://mangadex.org/title/' + esc(S.md) + '" target="_blank" rel="noopener noreferrer">View on MangaDex ' + ic('external') + '</a></p>' : ''); return; }
      buildUi();
      let ci = S.chapters.findIndex((c) => String(c.ch) === String(wantCh));
      if (ci < 0) ci = 0;
      openChapter(ci, ci >= 0 && String(S.chapters[ci].ch) === String(wantCh) ? wantPage : 0);
    }
    function chooser(cands) {
      root.innerHTML = '<div class="empty"><div class="empty-i">' + ic('search') + '</div><h3>Which one is it?</h3><p>We couldn’t match this title automatically. Pick the right MangaDex entry:</p><div class="rd-cands">' +
        (cands.length ? cands.map((c) => '<button type="button" class="btn btn-glass" data-md="' + esc(c.id) + '">' + esc(c.title) + (c.year ? ' (' + esc(c.year) + ')' : '') + '</button>').join('') : '<p class="muted">No results on MangaDex.</p>') + '</div><a class="btn btn-sm" href="/detail/' + id + '">Back to details</a></div>';
    }

    /* ── UI shell ── */
    function buildUi() {
      root.dataset.mode = S.mode; root.dataset.dir = S.rtl ? 'rtl' : 'ltr'; root.dataset.fit = S.fit;
      root.innerHTML =
        '<div class="rd-bar rd-top"><a class="rd-btn" href="/detail/' + id + '" aria-label="Back to details">' + ic('arrowL') + '</a><div class="rd-ttl"><b>' + esc(title()) + '</b><label class="sel sel-sm"><span class="sr">Chapter</span><select id="rdCh"></select>' + ic('chevD') + '</label></div>' +
        '<div class="rd-tools"><button type="button" class="rd-btn" data-rd="settings" aria-label="Reader settings" aria-haspopup="true">' + ic('sliders') + '</button><button type="button" class="rd-btn" data-rd="fs" aria-label="Fullscreen">' + ic('fullscreen') + '</button></div></div>' +
        '<div class="rd-stage" id="rdStage" tabindex="-1"></div>' +
        '<div class="rd-bar rd-bot"><button type="button" class="rd-btn" data-rd="prevch" aria-label="Previous chapter">' + ic('prev') + '</button><span class="rd-pg-n" id="rdPage">1 / 1</span><input type="range" class="rd-slider" id="rdSlider" min="1" max="1" value="1" aria-label="Page"><button type="button" class="rd-btn" data-rd="nextch" aria-label="Next chapter">' + ic('next') + '</button></div>' +
        '<div class="rd-pop" id="rdPop" hidden></div>';
      paintChapterSel();
    }
    function paintChapterSel() {
      const sel = $('#rdCh', root); if (!sel) return;
      sel.innerHTML = S.chapters.map((c, i) => '<option value="' + i + '"' + (i === S.ci ? ' selected' : '') + '>' + esc(chLabel(c) + (c.title ? ' — ' + c.title : '')) + '</option>').join('');
    }
    function paintPop() {
      const pop = $('#rdPop', root); if (!pop) return;
      const seg = (key, label, opts) => '<div class="pop-row"><span>' + label + '</span><div class="seg" role="group">' + opts.map((o) => '<button type="button" data-set="' + key + '" data-v="' + o[0] + '" class="' + (String(o[2]) === 'true' ? 'on' : '') + '">' + o[1] + '</button>').join('') + '</div></div>';
      pop.innerHTML =
        seg('mode', 'Layout', [['single', 'Single', S.mode === 'single'], ['double', 'Double', S.mode === 'double'], ['vertical', 'Scroll', S.mode === 'vertical']]) +
        (S.mode === 'vertical' ? '' : seg('dir', 'Direction', [['rtl', 'Right to left', S.rtl], ['ltr', 'Left to right', !S.rtl]]) + seg('fit', 'Fit', [['height', 'Height', S.fit === 'height'], ['width', 'Width', S.fit === 'width']])) +
        seg('saver', 'Image quality', [['0', 'High', !S.saver], ['1', 'Data saver', S.saver]]) +
        seg('proxy', 'Image route', [['0', 'Direct', !S.proxy], ['1', 'Via proxy', S.proxy]]);
    }

    /* ── chapters & pages ── */
    async function openChapter(ci, page) {
      if (ci < 0 || ci >= S.chapters.length) return;
      const seq = ++S.seq;
      saveProgress(false);
      S.ci = ci; S.page = 0; S.total = 0; S.preloaded = new Set();
      const c = S.chapters[ci];
      paintChapterSel(); $('#rdPage', root).textContent = '…';
      const stage = $('#rdStage', root);
      stage.innerHTML = '<div class="rd-wait"><div class="rd-skel"><span class="sk"></span></div><p>Loading ' + esc(chLabel(c)) + '…</p></div>';
      try { history.replaceState(history.state, '', '/read/' + id + '?ch=' + encodeURIComponent(c.ch)); } catch { /* ignore */ }
      let j;
      try { j = await fetchJSON('/md/at-home/server/' + c.id, { timeout: 25000 }); }
      catch (e) { if (seq !== S.seq || S.destroyed) return; stage.innerHTML = errorBlock(e && e.paused ? e : (e && e.message) || 'Could not load pages', true).replace('data-retry', 'data-rd="reload"'); return; }
      if (seq !== S.seq || S.destroyed) return;
      const ch = j.chapter || {};
      S.base = String(j.baseUrl || '').replace(/\/+$/, ''); S.hash = ch.hash || '';
      S.data = Array.isArray(ch.data) ? ch.data : []; S.dataSaver = Array.isArray(ch.dataSaver) ? ch.dataSaver : [];
      S.total = (S.saver && S.dataSaver.length ? S.dataSaver : S.data).length;
      if (!S.total || !/^https:\/\//.test(S.base)) { stage.innerHTML = errorBlock('This chapter has no readable pages.', false); return; }
      S.page = clamp(page || 0, 0, S.total - 1);
      renderStage();
      d.title = title() + ' – ' + chLabel(c) + ' · The Ledger';
      const slider = $('#rdSlider', root); slider.max = S.total; slider.value = S.page + 1;
      paintPage();
      const nx = S.chapters[ci + 1]; if (nx) idle(() => fetchJSON('/md/at-home/server/' + nx.id, { timeout: 15000 }).catch(() => {}), 4000);
    }
    const imgSrc = (i) => {
      const arr = S.saver && S.dataSaver.length ? S.dataSaver : S.data, f = arr[i]; if (!f) return '';
      const direct = S.base + (S.saver && S.dataSaver.length ? '/data-saver/' : '/data/') + S.hash + '/' + f;
      return S.proxy ? proxyUrl(direct) : direct;
    };
    const directOf = (src) => origFromProxy(src);
    const pgHtml = (i, lazy) => '<figure class="rd-pg" data-i="' + i + '"><span class="sk"></span><img data-i="' + i + '" alt="Page ' + (i + 1) + '" decoding="async" ' + (lazy ? 'loading="lazy" ' : '') + 'src="' + esc(imgSrc(i)) + '"></figure>';

    function spreadOf(p) { if (S.mode !== 'double' || p === 0) return [p]; const a = 1 + 2 * Math.floor((p - 1) / 2); return a + 1 < S.total ? [a, a + 1] : [a]; }
    function renderStage() {
      const stage = $('#rdStage', root);
      if (S.io) { S.io.disconnect(); S.io = null; }
      root.dataset.mode = S.mode; root.dataset.dir = S.rtl ? 'rtl' : 'ltr'; root.dataset.fit = S.fit;
      if (S.mode === 'vertical') {
        stage.innerHTML = '<div class="rd-strip">' + Array.from({ length: S.total }, (_, i) => pgHtml(i, i > 2)).join('') + '</div>';
        const vis = new Map();
        S.io = new IntersectionObserver((es) => {
          es.forEach((e) => { vis.set(Number(e.target.dataset.i), e.isIntersecting ? e.intersectionRatio : 0); });
          let best = -1, bv = 0; vis.forEach((v, k) => { if (v > bv) { bv = v; best = k; } });
          if (best >= 0 && best !== S.page) { S.page = best; paintPage(true); }
        }, { threshold: [0, 0.25, 0.5, 0.75, 1], rootMargin: '-10% 0px -10% 0px' });
        $$('.rd-pg', stage).forEach((f) => S.io.observe(f));
        const t = $('.rd-pg[data-i="' + S.page + '"]', stage); if (t) requestAnimationFrame(() => { t.scrollIntoView({ block: 'start' }); });
      } else {
        const idx = spreadOf(S.page);
        stage.innerHTML = '<div class="rd-spread n' + idx.length + '">' + idx.map((i) => pgHtml(i, false)).join('') + '</div>';
        stage.scrollTop = 0; window.scrollTo(0, 0);
        preload();
      }
      hydrateReader(stage);
      paintPop();
    }
    function hydrateReader(stage) {
      $$('img', stage).forEach((im) => { const fig = im.parentNode; const done = () => { fig.classList.add('ld'); }; if (im.complete && im.naturalWidth) done(); else { im.addEventListener('load', done, { once: true }); } });
    }
    function preload() {
      const next = spreadOf(S.page); const last = next[next.length - 1];
      for (let k = 1; k <= 3; k++) { const i = last + k; if (i < S.total && !S.preloaded.has(i)) { S.preloaded.add(i); const im = new Image(); im.decoding = 'async'; im.src = imgSrc(i); } }
      const p = spreadOf(Math.max(0, S.page - 1))[0]; if (p !== S.page && p >= 0 && !S.preloaded.has(p)) { S.preloaded.add(p); const im = new Image(); im.src = imgSrc(p); }
    }
    function paintPage(fromScroll) {
      const pg = $('#rdPage', root), sl = $('#rdSlider', root); if (!pg) return;
      pg.textContent = (S.page + 1) + ' / ' + S.total; if (sl) sl.value = S.page + 1;
      scheduleSave();
      if (S.mode !== 'vertical') preload();
      else if (fromScroll) { for (let k = 1; k <= 2; k++) { const f = $('.rd-pg[data-i="' + (S.page + k) + '"] img', root); if (f && !f.getAttribute('src')) f.src = imgSrc(S.page + k); } }
    }
    function go(delta) {
      if (!S.total) return;
      if (S.mode === 'vertical') { const t = $('.rd-pg[data-i="' + clamp(S.page + delta, 0, S.total - 1) + '"]', root); if (t) t.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' }); if (delta > 0 && S.page >= S.total - 1) chapter(1); return; }
      const cur = spreadOf(S.page);
      let np;
      if (delta > 0) np = cur[cur.length - 1] + 1; else { np = cur[0] - 1; if (np >= 0) np = spreadOf(np)[0]; }
      if (np >= S.total) { chapter(1); return; }
      if (np < 0) { chapter(-1, true); return; }
      S.page = np; renderStage(); paintPage();
    }
    function chapter(dir, toEnd) {
      const ni = S.ci + dir;
      if (ni < 0) { toast('This is the first chapter'); return; }
      if (ni >= S.chapters.length) { toast('You’re all caught up — that was the latest chapter'); return; }
      openChapter(ni, toEnd ? 9999 : 0);
    }

    /* ── progress ── */
    function saveProgress(flush) {
      clearTimeout(S.saveT); S.saveT = 0;
      if (!S.m || S.ci < 0 || !S.chapters[S.ci] || !S.total) return;
      const c = S.chapters[S.ci];
      cwSave({ id, type: 'manga', title: mTitle(S.m), cover: coverOf(S.m), label: chLabel(c), pos: 0, dur: 0, page: S.page }, flush);
    }
    function scheduleSave() { clearTimeout(S.saveT); S.saveT = setTimeout(() => saveProgress(false), 1500); }
    const onHide = () => saveProgress(true);
    window.addEventListener('pagehide', onHide);

    /* ── events ── */
    function setUi(on) { S.ui = on; root.classList.toggle('rd-hide', !on); }
    function openPop(on) { S.pop = on; const p = $('#rdPop', root); if (!p) return; if (on) paintPop(); p.hidden = !on; }
    function fsEl() { return d.fullscreenElement || d.webkitFullscreenElement; }
    function toggleFs() { if (fsEl()) { (d.exitFullscreen || d.webkitExitFullscreen).call(d); } else { const f = root.requestFullscreen || root.webkitRequestFullscreen; if (f) Promise.resolve(f.call(root)).catch(() => {}); } }
    const onFs = () => root.classList.toggle('is-fs', fsEl() === root);
    d.addEventListener('fullscreenchange', onFs);

    root.addEventListener('click', (e) => {
      const t = e.target;
      const md = t.closest('[data-md]');
      if (md) { LS.set('mdmap:' + id, md.dataset.md); root.innerHTML = '<div class="rd-load"><div class="rd-skel"><span class="sk"></span></div><p>Loading chapters…</p></div>'; start(); return; }
      if (t.closest('[data-retry]')) { root.innerHTML = '<div class="rd-load"><div class="rd-skel"><span class="sk"></span></div><p>Loading chapters…</p></div>'; start(); return; }
      const rd = t.closest('[data-rd]');
      if (rd) {
        const a = rd.dataset.rd;
        if (a === 'fs') toggleFs(); else if (a === 'settings') openPop(!S.pop);
        else if (a === 'prevch') chapter(-1); else if (a === 'nextch') chapter(1);
        else if (a === 'reload') openChapter(S.ci, S.page);
        return;
      }
      const st = t.closest('[data-set]');
      if (st) {
        const k = st.dataset.set, v = st.dataset.v;
        if (k === 'mode') { const was = S.mode; S.mode = v; if (v === 'vertical') S.rtl = false; else if (was === 'vertical') S.rtl = natRtl(); }
        else if (k === 'dir') S.rtl = v === 'rtl'; else if (k === 'fit') S.fit = v;
        else if (k === 'saver') { S.saver = v === '1'; S.total = (S.saver && S.dataSaver.length ? S.dataSaver : S.data).length; S.page = Math.min(S.page, S.total - 1); S.preloaded = new Set(); }
        else if (k === 'proxy') { S.proxy = v === '1'; LS.set('rdproxy', S.proxy); S.preloaded = new Set(); }
        persist(); renderStage(); paintPage(); paintPop(); return;
      }
      const rr = t.closest('[data-rimg]');
      if (rr) { const im = $('img', rr.closest('.rd-pg')); if (im) { rr.closest('.rd-pg').classList.remove('bad'); im.src = imgSrc(Number(im.dataset.i)) + (imgSrc(0).indexOf('?') > -1 ? '&' : '?') + 'r=' + Date.now(); } return; }
      if (S.pop && !t.closest('#rdPop')) { openPop(false); return; }
      // tap zones on the page itself
      if (t.closest('.rd-stage') && S.mode !== 'vertical' && !t.closest('a,button')) {
        const r = $('#rdStage', root).getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
        if (x < 0.3) go(S.rtl ? 1 : -1); else if (x > 0.7) go(S.rtl ? -1 : 1); else setUi(!S.ui);
      } else if (t.closest('.rd-stage') && S.mode === 'vertical') setUi(!S.ui);
    });
    root.addEventListener('change', (e) => { if (e.target.id === 'rdCh') openChapter(Number(e.target.value), 0); });
    root.addEventListener('input', (e) => { if (e.target.id === 'rdSlider') { const p = Number(e.target.value) - 1; if (S.mode === 'vertical') { const t = $('.rd-pg[data-i="' + p + '"]', root); if (t) t.scrollIntoView({ block: 'start' }); } else { S.page = p; renderStage(); paintPage(); } } });
    // image failures: first try the proxy (school networks often block MangaDex's image hosts), then offer a retry
    root.addEventListener('error', (e) => {
      const im = e.target; if (!im || im.tagName !== 'IMG' || !im.dataset.i) return;
      const fig = im.parentNode;
      if (!S.proxy && !im.dataset.tried) { im.dataset.tried = '1'; S.proxy = true; LS.set('rdproxy', true); S.preloaded = new Set(); im.src = imgSrc(Number(im.dataset.i)); return; }
      fig.classList.add('bad');
      if (!$('[data-rimg]', fig)) fig.insertAdjacentHTML('beforeend', '<button type="button" class="btn btn-sm rd-retry" data-rimg>' + ic('refresh') + 'Retry</button>');
    }, true);
    // swipe (single/double)
    let sx = 0, sy = 0, st0 = 0;
    root.addEventListener('pointerdown', (e) => { sx = e.clientX; sy = e.clientY; st0 = Date.now(); });
    root.addEventListener('pointerup', (e) => {
      if (S.mode === 'vertical' || e.pointerType === 'mouse') return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.6 && Date.now() - st0 < 700) { e.preventDefault(); go((dx < 0) !== S.rtl ? 1 : -1); root.dataset.swiped = '1'; setTimeout(() => { delete root.dataset.swiped; }, 50); }
    });
    root.addEventListener('click', (e) => { if (root.dataset.swiped) e.stopImmediatePropagation(); }, true);

    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || '') || !S.total) return;
      const k = e.key; let used = true;
      if (k === 'ArrowRight') go(S.rtl ? -1 : 1); else if (k === 'ArrowLeft') go(S.rtl ? 1 : -1);
      else if (k === ' ' && S.mode !== 'vertical') go(e.shiftKey ? -1 : 1); else if (k === 'PageDown' && S.mode !== 'vertical') go(1); else if (k === 'PageUp' && S.mode !== 'vertical') go(-1);
      else if (k === 'f' || k === 'F') toggleFs();
      else if (k === 'm' || k === 'M') { const was = S.mode; S.mode = S.mode === 'single' ? 'double' : S.mode === 'double' ? 'vertical' : 'single'; if (S.mode === 'vertical') S.rtl = false; else if (was === 'vertical') S.rtl = natRtl(); persist(); renderStage(); paintPage(); toast('Layout: ' + S.mode); }
      else if (k === '[') chapter(-1); else if (k === ']') chapter(1);
      else if (k === 'Escape' && S.pop) openPop(false);
      else if (k === 'h' || k === 'H') setUi(!S.ui);
      else used = false;
      if (used) e.preventDefault();
    };
    d.addEventListener('keydown', onKey);

    start();
    return {
      destroy() {
        saveProgress(true);
        S.destroyed = true; S.seq += 1; clearTimeout(S.saveT); if (S.io) S.io.disconnect();
        window.removeEventListener('pagehide', onHide); d.removeEventListener('keydown', onKey); d.removeEventListener('fullscreenchange', onFs);
        if (fsEl() === root) { try { d.exitFullscreen(); } catch { /* ignore */ } }
      },
    };
  }

  /* ── 3.22 boot ───────────────────────────────────────────────────────── */
  function boot() {
    if (!CFG.pk) { state.user = null; LS.del('auth'); } // fail closed: without Clerk keys nobody is signed in
    buildShell();
    renderRoute();
    if (CFG.pk) { if (state.user) idle(loadClerk, 2500); else loadClerk(); }
    if (state.user) idle(cwSync, 1500);
    idle(warm, 3000);
    window.addEventListener('online', () => { warm(); if (state.user) cwSync(); });
    window.addEventListener('unhandledrejection', (e) => { if (e && e.reason && e.reason.name !== 'AbortError') console.warn('Unhandled:', e.reason); });
  }
  boot();
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. STYLES — served as /_/app.css
 * ═══════════════════════════════════════════════════════════════════════════ */
const APP_CSS = `
/* The Ledger — design tokens, base, shell (header, tab bar, menus), cards, rails, skeletons */
:root {
  --bg: #0b1522;
  --bg-2: #0f1c2e;
  --panel: rgba(255, 255, 255, 0.055);
  --panel-2: rgba(255, 255, 255, 0.09);
  --panel-3: rgba(255, 255, 255, 0.14);
  --line: rgba(255, 255, 255, 0.1);
  --txt: #eef3f9;
  --txt-2: #a9b6c6;
  --txt-3: #74839a;
  --accent: #0a84ff;
  --accent-2: #5ac8fa;
  --accent-soft: rgba(10, 132, 255, 0.18);
  --ok: #30d158;
  --warn: #ffd60a;
  --err: #ff453a;
  --r-s: 10px;
  --r-m: 14px;
  --r-l: 20px;
  --r-xl: 26px;
  --ease: cubic-bezier(0.32, 0.72, 0, 1);
  --spring: cubic-bezier(0.34, 1.4, 0.64, 1);
  --glass: rgba(14, 26, 43, 0.72);
  --glass-solid: rgba(14, 26, 43, 0.97); /* popovers inside .hdr: nested backdrop-filter does not blur, so they need to be near-opaque */
  --blur: blur(20px) saturate(180%);
  --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif;
  --hdr-h: 60px;
  --tab-h: 58px;
  --pad: clamp(16px, 3.2vw, 44px);
  --maxw: 1520px;
  --shadow: 0 10px 30px rgba(0, 0, 0, 0.35), 0 2px 8px rgba(0, 0, 0, 0.25);
}
*, *::before, *::after { box-sizing: border-box; }
html { background: var(--bg); color: var(--txt); color-scheme: dark; -webkit-text-size-adjust: 100%; scroll-padding-top: calc(var(--hdr-h) + 12px); }
body { margin: 0; min-height: 100vh; font: 15px/1.5 var(--font); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; background: radial-gradient(1200px 600px at 10% -10%, rgba(10, 132, 255, 0.1), transparent 60%), radial-gradient(900px 500px at 100% 0, rgba(90, 200, 250, 0.06), transparent 55%), var(--bg); background-attachment: fixed; overflow-x: hidden; }
a { color: inherit; text-decoration: none; -webkit-tap-highlight-color: transparent; }
button, input, select { font: inherit; color: inherit; }
button { cursor: pointer; border: 0; background: none; padding: 0; -webkit-tap-highlight-color: transparent; }
button:disabled { cursor: default; }
img { max-width: 100%; }
h1, h2, h3, p { margin: 0; }
h1, h2, h3 { letter-spacing: -0.02em; line-height: 1.15; }
::selection { background: rgba(10, 132, 255, 0.4); }
:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; border-radius: 6px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.muted { color: var(--txt-3); }
[hidden] { display: none !important; }
.ic { width: 1.2em; height: 1.2em; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.ic .f { fill: currentColor; stroke: none; }
.view { min-height: calc(100vh - var(--hdr-h)); outline: none; }
.page { width: 100%; max-width: var(--maxw); margin: 0 auto; padding: 22px var(--pad) 72px; }
@supports not (view-transition-name: none) {
  .view-in { animation: viewIn 0.32s var(--ease) both; }
}
@keyframes viewIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
::view-transition-old(root), ::view-transition-new(root) { animation-duration: 0.26s; animation-timing-function: var(--ease); }
::view-transition-group(cover) { animation-duration: 0.45s; animation-timing-function: var(--ease); }

/* ── skeletons ── */
.sk { position: relative; overflow: hidden; background: rgba(255, 255, 255, 0.06); border-radius: 8px; display: block; }
.sk::after { content: ""; position: absolute; inset: 0; background: linear-gradient(100deg, transparent 20%, rgba(255, 255, 255, 0.09) 50%, transparent 80%); transform: translateX(-100%); animation: shimmer 1.5s infinite; }
@keyframes shimmer { to { transform: translateX(100%); } }
.sk-l { height: 12px; margin: 9px 0; }
.sk-l.s { width: 62%; }
.sk-h1 { height: 38px; width: min(520px, 70%); margin-bottom: 14px; border-radius: 10px; }
.sk-pill { height: 26px; width: 130px; border-radius: 99px; margin-bottom: 14px; }
.sk-btn { height: 48px; width: 160px; border-radius: 99px; }
.sk-n { width: 30px; height: 30px; border-radius: 9px; flex: none; }
.sk-card { pointer-events: none; }
.sk-card .card-art { aspect-ratio: 2 / 3; }

/* ── buttons & controls ── */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 10px 20px; border-radius: 999px; background: var(--accent); color: #fff; font-weight: 600; font-size: 15px; letter-spacing: -0.01em; white-space: nowrap; transition: transform 0.25s var(--spring), background 0.2s, filter 0.2s, box-shadow 0.2s; box-shadow: 0 6px 18px rgba(10, 132, 255, 0.28); }
.btn:hover { filter: brightness(1.12); }
.btn:active { transform: scale(0.96); }
.btn-lg { padding: 14px 26px; font-size: 16px; }
.btn-sm { padding: 8px 14px; font-size: 14px; }
.btn-glass { background: rgba(255, 255, 255, 0.14); backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur); box-shadow: none; border: 1px solid rgba(255, 255, 255, 0.12); }
.btn-ghost { background: transparent; border: 1px solid var(--line); box-shadow: none; }
.btn-off { background: var(--panel-2); color: var(--txt-3); box-shadow: none; pointer-events: none; }
.btn:disabled { opacity: 0.4; pointer-events: none; }
.icon-btn { width: 40px; height: 40px; display: inline-grid; place-items: center; border-radius: 50%; background: var(--panel); transition: background 0.2s, transform 0.2s var(--spring); }
.icon-btn:hover { background: var(--panel-2); }
.icon-btn:active { transform: scale(0.92); }
.only-m { display: none; }
.link-b { color: var(--accent-2); font-weight: 600; padding: 4px 0; }
.link-b:hover { text-decoration: underline; }
.seg { display: inline-flex; background: var(--panel); border: 1px solid var(--line); border-radius: 999px; padding: 3px; gap: 2px; }
.seg button { padding: 6px 14px; border-radius: 999px; font-size: 13.5px; font-weight: 600; color: var(--txt-2); transition: background 0.25s var(--ease), color 0.2s; }
.seg button:hover:not(.on):not(:disabled) { color: var(--txt); }
.seg button.on { background: var(--accent); color: #fff; }
.seg button:disabled { opacity: 0.35; }
.seg-ic button { padding: 6px 9px; display: inline-grid; place-items: center; }
.sel { position: relative; display: inline-flex; align-items: center; }
.sel select, #bYear { appearance: none; -webkit-appearance: none; background: var(--panel); border: 1px solid var(--line); border-radius: 999px; padding: 8px 34px 8px 14px; font-size: 14px; font-weight: 600; max-width: 100%; text-overflow: ellipsis; cursor: pointer; }
.sel select:hover, #bYear:hover { background: var(--panel-2); }
.sel .ic { position: absolute; right: 11px; width: 15px; height: 15px; pointer-events: none; color: var(--txt-2); }
.sel-sm select { padding: 5px 30px 5px 12px; font-size: 13px; }
select option { background: #14233a; color: var(--txt); }
.chips { display: flex; gap: 8px; flex-wrap: wrap; margin: 14px 0 0; }
.chips.wrap { margin: 0; }
.chip-b { display: inline-flex; align-items: center; padding: 6px 14px; border-radius: 999px; background: var(--panel); border: 1px solid var(--line); font-size: 13.5px; font-weight: 600; color: var(--txt-2); transition: background 0.2s, color 0.2s, transform 0.2s var(--spring); }
a.chip-b:hover, button.chip-b:hover { background: var(--panel-2); color: var(--txt); }
.chip-b.on { background: var(--accent); border-color: transparent; color: #fff; }
.chip-b.flat { cursor: default; }
.badge { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: 999px; font-size: 12.5px; font-weight: 700; background: rgba(255, 255, 255, 0.14); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
.badge .ic { width: 13px; height: 13px; }
.badge-acc { background: var(--accent); }
.toasts { position: fixed; z-index: 400; left: 50%; bottom: calc(24px + env(safe-area-inset-bottom)); transform: translateX(-50%); display: flex; flex-direction: column; gap: 8px; align-items: center; pointer-events: none; width: min(92vw, 420px); }
.toast { pointer-events: auto; display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-radius: 16px; background: var(--glass); backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur); border: 1px solid var(--line); box-shadow: var(--shadow); font-size: 14px; font-weight: 500; animation: toastIn 0.4s var(--spring) both; }
.toast.out { animation: toastOut 0.25s var(--ease) both; }
.toast-err { border-color: rgba(255, 69, 58, 0.5); }
.toast-act { margin-left: auto; color: var(--accent-2); font-weight: 700; }
@keyframes toastIn { from { opacity: 0; transform: translateY(14px) scale(0.96); } to { opacity: 1; transform: none; } }
@keyframes toastOut { to { opacity: 0; transform: translateY(8px) scale(0.98); } }

/* ── header ── */
.hdr { position: sticky; top: 0; z-index: 200; height: var(--hdr-h); background: var(--glass); backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur); border-bottom: 1px solid var(--line); }
.hdr-in { height: 100%; max-width: var(--maxw); margin: 0 auto; padding: 0 var(--pad); display: flex; align-items: center; gap: 18px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 18px; letter-spacing: -0.03em; flex: none; }
.brand-mark svg { width: 30px; height: 30px; display: block; filter: drop-shadow(0 4px 10px rgba(10, 132, 255, 0.4)); }
.brand-mark.lg svg { width: 56px; height: 56px; }
.pnav { display: flex; gap: 2px; padding: 4px; border-radius: 999px; background: var(--panel); border: 1px solid var(--line); }
.pnav-i { display: inline-flex; align-items: center; gap: 7px; padding: 7px 14px; border-radius: 999px; font-size: 14px; font-weight: 600; color: var(--txt-2); transition: background 0.3s var(--ease), color 0.2s; white-space: nowrap; }
.pnav-i:hover { color: var(--txt); }
.pnav-i.on { background: var(--accent); color: #fff; box-shadow: 0 4px 14px rgba(10, 132, 255, 0.35); }
.hdr-r { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.sbox { position: relative; display: flex; align-items: center; width: clamp(180px, 22vw, 320px); transition: width 0.35s var(--ease); }
.sbox:focus-within { width: clamp(220px, 32vw, 440px); }
.sbox > .ic { position: absolute; left: 13px; color: var(--txt-3); pointer-events: none; }
.sbox input { width: 100%; height: 40px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); padding: 0 40px 0 38px; outline: none; font-size: 14.5px; transition: background 0.2s, border-color 0.2s, box-shadow 0.2s; }
.sbox input::-webkit-search-cancel-button { display: none; }
.sbox input::placeholder { color: var(--txt-3); }
.sbox input:focus { background: rgba(255, 255, 255, 0.09); border-color: rgba(10, 132, 255, 0.7); box-shadow: 0 0 0 4px var(--accent-soft); }
.sbox kbd { position: absolute; right: 12px; font: 600 11px var(--font); padding: 2px 7px; border-radius: 6px; background: var(--panel-2); color: var(--txt-3); pointer-events: none; }
.sbox input:focus ~ kbd { opacity: 0; }
.sug { position: absolute; top: calc(100% + 10px); left: 0; right: 0; min-width: min(360px, 92vw); padding: 8px; border-radius: 18px; background: var(--glass-solid); backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur); border: 1px solid var(--line); box-shadow: var(--shadow); opacity: 0; transform: translateY(-6px) scale(0.98); transform-origin: top; pointer-events: none; visibility: hidden; transition: opacity 0.2s, transform 0.25s var(--ease), visibility 0s 0.25s; }
.sug.open { opacity: 1; transform: none; pointer-events: auto; visibility: visible; transition-delay: 0s; }
.sug-i { display: flex; align-items: center; gap: 12px; padding: 7px 8px; border-radius: 12px; }
.sug-i:hover, .sug-i.on { background: var(--panel-2); }
.sug-i img { width: 36px; height: 52px; object-fit: cover; border-radius: 7px; background: var(--panel); flex: none; }
.sug-i span { min-width: 0; display: flex; flex-direction: column; }
.sug-i b { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sug-i small { color: var(--txt-3); font-size: 12.5px; }
.sug-all { display: flex; align-items: center; justify-content: center; gap: 4px; padding: 10px; margin-top: 4px; border-top: 1px solid var(--line); color: var(--accent-2); font-weight: 600; font-size: 13.5px; }
.sug-none { padding: 14px; color: var(--txt-3); font-size: 14px; text-align: center; }
.prof { position: relative; }
.prof-btn { display: flex; align-items: center; gap: 8px; padding: 3px 10px 3px 3px; border-radius: 999px; background: var(--panel); border: 1px solid var(--line); transition: background 0.2s; }
.prof-btn:hover, .prof-btn[aria-expanded="true"] { background: var(--panel-2); }
.prof-name { font-size: 13.5px; font-weight: 600; max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.prof-c { width: 14px; height: 14px; color: var(--txt-3); transition: transform 0.3s var(--ease); }
.prof-btn[aria-expanded="true"] .prof-c { transform: rotate(180deg); }
.avatar { position: relative; width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; flex: none; overflow: hidden; font-size: 12px; font-weight: 800; background: linear-gradient(135deg, #8e5cff, #ff5fa2 60%, #ffb347); box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.14); }
.avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.avatar.lg { width: 44px; height: 44px; font-size: 15px; }
.menu { position: absolute; right: 0; top: calc(100% + 10px); width: 300px; padding: 8px; border-radius: 20px; background: var(--glass-solid); backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur); border: 1px solid var(--line); box-shadow: var(--shadow); transform-origin: top right; }
.menu:not([hidden]) { animation: menuIn 0.28s var(--spring) both; }
@keyframes menuIn { from { opacity: 0; transform: scale(0.92) translateY(-6px); } to { opacity: 1; transform: none; } }
.menu-head { display: flex; align-items: center; gap: 12px; padding: 10px; }
.menu-head div { min-width: 0; display: flex; flex-direction: column; }
.menu-head b { font-size: 15px; }
.menu-head small { color: var(--txt-3); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu-i { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px; border-radius: 12px; font-size: 14.5px; font-weight: 500; text-align: left; transition: background 0.15s; }
.menu-i:hover { background: var(--panel-2); }
.menu-i .ic { color: var(--txt-2); }
.menu-i.danger { color: var(--err); }
.menu-i.danger .ic { color: var(--err); }
.menu-sep { height: 1px; background: var(--line); margin: 6px 4px; }
.menu-sw { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px; border-radius: 12px; font-size: 14.5px; cursor: pointer; }
.menu-sw:hover { background: var(--panel-2); }
.menu-sw input { position: absolute; opacity: 0; pointer-events: none; }
.menu-sw i { position: relative; width: 42px; height: 26px; border-radius: 99px; background: var(--panel-3); flex: none; transition: background 0.25s; }
.menu-sw i::after { content: ""; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35); transition: transform 0.3s var(--spring); }
.menu-sw input:checked + i { background: var(--ok); }
.menu-sw input:checked + i::after { transform: translateX(16px); }
.menu-sw input:focus-visible + i { outline: 2px solid var(--accent-2); outline-offset: 2px; }
.menu-seg { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px; font-size: 14.5px; }
.tabbar { display: none; }

/* ── page headers ── */
.page-h { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 22px; }
.page-h h1 { font-size: clamp(28px, 4vw, 40px); font-weight: 800; }
.page-sub { color: var(--txt-2); margin-top: 6px; }
.filters { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.sec-t { font-size: 20px; font-weight: 700; margin: 0 0 14px; }
.bigsearch { position: relative; display: flex; align-items: center; margin-bottom: 4px; }
.bigsearch .ic { position: absolute; left: 18px; width: 20px; height: 20px; color: var(--txt-3); }
.bigsearch input { width: 100%; height: 56px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); padding: 0 22px 0 52px; font-size: 18px; outline: none; transition: border-color 0.2s, box-shadow 0.2s, background 0.2s; }
.bigsearch input:focus { border-color: rgba(10, 132, 255, 0.7); box-shadow: 0 0 0 5px var(--accent-soft); background: rgba(255, 255, 255, 0.08); }
#sBody { margin-top: 26px; }
.empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; padding: 64px 20px; color: var(--txt-2); }
.empty h3 { color: var(--txt); font-size: 20px; }
.empty p { max-width: 420px; }
.empty .btn { margin-top: 10px; }
.empty-i { width: 64px; height: 64px; border-radius: 50%; background: var(--panel); display: grid; place-items: center; margin-bottom: 6px; }
.empty-i .ic { width: 28px; height: 28px; color: var(--txt-3); }
.empty.big { padding: 120px 20px; }
.nf-code { font-size: clamp(80px, 18vw, 160px); font-weight: 900; letter-spacing: -0.06em; line-height: 1; color: var(--accent); text-shadow: 0 12px 60px rgba(10, 132, 255, 0.45); }

/* ── cards & rails ── */
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(clamp(132px, 15vw, 184px), 1fr)); gap: 24px 16px; }
.sentinel { height: 1px; }
.card { position: relative; display: block; min-width: 0; border-radius: var(--r-m); outline-offset: 4px; }
.card-art { position: relative; aspect-ratio: 2 / 3; border-radius: var(--r-m); overflow: hidden; background: linear-gradient(160deg, color-mix(in srgb, var(--c, #24415f) 55%, #0b1522), #0b1522); box-shadow: 0 6px 16px rgba(0, 0, 0, 0.3); transition: transform 0.45s var(--ease), box-shadow 0.45s var(--ease); }
.card-art img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
@media (hover: hover) {
  .card:hover .card-art { transform: translateY(-6px) scale(1.025); box-shadow: 0 18px 36px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.12); }
}
.card:active .card-art { transform: scale(0.97); }
.card.on .card-art { box-shadow: 0 0 0 2px var(--accent), 0 10px 26px rgba(10, 132, 255, 0.3); }
.card-t { margin-top: 10px; font-size: 14px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.card-m { margin-top: 2px; font-size: 12.5px; color: var(--txt-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chip { position: absolute; display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 700; background: rgba(8, 16, 28, 0.68); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); color: #fff; z-index: 2; }
.chip .ic { width: 11px; height: 11px; color: var(--warn); }
.chip-score { top: 8px; left: 8px; }
.chip-label { left: 8px; bottom: 12px; background: var(--accent); }
.card-x { position: absolute; top: 6px; right: 6px; z-index: 3; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; background: rgba(8, 16, 28, 0.72); backdrop-filter: blur(10px); opacity: 0; transform: scale(0.8); transition: opacity 0.2s, transform 0.25s var(--spring); }
.card-x .ic { width: 14px; height: 14px; }
.card:hover .card-x, .card-x:focus-visible { opacity: 1; transform: none; }
@media (hover: none) { .card-x { opacity: 0.9; transform: none; } }
.card-prog { position: absolute; left: 0; right: 0; bottom: 0; height: 4px; background: rgba(255, 255, 255, 0.2); z-index: 2; }
.card-prog i { display: block; height: 100%; background: var(--accent); border-radius: 0 4px 4px 0; }
.rail { margin: 30px 0 0; position: relative; }
.rail-h { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.rail-h h2 { font-size: clamp(19px, 2.2vw, 24px); font-weight: 700; }
.rail-ctl { display: flex; align-items: center; gap: 8px; }
.rail-more { display: inline-flex; align-items: center; gap: 2px; color: var(--accent-2); font-weight: 600; font-size: 14px; margin-right: 6px; }
.rail-more .ic { width: 15px; height: 15px; transition: transform 0.25s var(--ease); }
.rail-more:hover .ic { transform: translateX(3px); }
.rail-b { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: var(--panel); border: 1px solid var(--line); transition: opacity 0.2s, background 0.2s, transform 0.2s var(--spring); }
.rail-b:hover { background: var(--panel-2); }
.rail-b:active { transform: scale(0.9); }
.rail-b .ic { width: 17px; height: 17px; }
.rail:not(.can-l) .rail-b[data-dir="-1"], .rail:not(.can-r) .rail-b[data-dir="1"] { opacity: 0.3; pointer-events: none; }
@media (hover: none) { .rail-b { display: none; } }
.rail-t { --fl: 0px; --fr: 0px; display: flex; gap: 16px; overflow-x: auto; overscroll-behavior-x: contain; scroll-snap-type: x proximity; scrollbar-width: none; padding: 8px var(--pad) 18px; margin: -8px calc(var(--pad) * -1) -18px; scroll-padding: 0 var(--pad); -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 var(--fl), #000 calc(100% - var(--fr)), transparent 100%); mask-image: linear-gradient(90deg, transparent 0, #000 var(--fl), #000 calc(100% - var(--fr)), transparent 100%); }
.rail-t::-webkit-scrollbar { display: none; }
.rail.can-l .rail-t { --fl: 36px; }
.rail.can-r .rail-t { --fr: 36px; }
.rail-t > .card { flex: 0 0 clamp(128px, 14vw, 172px); scroll-snap-align: start; }
.rail-t > .card .card-art { box-shadow: 0 6px 14px rgba(0, 0, 0, 0.3); }
.rail[aria-busy] .rail-t { overflow: hidden; }
.rail[aria-busy] .rail-h h2:empty { width: 160px; height: 22px; border-radius: 8px; background: rgba(255, 255, 255, 0.06); }
.rail-rank .rail-t { gap: 10px; }
.rcard { flex: 0 0 clamp(200px, 21vw, 268px); display: grid; grid-template-columns: auto 1fr; align-items: end; scroll-snap-align: start; position: relative; }
.rcard-n { grid-column: 1; grid-row: 1; font-size: clamp(96px, 9.5vw, 140px); font-weight: 800; line-height: 0.78; letter-spacing: -0.08em; color: transparent; -webkit-text-stroke: 2px rgba(255, 255, 255, 0.34); margin-right: -22px; padding-bottom: 6px; z-index: 0; transition: -webkit-text-stroke-color 0.3s, transform 0.4s var(--ease); font-variant-numeric: tabular-nums; }
.rcard:hover .rcard-n { -webkit-text-stroke-color: var(--accent-2); transform: translateY(-4px); }
.rcard-art { grid-column: 2; grid-row: 1; position: relative; z-index: 1; width: clamp(118px, 11.5vw, 156px); aspect-ratio: 2 / 3; border-radius: var(--r-m); overflow: hidden; background: linear-gradient(160deg, color-mix(in srgb, var(--c, #24415f) 55%, #0b1522), #0b1522); box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45); transition: transform 0.45s var(--ease); }
.rcard-art img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
@media (hover: hover) { .rcard:hover .rcard-art { transform: translateY(-6px) scale(1.03); } }
.rcard-i { grid-column: 1 / -1; grid-row: 2; display: flex; flex-direction: column; margin-top: 10px; min-width: 0; }
.rcard-i b { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rcard-i small { color: var(--txt-3); font-size: 12.5px; }

/* image fade-in (images carry .ld once loaded; see hydrate()) */
.card-art img, .rcard-art img, img.hero-bg, img.d-bg, .d-cover img, .wcover img, .sug-i img, .ep-img img, .gate-wall img, .avatar img { opacity: 0; transition: opacity 0.45s var(--ease), transform 0.9s var(--ease); }
.card-art img.ld, .rcard-art img.ld, img.hero-bg.ld, img.d-bg.ld, .d-cover img.ld, .wcover img.ld, .sug-i img.ld, .ep-img img.ld, .gate-wall img.ld, .avatar img.ld { opacity: 1; }
img.bad { visibility: hidden; }

/* ── hero carousel ── */
.view-home .page { padding-top: 14px; }
.hero { position: relative; border-radius: var(--r-xl); overflow: hidden; aspect-ratio: 21 / 9; min-height: 380px; max-height: 580px; background: #0e1a2b; box-shadow: var(--shadow); isolation: isolate; }
.hero-s { position: absolute; inset: 0; opacity: 0; visibility: hidden; transition: opacity 0.8s var(--ease), visibility 0s 0.8s; }
.hero-s.on { opacity: 1; visibility: visible; transition-delay: 0s; }
.hero-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 22%; }
img.hero-bg { transform: scale(1.07); }
.hero-s.on img.hero-bg { transform: scale(1); transition: opacity 0.45s var(--ease), transform 7.5s linear; }
.hero-scrim { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(8, 15, 26, 0.94) 0%, rgba(8, 15, 26, 0.62) 38%, rgba(8, 15, 26, 0.08) 72%), linear-gradient(0deg, rgba(8, 15, 26, 0.85) 0%, transparent 46%); }
.hero-c { position: absolute; left: clamp(20px, 4vw, 56px); right: clamp(20px, 4vw, 56px); bottom: clamp(24px, 4.4vw, 56px); max-width: 640px; display: flex; flex-direction: column; gap: 10px; }
.hero-s.on .hero-c > * { animation: heroUp 0.8s var(--ease) both; }
.hero-s.on .hero-c > :nth-child(2) { animation-delay: 0.06s; }
.hero-s.on .hero-c > :nth-child(3) { animation-delay: 0.1s; }
.hero-s.on .hero-c > :nth-child(4) { animation-delay: 0.14s; }
.hero-s.on .hero-c > :nth-child(5) { animation-delay: 0.18s; }
@keyframes heroUp { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: none; } }
.hero-badges { display: flex; gap: 8px; flex-wrap: wrap; }
.hero-t { font-size: clamp(28px, 4.4vw, 54px); font-weight: 800; letter-spacing: -0.035em; line-height: 1.04; text-shadow: 0 2px 20px rgba(0, 0, 0, 0.5); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.hero-g { color: var(--txt-2); font-weight: 600; font-size: 14px; }
.hero-d { color: rgba(238, 243, 249, 0.86); font-size: 15px; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; max-width: 54ch; }
.hero-a { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 6px; }
.hero-arrow { position: absolute; top: 50%; z-index: 4; width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; background: rgba(8, 16, 28, 0.5); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.14); opacity: 0; transform: translateY(-50%) scale(0.9); transition: opacity 0.25s, transform 0.3s var(--spring), background 0.2s; }
.hero-arrow.l { left: 16px; }
.hero-arrow.r { right: 16px; }
.hero:hover .hero-arrow, .hero:focus-within .hero-arrow { opacity: 1; transform: translateY(-50%); }
.hero-arrow:hover { background: rgba(8, 16, 28, 0.8); }
@media (hover: none) { .hero-arrow { display: none; } }
.hero-dots { position: absolute; right: clamp(20px, 4vw, 56px); bottom: clamp(20px, 3vw, 36px); z-index: 4; display: flex; gap: 7px; }
.hero-dot { width: 30px; height: 18px; display: grid; place-items: center; }
.hero-dot i { display: block; width: 100%; height: 4px; border-radius: 4px; background: rgba(255, 255, 255, 0.28); position: relative; overflow: hidden; transition: background 0.2s; }
.hero-dot:hover i { background: rgba(255, 255, 255, 0.5); }
.hero-dot.on i::after { content: ""; position: absolute; inset: 0; background: #fff; transform-origin: left; animation: dotfill 7.5s linear forwards; }
@keyframes dotfill { from { transform: scaleX(0); } to { transform: scaleX(1); } }
.hero:hover .hero-dot.on i::after, .hero:focus-within .hero-dot.on i::after, .hero.paused .hero-dot.on i::after { animation-play-state: paused; }
.hero-sk .hero-s { visibility: visible; opacity: 1; }
.hero-sk .hero-bg { border-radius: 0; }
.hero-sk .hero-c { gap: 12px; }
.hero-sk .hero-bg::after { animation-duration: 2s; }

/* Notice shown while the data came from a backup source (Jikan / Kitsu) because AniList is unavailable */
.bk-note { position: fixed; z-index: 350; left: 50%; transform: translateX(-50%); bottom: calc(76px + env(safe-area-inset-bottom)); width: min(92vw, 560px); display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px 10px 16px; border-radius: 14px; background: var(--glass-solid); border: 1px solid var(--line); box-shadow: var(--shadow); font-size: 13px; line-height: 1.4; color: var(--txt-2); }
.bk-note[hidden] { display: none; }
.bk-note span { flex: 1; padding-top: 3px; }
.bk-note button { flex: none; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; color: var(--txt-2); }
.bk-note button:hover { background: var(--panel-2); color: var(--txt); }
.bk-note svg { width: 16px; height: 16px; }
@media (min-width: 900px) { .bk-note { bottom: 20px; left: 24px; transform: none; } }

/* ── detail ── */
.view-detail .page { padding: 0 0 72px; max-width: none; }
.d-hero { position: relative; overflow: hidden; isolation: isolate; padding: clamp(24px, 5vw, 64px) var(--pad) 36px; background: linear-gradient(180deg, color-mix(in srgb, var(--c, #24415f) 40%, var(--bg)), var(--bg)); }
.d-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 20%; z-index: -2; }
img.d-bg.ld { opacity: 0.42; }
.d-bg.blur { filter: blur(48px) saturate(1.5); transform: scale(1.25); }
img.d-bg.blur.ld { opacity: 0.5; }
.d-fade { position: absolute; inset: 0; z-index: -1; background: linear-gradient(180deg, rgba(11, 21, 34, 0.35) 0%, rgba(11, 21, 34, 0.7) 55%, var(--bg) 100%); }
.d-in { max-width: var(--maxw); margin: 0 auto; display: grid; grid-template-columns: clamp(150px, 20vw, 260px) minmax(0, 1fr); gap: clamp(20px, 3.5vw, 48px); align-items: end; }
.d-cover { position: relative; aspect-ratio: 2 / 3; border-radius: var(--r-l); overflow: hidden; background: var(--panel); box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.1); }
.d-cover img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; view-transition-name: cover; }
.d-cover img.ld { opacity: 1; }
.d-cover:not(.sk) img { opacity: 1; }
.d-info { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.d-back { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px 6px 10px; border-radius: 999px; background: rgba(255, 255, 255, 0.1); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); font-size: 13.5px; font-weight: 600; margin-bottom: 4px; transition: background 0.2s; }
.d-back:hover { background: rgba(255, 255, 255, 0.18); }
.d-kicker { color: var(--accent-2); font-weight: 700; font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; }
.d-info h1 { font-size: clamp(28px, 4.6vw, 56px); font-weight: 800; letter-spacing: -0.04em; line-height: 1.04; text-wrap: balance; }
.d-alt { color: var(--txt-2); font-size: 14.5px; }
.d-stats { display: flex; align-items: center; gap: 16px; margin-top: 6px; flex-wrap: wrap; }
.d-stat-l { display: flex; gap: 6px 16px; flex-wrap: wrap; color: var(--txt-2); font-weight: 600; font-size: 14px; }
.d-stat-l span + span::before { content: "·"; margin-right: 16px; color: var(--txt-3); }
.ring { position: relative; width: 62px; height: 62px; flex: none; }
.ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.ring circle { fill: none; stroke: rgba(255, 255, 255, 0.14); stroke-width: 3; }
.ring .v { stroke: var(--ok); stroke-linecap: round; }
.ring b { position: absolute; inset: 0; display: grid; place-items: center; font-size: 17px; font-weight: 800; }
.d-actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 14px; }
.d-air { display: none; align-items: center; gap: 8px; margin-top: 8px; color: var(--txt-2); font-size: 14px; }
.d-air.on { display: flex; }
.d-air .ic { color: var(--accent-2); }
.d-air b { color: var(--txt); }
.d-body { max-width: var(--maxw); margin: 0 auto; padding: 8px var(--pad) 0; display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 36px; }
.d-main { display: flex; flex-direction: column; gap: 28px; min-width: 0; }
.d-body > .sk { margin-top: 12px; }
.d-syn { color: rgba(238, 243, 249, 0.88); line-height: 1.65; font-size: 15.5px; white-space: pre-line; max-width: 78ch; }
.d-syn.clamp { display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; }
.d-facts { padding: 20px; border-radius: var(--r-l); background: var(--panel); border: 1px solid var(--line); align-self: start; }
.d-facts dl { margin: 0; display: grid; gap: 12px; }
.d-facts dl div { display: flex; justify-content: space-between; gap: 16px; font-size: 14px; }
.d-facts dt { color: var(--txt-3); }
.d-facts dd { margin: 0; font-weight: 600; text-align: right; }
.d-rails { max-width: var(--maxw); margin: 0 auto; padding: 0 var(--pad); }
.view-detail .rail-t { padding-left: var(--pad); padding-right: var(--pad); }

/* ── library / gate / modal ── */
.gate { position: relative; min-height: calc(100vh - var(--hdr-h)); display: grid; place-items: center; padding: 24px; overflow: hidden; isolation: isolate; }
.view-gate .page, .view .page:has(.gate) { max-width: none; padding: 0; }
.gate-wall { position: absolute; inset: -6% -4%; z-index: -2; display: flex; flex-direction: column; gap: 14px; transform: rotate(-4deg) scale(1.1); opacity: 0.55; }
.wall-row { display: flex; gap: 14px; width: max-content; animation: wall 80s linear infinite; }
.wall-row.r1 { animation-direction: reverse; animation-duration: 95s; }
.wall-row.r2 { animation-duration: 110s; }
.wall-row img { width: 150px; aspect-ratio: 2 / 3; object-fit: cover; border-radius: 14px; flex: none; background: var(--panel); }
@keyframes wall { to { transform: translateX(-50%); } }
.gate::after { content: ""; position: absolute; inset: 0; z-index: -1; background: radial-gradient(60% 60% at 50% 50%, rgba(11, 21, 34, 0.55), rgba(11, 21, 34, 0.94)); }
.gate-card { width: min(440px, 100%); padding: 38px 32px; border-radius: 28px; background: var(--glass); backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur); border: 1px solid var(--line); box-shadow: var(--shadow); text-align: center; display: flex; flex-direction: column; align-items: center; gap: 14px; animation: heroUp 0.7s var(--ease) both; }
.gate-card h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.035em; }
.gate-card p { color: var(--txt-2); }
.gate-btns { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; margin-top: 8px; }
.gate-note { font-size: 13px; color: var(--txt-3) !important; min-height: 1.2em; }
.modal-b { position: fixed; inset: 0; z-index: 500; display: grid; place-items: center; padding: 20px; background: rgba(4, 9, 16, 0.7); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); opacity: 0; transition: opacity 0.22s; }
.modal-b.in { opacity: 1; }
.modal-b.out { opacity: 0; }
.modal { position: relative; width: min(640px, 100%); border-radius: var(--r-l); background: #0f1c2e; border: 1px solid var(--line); box-shadow: var(--shadow); padding: 14px; transform: scale(0.95) translateY(10px); transition: transform 0.4s var(--spring); }
.modal-b.in .modal { transform: none; }
.modal-wide { width: min(960px, 100%); }
.modal-x { position: absolute; top: -14px; right: -14px; width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; background: #1b2c46; border: 1px solid var(--line); box-shadow: var(--shadow); z-index: 2; }
.trailer { position: relative; aspect-ratio: 16 / 9; border-radius: var(--r-m); overflow: hidden; background: #000; }
.trailer iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }

/* ── watch ── */
.view-watch .page { max-width: 1760px; padding-top: 18px; }
.watch { display: grid; grid-template-columns: minmax(0, 1fr) clamp(320px, 26vw, 400px); gap: 22px; align-items: start; }
.watch-main { min-width: 0; display: flex; flex-direction: column; gap: 14px; }
.player { position: relative; aspect-ratio: 16 / 9; width: 100%; background: #000; border-radius: var(--r-l); overflow: hidden; box-shadow: var(--shadow); container-type: inline-size; user-select: none; -webkit-user-select: none; isolation: isolate; }
.wctl { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.wctl-g { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.wctl-nav .btn span { display: inline; }
.wsrv { display: flex; gap: 8px; flex-wrap: wrap; }
.wsrv:empty { display: none; }
.srv { padding: 6px 14px; border-radius: 999px; font-size: 13px; font-weight: 600; background: var(--panel); border: 1px solid var(--line); color: var(--txt-2); transition: background 0.2s, color 0.2s; }
.srv small { opacity: 0.7; font-weight: 500; margin-left: 3px; }
.srv:hover { background: var(--panel-2); color: var(--txt); }
.srv.on { background: var(--accent-soft); border-color: rgba(10, 132, 255, 0.6); color: #fff; }
.wnote { display: none; align-items: center; gap: 8px; padding: 10px 14px; border-radius: var(--r-m); background: rgba(255, 214, 10, 0.1); border: 1px solid rgba(255, 214, 10, 0.25); color: #ffe27a; font-size: 14px; }
.wnote.on { display: flex; }
.winfo { display: flex; gap: 16px; padding: 16px; border-radius: var(--r-l); background: var(--panel); border: 1px solid var(--line); }
.wcover { position: relative; width: 74px; aspect-ratio: 2 / 3; border-radius: 12px; overflow: hidden; flex: none; background: var(--panel); }
.wcover img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.wcover .sk { position: absolute; inset: 0; border-radius: 0; }
.winfo-t { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.winfo-t h1 { font-size: clamp(18px, 2vw, 22px); font-weight: 700; }
.winfo-t h1 a:hover { color: var(--accent-2); }
.winfo-s { color: var(--accent-2); font-weight: 600; font-size: 14px; min-height: 1.4em; }
.winfo-d { color: var(--txt-2); font-size: 14px; line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.winfo-d:empty { display: none; }
.chip-air { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px; background: var(--accent-soft); color: #bfe0ff; font-size: 13px; font-weight: 600; margin-top: 6px; }
.chip-air .ic { width: 14px; height: 14px; }
.eps { position: sticky; top: calc(var(--hdr-h) + 14px); display: flex; flex-direction: column; max-height: calc(100vh - var(--hdr-h) - 32px); border-radius: var(--r-l); background: var(--panel); border: 1px solid var(--line); overflow: hidden; }
.eps-h { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 14px 14px 10px 18px; }
.eps-h h2 { font-size: 17px; font-weight: 700; }
.eps-h h2 span { color: var(--txt-3); font-weight: 600; font-size: 14px; }
.eps-tabs { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; padding: 0 14px 10px; }
.eps-tabs:empty { display: none; }
.eps-tabs::-webkit-scrollbar { display: none; }
.eps-tab { flex: none; padding: 5px 12px; border-radius: 999px; font-size: 12.5px; font-weight: 700; color: var(--txt-2); background: var(--panel); font-variant-numeric: tabular-nums; transition: background 0.2s, color 0.2s; }
.eps-tab:hover { color: var(--txt); }
.eps-tab.on { background: var(--accent); color: #fff; }
.eps-b { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.2) transparent; padding: 4px 8px 10px; }
.eps-b.is-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(54px, 1fr)); gap: 8px; padding: 6px 14px 14px; align-content: start; }
.ep { position: relative; display: flex; align-items: center; gap: 12px; width: 100%; padding: 8px 10px; border-radius: 12px; text-align: left; transition: background 0.2s; }
.ep:hover { background: var(--panel-2); }
.ep.on { background: var(--accent-soft); box-shadow: inset 0 0 0 1px rgba(10, 132, 255, 0.55); }
.ep-img { position: relative; width: 92px; aspect-ratio: 16 / 9; border-radius: 8px; overflow: hidden; background: var(--panel-2); flex: none; }
.ep-img img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.ep-n { width: 30px; flex: none; text-align: center; font-weight: 800; font-size: 15px; color: var(--txt-2); font-variant-numeric: tabular-nums; }
.ep.on .ep-n { color: #fff; }
.ep-t { min-width: 0; flex: 1; display: flex; flex-direction: column; }
.ep-t b { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ep-t small { color: var(--txt-3); font-size: 12px; }
.ep.w:not(.on) .ep-t b, .ep.w:not(.on) .ep-n { opacity: 0.55; }
.ep-st { flex: none; display: grid; place-items: center; width: 24px; height: 24px; color: var(--accent-2); }
.ep-st.ok { color: var(--ok); }
.ep-st .ic { width: 16px; height: 16px; }
.ep-g { height: 46px; border-radius: 12px; background: var(--panel-2); font-weight: 700; font-size: 14px; font-variant-numeric: tabular-nums; transition: background 0.2s, transform 0.2s var(--spring); }
.ep-g:hover { background: var(--panel-3); }
.ep-g:active { transform: scale(0.92); }
.ep-g.w { color: var(--txt-3); }
.ep-g.f { box-shadow: inset 0 -3px 0 rgba(255, 214, 10, 0.6); }
.ep-g.on { background: var(--accent); color: #fff; }
.sk-ep { pointer-events: none; }
.sk-ep .sk-l { flex: 1; margin: 0; height: 14px; }
.eps-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 40px 20px; color: var(--txt-3); text-align: center; }

/* ── custom video player ── */
.pl-v { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #000; }
.pl-v::cue { background: rgba(0, 0, 0, 0.72); color: #fff; font: 600 clamp(15px, 2.4cqw, 28px) var(--font); line-height: 1.3; text-shadow: 0 1px 2px #000; }
.pl-embed { position: absolute; inset: 0; display: none; }
.pl-embed iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #000; }
.is-embed .pl-embed { display: block; }
.is-embed .pl-v, .is-embed .pl-shade, .is-embed .pl-ctl, .is-embed .pl-big, .is-embed .pl-spin, .is-embed .pl-top, .is-embed .pl-skip, .is-embed .pl-next { display: none; }
.pl-shade { position: absolute; inset: 0; cursor: pointer; background: linear-gradient(180deg, rgba(0, 0, 0, 0.62) 0%, transparent 22%, transparent 55%, rgba(0, 0, 0, 0.78) 100%); transition: opacity 0.35s var(--ease); }
.pl-top { position: absolute; top: 0; left: 0; right: 0; padding: 16px 20px; pointer-events: none; transition: opacity 0.35s var(--ease), transform 0.35s var(--ease); }
.pl-ttl { display: flex; flex-direction: column; text-shadow: 0 1px 8px rgba(0, 0, 0, 0.6); }
.pl-ttl b { font-size: clamp(14px, 2.4cqw, 20px); font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pl-ttl small { color: rgba(255, 255, 255, 0.78); font-size: clamp(12px, 1.8cqw, 14px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pl-big { position: absolute; top: 50%; left: 50%; width: clamp(60px, 11cqw, 88px); height: clamp(60px, 11cqw, 88px); margin: calc(clamp(60px, 11cqw, 88px) / -2) 0 0 calc(clamp(60px, 11cqw, 88px) / -2); border-radius: 50%; display: grid; place-items: center; background: rgba(255, 255, 255, 0.16); backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur); border: 1px solid rgba(255, 255, 255, 0.25); box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5); opacity: 0; transform: scale(0.8); pointer-events: none; transition: opacity 0.3s, transform 0.4s var(--spring); }
.pl-big .ic { width: 42%; height: 42%; margin-left: 4%; }
.player:not(.is-playing):not(.is-loading):not(.is-error):not(.is-ended):not(.is-embed) .pl-big { opacity: 1; transform: none; pointer-events: auto; }
.pl-big:hover { background: rgba(255, 255, 255, 0.26); }
.pl-spin { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center; gap: 10px; opacity: 0; pointer-events: none; transition: opacity 0.25s 0.12s; text-align: center; max-width: 80%; }
.is-loading .pl-spin { opacity: 1; }
.pl-spin i { width: 46px; height: 46px; border-radius: 50%; border: 3.5px solid rgba(255, 255, 255, 0.22); border-top-color: #fff; animation: spin 0.8s linear infinite; }
.pl-spin span { font-size: 13px; font-weight: 600; color: rgba(255, 255, 255, 0.85); text-shadow: 0 1px 6px #000; }
.pl-spin span:empty { display: none; }
@keyframes spin { to { transform: rotate(360deg); } }
.pl-flash { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.7); display: flex; align-items: center; gap: 8px; padding: 14px 22px; border-radius: 999px; background: rgba(0, 0, 0, 0.62); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); font-weight: 700; font-size: 17px; opacity: 0; pointer-events: none; }
.pl-flash:empty { display: none; }
.pl-flash .ic { width: 26px; height: 26px; }
.pl-flash.go { animation: flash 0.7s var(--ease) both; }
@keyframes flash { 0% { opacity: 0; transform: translate(-50%, -50%) scale(0.7); } 18% { opacity: 1; transform: translate(-50%, -50%) scale(1); } 70% { opacity: 1; } 100% { opacity: 0; transform: translate(-50%, -50%) scale(1.04); } }
.pl-err { position: absolute; inset: 0; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 24px; text-align: center; background: rgba(5, 10, 18, 0.88); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); z-index: 6; }
.is-error .pl-err { display: flex; animation: viewIn 0.4s var(--ease) both; }
.pl-err-i { width: 54px; height: 54px; border-radius: 50%; display: grid; place-items: center; background: rgba(255, 69, 58, 0.16); color: var(--err); }
.pl-err-i .ic { width: 26px; height: 26px; }
.pl-err b { font-size: 18px; }
.pl-err p { max-width: 520px; color: var(--txt-2); font-size: 14px; white-space: pre-line; overflow-wrap: anywhere; }
.pl-err-a { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-top: 6px; }
.pl-skip, .pl-next { position: absolute; right: 16px; bottom: 86px; z-index: 4; opacity: 0; transform: translateY(10px) scale(0.96); pointer-events: none; transition: opacity 0.3s, transform 0.4s var(--spring); }
.pl-skip { display: inline-flex; align-items: center; gap: 4px; padding: 10px 16px 10px 18px; border-radius: 999px; background: rgba(255, 255, 255, 0.92); color: #0b1522; font-weight: 700; font-size: 14px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45); }
.pl-skip .ic { width: 16px; height: 16px; }
.pl-skip.on { opacity: 1; transform: none; pointer-events: auto; }
.pl-skip:hover { background: #fff; }
.show-next .pl-skip.on { bottom: 168px; }
.pl-next { display: flex; align-items: stretch; border-radius: 18px; background: var(--glass); backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur); border: 1px solid rgba(255, 255, 255, 0.16); box-shadow: 0 10px 32px rgba(0, 0, 0, 0.5); overflow: hidden; }
.show-next .pl-next { opacity: 1; transform: none; pointer-events: auto; }
.pl-next-b { display: flex; align-items: center; gap: 12px; padding: 10px 14px 10px 10px; text-align: left; }
.pl-next-b small { display: block; color: var(--txt-2); font-size: 12px; font-weight: 600; }
.pl-next-b b { font-size: 14px; }
.pl-next-r { position: relative; width: 44px; height: 44px; display: grid; place-items: center; flex: none; }
.pl-next-r svg { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); }
.pl-next-r circle { fill: none; stroke: rgba(255, 255, 255, 0.2); stroke-width: 3; }
.pl-next-r .v { stroke: #fff; stroke-linecap: round; stroke-dasharray: 100; stroke-dashoffset: 100; }
.pl-next-r .ic { width: 18px; height: 18px; }
.pl-next-x { width: 34px; display: grid; place-items: center; color: var(--txt-2); border-left: 1px solid rgba(255, 255, 255, 0.12); }
.pl-next-x:hover { color: #fff; background: rgba(255, 255, 255, 0.08); }
.pl-next-x .ic { width: 14px; height: 14px; }
.pl-end { position: absolute; inset: 0; display: none; place-items: center; z-index: 3; pointer-events: none; }
.is-ended .pl-end { display: grid; }
.is-ended .pl-end button { pointer-events: auto; display: inline-flex; align-items: center; gap: 8px; padding: 12px 22px; border-radius: 999px; background: rgba(255, 255, 255, 0.18); backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur); font-weight: 700; border: 1px solid rgba(255, 255, 255, 0.25); }
.show-next.is-ended .pl-end { display: none; }
.pl-ctl { position: absolute; left: 0; right: 0; bottom: 0; padding: 0 clamp(10px, 2.2cqw, 20px) clamp(6px, 1.4cqw, 12px); z-index: 5; transition: opacity 0.35s var(--ease), transform 0.35s var(--ease); }
.pl-seek { position: relative; height: 22px; display: flex; align-items: center; cursor: pointer; touch-action: none; outline-offset: 0; }
.pl-rail { position: relative; width: 100%; height: 4px; border-radius: 4px; background: rgba(255, 255, 255, 0.22); overflow: hidden; transition: height 0.2s var(--ease); }
.pl-seek:hover .pl-rail, .is-scrub .pl-rail { height: 7px; }
.pl-buf, .pl-prog { position: absolute; inset: 0; transform-origin: left; transform: scaleX(0); }
.pl-buf { background: rgba(255, 255, 255, 0.28); }
.pl-prog { background: var(--accent); }
.pl-mk { position: absolute; top: 0; bottom: 0; display: none; background: rgba(255, 255, 255, 0.5); mix-blend-mode: screen; border-radius: 2px; }
.pl-knob { position: absolute; left: 0; top: 50%; width: 15px; height: 15px; margin: -7.5px 0 0 -7.5px; border-radius: 50%; background: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5); transform: scale(0); transition: transform 0.2s var(--spring); pointer-events: none; }
.pl-seek:hover .pl-knob, .is-scrub .pl-knob, .pl-seek:focus-visible .pl-knob { transform: scale(1); }
@media (hover: none) { .pl-knob { transform: scale(1); } }
.pl-tip { position: absolute; bottom: 26px; transform: translateX(-50%); padding: 3px 8px; border-radius: 8px; background: rgba(0, 0, 0, 0.75); font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; opacity: 0; pointer-events: none; transition: opacity 0.15s; }
.pl-seek:hover .pl-tip, .is-scrub .pl-tip { opacity: 1; }
.pl-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.pl-g { display: flex; align-items: center; gap: 2px; min-width: 0; }
.pl-btn { width: clamp(34px, 6cqw, 42px); height: clamp(34px, 6cqw, 42px); border-radius: 50%; display: grid; place-items: center; flex: none; transition: background 0.2s, transform 0.2s var(--spring), opacity 0.2s; }
.pl-btn .ic { width: 62%; height: 62%; }
.pl-btn:hover { background: rgba(255, 255, 255, 0.16); }
.pl-btn:active { transform: scale(0.88); }
.pl-btn:disabled { opacity: 0.3; pointer-events: none; }
.pl-vol { display: flex; align-items: center; }
.pl-vol input { width: 0; opacity: 0; margin: 0; accent-color: #fff; height: 4px; transition: width 0.3s var(--ease), opacity 0.2s, margin 0.3s var(--ease); cursor: pointer; }
.pl-vol:hover input, .pl-vol:focus-within input { width: 78px; opacity: 1; margin: 0 8px 0 2px; }
.pl-time { margin-left: 6px; font-size: clamp(12px, 1.8cqw, 14px); font-weight: 600; font-variant-numeric: tabular-nums; color: rgba(255, 255, 255, 0.92); white-space: nowrap; }
.pl-pop { position: absolute; right: 12px; bottom: 74px; z-index: 7; min-width: 190px; max-width: calc(100% - 24px); max-height: calc(100% - 100px); overflow-y: auto; padding: 6px; border-radius: 16px; background: rgba(14, 26, 43, 0.92); backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur); border: 1px solid rgba(255, 255, 255, 0.14); box-shadow: var(--shadow); transform-origin: bottom right; scrollbar-width: thin; }
.pl-pop:not([hidden]) { animation: menuIn 0.25s var(--spring) both; }
.pop-h { padding: 8px 12px 4px; font-size: 11.5px; font-weight: 800; letter-spacing: 0.07em; text-transform: uppercase; color: var(--txt-3); }
.pop-i { display: flex; align-items: center; justify-content: space-between; gap: 14px; width: 100%; padding: 8px 12px; border-radius: 10px; font-size: 14px; font-weight: 500; text-align: left; }
.pop-i:hover { background: rgba(255, 255, 255, 0.1); }
.pop-i.on { color: var(--accent-2); font-weight: 700; }
.pop-i .ic { width: 16px; height: 16px; }
.pop-none { padding: 10px 12px; color: var(--txt-3); font-size: 13px; max-width: 220px; }
.pop-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 8px 10px; font-size: 13.5px; font-weight: 600; }
.is-idle { cursor: none; }
.is-idle .pl-ctl, .is-idle .pl-top { opacity: 0; transform: translateY(8px); pointer-events: none; }
.is-idle .pl-top { transform: translateY(-8px); }
.is-idle .pl-shade { opacity: 0; }
.is-idle .pl-skip.on, .is-idle .pl-next { bottom: 24px; }
.player.is-fs { border-radius: 0; width: 100vw; height: 100vh; aspect-ratio: auto; }
.player:fullscreen { border-radius: 0; aspect-ratio: auto; }
@container (max-width: 560px) {
  .hide-s { display: none !important; }
  .pl-vol { display: none; }
  .pl-skip, .pl-next { bottom: 70px; }
  .pl-next-b small { display: none; }
  .show-next .pl-skip.on { bottom: 130px; }
  .pl-pop { bottom: 64px; }
}

/* ── manga reader ── */
.view-read .page { max-width: none; padding: 0; }
.reader { position: relative; min-height: calc(100vh - var(--hdr-h)); min-height: calc(100dvh - var(--hdr-h)); background: #05090f; display: flex; flex-direction: column; }
.reader.is-fs { min-height: 100vh; min-height: 100dvh; }
.rd-bar { position: sticky; z-index: 30; display: flex; align-items: center; gap: 10px; padding: 8px clamp(10px, 2vw, 22px); background: var(--glass); backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur); transition: transform 0.4s var(--ease), opacity 0.3s; }
.rd-top { top: var(--hdr-h); border-bottom: 1px solid var(--line); }
.reader.is-fs .rd-top { top: 0; }
.rd-bot { bottom: 0; border-top: 1px solid var(--line); padding-bottom: calc(8px + env(safe-area-inset-bottom)); margin-top: auto; }
.rd-hide .rd-top { transform: translateY(-120%); opacity: 0; pointer-events: none; }
.rd-hide .rd-bot { transform: translateY(120%); opacity: 0; pointer-events: none; }
.rd-btn { width: 40px; height: 40px; display: inline-grid; place-items: center; border-radius: 50%; flex: none; transition: background 0.2s, transform 0.2s var(--spring); }
.rd-btn:hover { background: var(--panel-2); }
.rd-btn:active { transform: scale(0.9); }
.rd-ttl { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; }
.rd-ttl b { font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.rd-ttl .sel { flex: none; max-width: 52%; }
.rd-tools { display: flex; gap: 4px; flex: none; }
.rd-stage { position: relative; flex: 1; display: grid; place-items: center; min-height: 60vh; outline: none; }
.rd-wait, .rd-load { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 80px 20px; color: var(--txt-2); font-size: 14px; }
.rd-load { min-height: 60vh; justify-content: center; }
.rd-skel { position: relative; width: 150px; aspect-ratio: 2 / 3; border-radius: 12px; overflow: hidden; }
.rd-skel .sk { position: absolute; inset: 0; border-radius: 0; }
.rd-spread { display: flex; justify-content: center; align-items: center; width: 100%; }
[data-dir="rtl"] .rd-spread { flex-direction: row-reverse; }
.rd-pg { position: relative; margin: 0; display: grid; place-items: center; }
.rd-pg:not(.ld) { min-height: 50vh; min-width: min(60vw, 320px); }
.rd-pg > .sk { position: absolute; inset: 0; border-radius: 0; }
.rd-pg img { display: block; opacity: 0; transition: opacity 0.35s var(--ease); max-width: 100%; height: auto; }
.rd-pg.ld img { opacity: 1; }
.rd-pg.ld > .sk { display: none; }
.rd-pg.bad { min-height: 40vh; }
.rd-pg.bad img { display: none; }
.rd-retry { position: absolute; }
[data-mode="single"][data-fit="height"] .rd-pg img { max-height: calc(100vh - 2 * var(--hdr-h) - 20px); max-height: calc(100dvh - 2 * var(--hdr-h) - 20px); width: auto; }
[data-mode="double"][data-fit="height"] .rd-pg img { max-height: calc(100vh - 2 * var(--hdr-h) - 20px); max-height: calc(100dvh - 2 * var(--hdr-h) - 20px); width: auto; max-width: 50vw; }
.reader.is-fs[data-fit="height"] .rd-pg img { max-height: calc(100dvh - 20px); }
[data-mode="single"][data-fit="width"] .rd-pg { width: min(100%, 1100px); }
[data-mode="single"][data-fit="width"] .rd-pg img { width: 100%; }
[data-mode="double"][data-fit="width"] .rd-pg { width: 50%; }
[data-mode="double"][data-fit="width"] .rd-pg img { width: 100%; }
[data-mode="single"] .rd-stage, [data-mode="double"] .rd-stage { cursor: pointer; }
.rd-spread.n1 .rd-pg { margin: 0 auto; }
.rd-strip { width: min(100%, 880px); margin: 0 auto; display: flex; flex-direction: column; }
.rd-strip .rd-pg { width: 100%; }
.rd-strip .rd-pg:not(.ld) { aspect-ratio: 2 / 3; min-height: 0; }
.rd-strip .rd-pg img { width: 100%; }
.rd-pg-n { min-width: 62px; text-align: center; font-weight: 700; font-size: 14px; font-variant-numeric: tabular-nums; flex: none; }
.rd-slider { flex: 1; min-width: 0; accent-color: var(--accent); height: 4px; cursor: pointer; }
[data-dir="rtl"] .rd-slider { direction: rtl; }
.rd-pop { position: fixed; right: clamp(10px, 2vw, 22px); bottom: calc(70px + env(safe-area-inset-bottom)); z-index: 240; width: min(340px, calc(100% - 20px)); padding: 10px; border-radius: 18px; background: rgba(14, 26, 43, 0.94); backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur); border: 1px solid var(--line); box-shadow: var(--shadow); display: flex; flex-direction: column; gap: 6px; transform-origin: bottom right; }
.rd-pop:not([hidden]) { animation: menuIn 0.28s var(--spring) both; }
.rd-pop .pop-row { flex-wrap: wrap; }
.rd-pop .seg button { padding: 5px 11px; font-size: 13px; }
.rd-cands { display: flex; flex-direction: column; gap: 8px; margin: 10px 0; width: min(420px, 100%); }
.rd-cands .btn { justify-content: flex-start; white-space: normal; text-align: left; }
.rd-ext { text-align: center; margin-top: -30px; padding-bottom: 40px; }
.rd-ext a { display: inline-flex; align-items: center; gap: 6px; color: var(--accent-2); font-weight: 600; }

/* ── responsive ── */
@media (max-width: 1180px) {
  .pnav-i:not(.on) span { display: none; }
  .pnav-i { padding: 8px 11px; }
  .prof-name { display: none; }
  .prof-btn { padding-right: 6px; }
}
@media (max-width: 1100px) {
  .watch { grid-template-columns: minmax(0, 1fr) 320px; }
  .d-body { grid-template-columns: 1fr; }
  .d-facts { order: 2; }
}
@media (max-width: 900px) {
  :root { --hdr-h: 56px; }
  .watch { grid-template-columns: 1fr; }
  .view-watch .page { padding-top: 0; }
  .player { position: sticky; top: var(--hdr-h); z-index: 40; border-radius: 0; margin: 0 calc(var(--pad) * -1); width: calc(100% + var(--pad) * 2); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45); }
  .player.is-fs { margin: 0; width: 100vw; position: relative; top: auto; }
  .watch-main { gap: 12px; }
  .eps { position: static; max-height: none; }
  .eps-b:not(.is-grid) { max-height: 62vh; }
  .eps-b.is-grid { max-height: 62vh; overflow-y: auto; }
  .watch { gap: 14px; }
  .hero { aspect-ratio: 16 / 11; min-height: 420px; }
}
@media (max-width: 760px) {
  body { padding-bottom: calc(var(--tab-h) + env(safe-area-inset-bottom)); }
  .pnav, .sbox { display: none; }
  .only-m { display: inline-grid; }
  .brand-name { display: none; }
  .tabbar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 210; display: grid; grid-template-columns: repeat(5, 1fr); height: calc(var(--tab-h) + env(safe-area-inset-bottom)); padding: 6px 6px env(safe-area-inset-bottom); background: var(--glass); backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur); border-top: 1px solid var(--line); }
  .tab { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; border-radius: 14px; font-size: 10.5px; font-weight: 700; color: var(--txt-3); transition: color 0.2s, background 0.2s, transform 0.25s var(--spring); }
  .tab .ic { width: 23px; height: 23px; transition: transform 0.3s var(--spring); }
  .tab.on { color: var(--accent); }
  .tab.on .ic { transform: translateY(-1px) scale(1.08); }
  .tab:active { transform: scale(0.92); }
  .view-read ~ .tabbar { display: none; }
  body:has(.view-read) { padding-bottom: 0; }
  .toasts { bottom: calc(var(--tab-h) + 16px + env(safe-area-inset-bottom)); }
  .rail-t > .card { flex-basis: clamp(120px, 34vw, 150px); }
  .rcard { flex-basis: clamp(180px, 56vw, 230px); }
  .grid { grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 20px 12px; }
  .hero { border-radius: var(--r-l); min-height: 400px; aspect-ratio: auto; height: 62vh; max-height: 520px; }
  .hero-d { display: none; }
  .hero-dots { left: 20px; right: auto; bottom: 22px; }
  .hero-c { bottom: 46px; }
  .d-in { grid-template-columns: 1fr; text-align: left; }
  .d-cover { width: min(46vw, 190px); }
  .d-info { align-items: flex-start; }
  .page-h { align-items: flex-start; }
  .bigsearch input { height: 50px; font-size: 16px; }
  .winfo { padding: 12px; gap: 12px; }
  .wctl-nav { width: 100%; }
  .wctl-nav .btn { flex: 1; }
  .rd-ttl b { display: none; }
  .rd-ttl .sel { max-width: 100%; flex: 1; }
  .rd-ttl .sel select { width: 100%; }
  .menu { position: fixed; left: 12px; right: 12px; top: calc(var(--hdr-h) + 8px); width: auto; }
}
@media (max-width: 420px) {
  .hero-a .btn { flex: 1; }
  .gate-card { padding: 30px 22px; }
}
@media (hover: none) {
  .pl-vol { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0.01ms !important; scroll-behavior: auto !important; }
  .sk::after, .hero-dot.on i::after, .view-in, .wall-row { animation: none !important; }
  .hero-s.on .hero-c > *, .toast, .menu, .gate-card { animation-duration: 0.01ms !important; }
}
`;
