import { getMedia } from "../core/anilist.js";
import {
  buildTitles,
  decodeEntities,
  diceCoeff,
  episodeMeta,
  expectedCount,
  fetchHtml,
  getPrequelOffset,
  json,
  norm,
  selectSeries,
} from "../core/new-provider-utils.js";
import { get, set, isFresh, SHOW_IDENTITY_TTL } from "../core/smartcache.js";

const BASE = "https://anizone.to";

function scoreCandidate(query, candidate, slug) {
  const base = Math.max(diceCoeff(query, candidate), diceCoeff(query, slug.replace(/-/g, " ")));
  const isMovieQuery = /\b(movie|film|the movie)\b/i.test(query);
  const isMovieMatch = /\b(movie|film)\b/i.test(candidate) || /movie|film/.test(slug);
  if (isMovieQuery && !isMovieMatch) return base * 0.4;
  const qLen = norm(query).length;
  const sLen = norm(slug.replace(/-/g, " ")).length;
  return sLen > qLen * 1.6 + 4 ? base * 0.8 : base;
}

function buildSearchQueries(title) {
  const queries = new Set([title]);
  const words = title.trim().split(/\s+/);
  if (words.length > 4) queries.add(words.slice(0, 4).join(" "));
  if (words.length > 3) queries.add(words.slice(0, 3).join(" "));
  const stripped = title
    .replace(/\bseason\s*\d+\b/gi, "")
    .replace(/\bpart\s*\d+\b/gi, "")
    .replace(/\b\d+rd\b|\b\d+th\b|\b\d+st\b|\b\d+nd\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped && stripped !== title) queries.add(stripped);
  return [...queries].filter((q) => q.length >= 3);
}

async function findCandidates(titles, searchFn, n = 6) {
  const allCandidates = new Map();
  const searchQueries = new Set();
  for (const title of titles.slice(0, 4)) {
    for (const q of buildSearchQueries(title)) searchQueries.add(q);
  }
  await Promise.all([...searchQueries].map(async (q) => {
    try {
      const results = await searchFn(q);
      for (const r of results) if (!allCandidates.has(r.slug)) allCandidates.set(r.slug, r.text);
    } catch {}
  }));
  const scored = [];
  for (const [slug, text] of allCandidates) {
    let best = 0;
    for (const title of titles.slice(0, 2)) best = Math.max(best, scoreCandidate(title, text, slug));
    if (best >= 0.5) scored.push({ slug, title: text, score: best });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, n);
}

function processJsonArg(raw) {
  const PH = "\x01U\x01";
  let s = raw.replace(/\\\\u([0-9a-fA-F]{4})/g, `${PH}$1`);
  s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\x01U\x01([0-9a-fA-F]{4})/g, "\\u$1");
  try { return JSON.parse(s); } catch { return {}; }
}

function pickTitle(titles) {
  return titles["1"] || titles["5"] || titles["8"] || Object.values(titles)[0] || "";
}

function extractSlug(ctx) {
  const m = ctx.match(/href="(?:https:\/\/anizone\.to)?\/anime\/([a-z0-9-]+)"/);
  return m ? m[1] : null;
}

function extractJsonArg(xdata, key) {
  const re = new RegExp(`${key}:\\s*JSON\\.parse\\('((?:[^'\\\\]|\\\\.)*)'\\)`);
  const m = xdata.match(re);
  return m ? m[1] : null;
}

async function search(query) {
  const html = await fetchHtml(`${BASE}/anime?search=${encodeURIComponent(query)}`);
  const results = [];
  const xdataRe = /x-data="(\{[^"]*anmTitles[^"]*\})"/g;
  let m;
  while ((m = xdataRe.exec(html)) !== null) {
    const ctxStart = Math.max(0, m.index - 300);
    const ctxEnd = Math.min(html.length, m.index + m[0].length + 800);
    const ctx = html.slice(ctxStart, ctxEnd);
    const slug = extractSlug(ctx);
    if (!slug) continue;
    const xdata = decodeEntities(m[1]);
    const raw = extractJsonArg(xdata, "anmTitles");
    if (!raw) continue;
    const titles = processJsonArg(raw);
    const title = pickTitle(titles);
    if (title) results.push({ slug, text: title });
  }
  return results;
}

async function scrapeSeries(slug) {
  const html = await fetchHtml(`${BASE}/anime/${slug}`);
  const episodes = [];
  const xdataRe = /x-data="(\{[^"]*epsTitles[^"]*\})"/g;
  let m;
  while ((m = xdataRe.exec(html)) !== null) {
    const ctxStart = Math.max(0, m.index - 400);
    const ctxEnd = Math.min(html.length, m.index + m[0].length + 800);
    const ctx = html.slice(ctxStart, ctxEnd);
    const numMatch = ctx.match(/href="(?:https:\/\/anizone\.to)?\/anime\/[a-z0-9-]+\/(\d+)"/);
    if (!numMatch) continue;
    const num = Number(numMatch[1]);
    if (!Number.isFinite(num) || num < 1) continue;
    const xdata = decodeEntities(m[1]);
    const raw = extractJsonArg(xdata, "epsTitles");
    let title = `Episode ${num}`;
    if (raw) {
      const titles = processJsonArg(raw);
      title = pickTitle(titles) || title;
    }
    episodes.push({ number: num, title, hasSub: true, hasDub: false });
  }
  const seen = new Set();
  return episodes
    .filter(e => seen.has(e.number) ? false : (seen.add(e.number), true))
    .sort((a, b) => a.number - b.number);
}

async function scrapeWatch(slug, episodeNum) {
  const html = await fetchHtml(`${BASE}/anime/${slug}/${episodeNum}`);

  const hlsMatch = html.match(/<media-player[^>]+src="([^"]+\.m3u8[^"]*)"/i);
  const hls = hlsMatch ? decodeEntities(hlsMatch[1]) : null;

  const subtitles = [];
  const trackRe = /<track\b([^>]*)>/gi;
  let t;
  while ((t = trackRe.exec(html)) !== null) {
    const attrs = t[1];
    const kind = attrs.match(/kind="([^"]*)"/i)?.[1] ?? "";
    if (kind !== "subtitles") continue;
    const src = attrs.match(/src=["']?([^\s"'>]+)["']?/i)?.[1] ?? "";
    const label = attrs.match(/label="([^"]*)"/i)?.[1] ?? "";
    const srclang = attrs.match(/srclang="([^"]*)"/i)?.[1] ?? "";
    const dataType = attrs.match(/data-type="([^"]*)"/i)?.[1] ?? "vtt";
    const isDefault = /\bdefault\b/.test(attrs);
    if (src) subtitles.push({ url: decodeEntities(src), label, srclang, format: dataType, default: isDefault });
  }

  const storyboardMatch = html.match(/thumbnails="([^"]+\.vtt[^"]*)"/i);
  const storyboard = storyboardMatch ? decodeEntities(storyboardMatch[1]) : null;

  const chaptersMatch = html.match(/<track\b[^>]*kind="chapters"[^>]*src=["']?([^\s"'>]+)["']?/i);
  const chapters = chaptersMatch ? decodeEntities(chaptersMatch[1]) : null;

  return { hls, subtitles, storyboard, chapters };
}

async function searchFn(query) {
  const r1 = await search(query);
  // AniZone needs a plain alphanumeric token to surface all season variants
  // e.g. "Re:ZERO -Starting Life..." → "ReZERO" finds all (2020)/(2021)/(2026) slugs
  const compact = query.split(/\s+/)[0].replace(/[^a-zA-Z0-9]/g, "");
  if (compact.length >= 4 && compact.toLowerCase() !== query.toLowerCase()) {
    try {
      const r2 = await search(compact);
      const seen = new Set(r1.map(r => r.slug));
      r2.forEach(r => { if (!seen.has(r.slug)) r1.push(r); });
    } catch {}
  }
  return r1;
}

async function resolveSeries(anilistId, ctx = {}) {
  const cacheKey = `np:anizone:${anilistId}`;
  const cached = get(cacheKey);
  if (isFresh(cached)) return cached.data;

  const media = ctx.media ?? await getMedia(anilistId);
  const titles = buildTitles(media, ctx.anizip);
  let candidates = await findCandidates(titles, searchFn);

  // AniZone uses "(YEAR)" suffixes for sequel seasons instead of slug numbers.
  // When seasonYear is available and any candidate carries a year, re-score so the
  // matching year wins decisively and wrong-year / year-less entries fall below threshold.
  const seasonYear = media?.seasonYear;
  if (seasonYear && candidates.some(c => /\(\d{4}\)/.test(c.title))) {
    candidates = candidates.map(c => {
      const m = c.title.match(/\((\d{4})\)/);
      if (m) {
        return parseInt(m[1]) === seasonYear
          ? { ...c, score: Math.min(1, c.score * 1.3) }
          : { ...c, score: c.score * 0.5 };
      }
      // No year suffix = base/S1 entry; penalise when sequels are expected
      return { ...c, score: c.score * 0.65 };
    }).sort((a, b) => b.score - a.score);
  }

  const expected = expectedCount(media, ctx.anizip, ctx.jikanEps);
  const offset = await getPrequelOffset(anilistId).catch(() => 0);
  const selected = await selectSeries(candidates, scrapeSeries, expected, media?.status, offset);
  if (!selected) throw new Error(`AniZone match not found for AniList ${anilistId}`);
  const data = { slug: selected.slug, title: selected.title, mode: selected.mode, offset, score: selected.score };
  set(cacheKey, data, SHOW_IDENTITY_TTL);
  return data;
}

function buildEpisodeLists(anilistId, series, providerEpisodes, ctx, expected) {
  const sub = [], dub = [];
  for (const src of providerEpisodes) {
    const number = series.mode === "offset" ? src.number - series.offset : src.number;
    if (number < 1) continue;
    if (expected && number > expected) continue;
    const meta = episodeMeta(number, ctx);
    const base = {
      number,
      title: meta.title ?? src.title ?? `Episode ${number}`,
      duration: meta.duration,
      filler: meta.filler,
      uncensored: meta.uncensored,
      description: meta.description,
      image: meta.image,
      airDate: meta.airDate,
      sourceNumber: src.number,
    };
    if (src.hasSub) sub.push({ id: `watch/anizone/${anilistId}/sub/anizone-${number}`, ...base, audio: "sub" });
    if (src.hasDub) dub.push({ id: `watch/anizone/${anilistId}/dub/anizone-${number}`, ...base, audio: "dub" });
  }
  return { sub, dub };
}

export async function getEpisodes(anilistId, ctx = {}) {
  const media = ctx.media ?? await getMedia(anilistId);
  const localCtx = { ...ctx, media };
  const series = await resolveSeries(anilistId, localCtx);
  const episodes = await scrapeSeries(series.slug);
  const expected = expectedCount(media, ctx.anizip, ctx.jikanEps);
  return {
    meta: {
      id: series.slug,
      title: series.title,
      source: "anizone",
      matchScore: Number(series.score.toFixed(3)),
      numbering: series.mode,
      episodeOffset: series.mode === "offset" ? series.offset : 0,
    },
    episodes: buildEpisodeLists(anilistId, series, episodes, localCtx, expected),
  };
}

async function handleWatch(anilistId, audio, epNum, ctx = {}) {
  const series = await resolveSeries(anilistId, ctx);
  const providerEp = series.mode === "offset" ? Number(epNum) + series.offset : Number(epNum);
  const watch = await scrapeWatch(series.slug, providerEp);
  if (!watch.hls) throw new Error(`No HLS stream found for AniZone episode ${providerEp}`);
  return json({
    anilistId: Number(anilistId),
    episode: Number(epNum),
    providerEpisode: providerEp,
    audio,
    streams: [{
      url: watch.hls,
      type: "hls",
      server: "AniZone",
      subtitles: watch.subtitles,
      storyboard: watch.storyboard,
      chapters: watch.chapters,
      priority: 1,
      isActive: true,
    }],
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Access-Control-Allow-Headers": "*" } });
    }
    try {
      const m = url.pathname.match(/^\/watch\/anizone\/(\d+)\/(sub|dub)\/anizone-(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message, "Raw-ERROR": err.rawBody ?? null, stack: err.stack }, 500);
    }
  },
};
