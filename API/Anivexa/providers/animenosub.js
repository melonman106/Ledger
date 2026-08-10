import crypto from "node:crypto";
import { getMedia } from "../core/anilist.js";
import {
  buildTitles,
  decodeEntities,
  episodeMeta,
  expectedCount,
  fetchHtml,
  findTopSlugs,
  getPrequelOffset,
  json,
  selectSeries,
} from "../core/new-provider-utils.js";
import { get, set, isFresh, SHOW_IDENTITY_TTL } from "../core/smartcache.js";

const BASE = "https://animenosub.to";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

function b64u(buf) { return Buffer.from(buf).toString("base64url"); }
function b64uDec(s) { return Buffer.from(s, "base64url"); }

const _be = 512, _lt = _be - 1, _dr = 2, _lr = 2654435761, _hr = 2246822519;
const _rot = (t, e) => (t << e | t >>> 32 - e) >>> 0;
const _mul = (t, e) => Math.imul(t, e) >>> 0;
function _mix(t) {
  t[0] = t[0] + t[1] >>> 0; t[3] = _rot(t[3] ^ t[0], 16);
  t[2] = t[2] + t[3] >>> 0; t[1] = _rot(t[1] ^ t[2], 12);
  t[0] = t[0] + t[1] >>> 0; t[3] = _rot(t[3] ^ t[0], 8);
  t[2] = t[2] + t[3] >>> 0; t[1] = _rot(t[1] ^ t[2], 7);
}
function _hash(t) {
  const e = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762]);
  for (let i = 0; i < t.length; i++) { e[0] = e[0] + t[i] >>> 0; e[0] = _rot(e[0], 7); _mix(e); }
  for (let i = 0; i < 8; i++) _mix(e);
  const r = new Uint32Array(_be);
  for (let i = 0; i < _be; i++) { _mix(e); r[i] = (e[0] ^ e[2]) >>> 0; }
  for (let i = 0; i < _dr; i++) {
    for (let s = 0; s < _be; s++) {
      const a = r[s] & _lt;
      let c = r[s] + r[a] >>> 0;
      c = _rot(c, 13);
      c = (c ^ _mul(r[(s + 1) & _lt], _lr)) >>> 0;
      r[s] = c; e[0] = (e[0] ^ c) >>> 0; _mix(e);
    }
  }
  const n = new Uint32Array(8), o = _be / 8;
  for (let i = 0; i < 8; i++) {
    _mix(e); let s = e[0]; const a = i * o;
    for (let c = 0; c < o; c++) { const d = r[a + c]; s = s + d >>> 0; s = _rot(s, 5); s = (s ^ _mul(d, _hr)) >>> 0; }
    n[i] = (s ^ e[2]) >>> 0;
  }
  return n;
}
function _latin1Bytes(t) { const e = new Uint8Array(t.length); for (let r = 0; r < t.length; r++) e[r] = t.charCodeAt(r) & 255; return e; }
function _leadingZeros(t) { let e = 0; for (let r = 0; r < t.length; r++) { const n = t[r]; if (n === 0) { e += 32; continue; } return e + Math.clz32(n); } return e; }
function solvePoW(nonce, difficulty) {
  const prefix = nonce + ":";
  for (let s = 0; ; s++) { if (_leadingZeros(_hash(_latin1Bytes(prefix + s))) >= difficulty) return String(s); }
}

async function resolveByse(embedUrl) {
  const code = embedUrl.match(/\/e\/([a-z0-9]+)/i)?.[1];
  if (!code) throw new Error(`Cannot extract Byse code from ${embedUrl}`);

  const det = await (await fetch(`https://bysesayeveum.com/api/videos/${code}/embed/details`, {
    headers: { "User-Agent": UA, "Referer": embedUrl },
  })).json();

  const frameUrl = det.embed_frame_url;
  const frameBase = new URL(frameUrl).origin;

  const ch = await (await fetch(`${frameBase}/api/videos/access/challenge`, {
    method: "POST",
    headers: { "Content-Length": "0", "Origin": frameBase, "Referer": frameUrl, "User-Agent": UA },
  })).json();

  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const pubJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, new TextEncoder().encode(ch.nonce));

  const att = await (await fetch(`${frameBase}/api/videos/access/attest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": frameBase, "Referer": frameUrl, "User-Agent": UA },
    body: JSON.stringify({ nonce: ch.nonce, challenge_id: ch.challenge_id, public_key: pubJwk, signature: b64u(sig) }),
  })).json();

  const viewerId = att.viewer_id, deviceId = att.device_id, fpToken = att.token, confidence = att.confidence;
  const cookieStr = `byse_viewer_id=${viewerId}; byse_device_id=${deviceId}`;
  const fingerprint = { token: fpToken, viewer_id: viewerId, device_id: deviceId, confidence };

  const cap = await (await fetch(`${frameBase}/api/videos/${code}/embed/captcha`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": frameBase, "Referer": frameUrl, "User-Agent": UA, "Cookie": cookieStr, "X-Embed-Parent": embedUrl },
    body: "{}",
  })).json();

  const solution = solvePoW(cap.pow_nonce, cap.pow_difficulty);

  const ver = await (await fetch(`${frameBase}/api/videos/${code}/embed/captcha/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": frameBase, "Referer": frameUrl, "User-Agent": UA, "Cookie": cookieStr, "X-Embed-Parent": embedUrl },
    body: JSON.stringify({ pow_token: cap.pow_token, solution, fingerprint }),
  })).json();

  const pbData = await (await fetch(`${frameBase}/api/videos/${code}/embed/playback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": frameBase, "Referer": frameUrl, "User-Agent": UA, "Cookie": cookieStr, "X-Captcha-Token": ver.token, "X-Embed-Parent": embedUrl },
    body: JSON.stringify({ fingerprint }),
  })).json();

  const pb = pbData.playback;
  const keyBytes = Buffer.concat(pb.key_parts.filter((k) => b64uDec(k).length === 16).map((k) => b64uDec(k)));
  const aesKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64uDec(pb.iv) }, aesKey, b64uDec(pb.payload));
  const playback = JSON.parse(new TextDecoder().decode(dec));

  return playback.sources.map((s) => s.url);
}

const NOVA_KEY = Buffer.from("6b69656d7469656e6d75613931316361", "hex");
const NOVA_IV = Buffer.from("313233343536373839306f6975797472", "hex");

async function resolveNova(embedUrl) {
  const id = embedUrl.match(/upn\.one\/#([A-Za-z0-9]+)/i)?.[1];
  if (!id) throw new Error(`Cannot extract Nova id from ${embedUrl}`);

  const res = await fetch(`https://nova.upn.one/api/v1/video?id=${id}&w=1920&h=1080&r=`, {
    headers: { "User-Agent": UA, "Referer": "https://nova.upn.one/" },
  });
  if (!res.ok) throw new Error(`Nova fetch HTTP ${res.status}`);
  const hex = (await res.text()).trim();
  const decipher = crypto.createDecipheriv("aes-128-cbc", NOVA_KEY, NOVA_IV);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(hex, "hex")), decipher.final()]);
  const data = JSON.parse(decrypted.toString("utf8"));
  const m3u8 = data.cf ?? data.source;
  if (!m3u8) throw new Error("Nova response missing m3u8 url");
  return [m3u8];
}

async function resolveVidmoly(embedUrl) {
  const url = embedUrl.startsWith("//") ? `https:${embedUrl}` : embedUrl;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Referer": `${BASE}/` },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Vidmoly fetch HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/sources:\s*\[\s*\{\s*file:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/);
  if (!m) throw new Error("Vidmoly m3u8 not found in embed HTML");
  return [m[1]];
}

async function search(query) {
  const res = await fetch(`${BASE}/wp-admin/admin-ajax.php`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      Origin: BASE,
      Referer: `${BASE}/`,
    },
    body: `action=ts_ac_do_search&ts_ac_query=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(`animenosub search HTTP ${res.status}`);
  const data = await res.json();
  const results = [];
  for (const item of data?.anime?.[0]?.all ?? []) {
    const slug = item.post_link?.match(/\/anime\/([^/]+)\/?$/)?.[1];
    if (!slug) continue;
    results.push({ slug, text: item.post_title ?? slug.replace(/-/g, " ") });
  }
  return results;
}

async function scrapeSeries(slug) {
  const html = await fetchHtml(`${BASE}/anime/${slug}/`, { Referer: BASE });
  const isSlugDub = /-dub$/.test(slug) || /(?:^|[-\s])dub(?:$|[-\s])/i.test(slug);
  const episodes = [];
  const seen = new Set();
  const listRe = /<li\b[^>]*data-index="\d+"[^>]*>[\s\S]*?<a\s+href="(https?:\/\/animenosub\.to\/[^"]+)"[\s\S]*?<div\s+class="epl-num">([^<]+)<\/div>/gi;
  for (const m of html.matchAll(listRe)) {
    const epUrl = decodeEntities(m[1]);
    const label = m[2].trim();
    let number;
    if (/^movie$/i.test(label)) {
      number = 1;
    } else {
      const n = parseFloat(label);
      number = Number.isFinite(n) && n >= 1 ? Math.round(n) : null;
    }
    if (number === null || seen.has(number)) continue;
    seen.add(number);
    const isDub = isSlugDub || /-dub(?:$|\/)/.test(epUrl);
    episodes.push({ number, title: /^movie$/i.test(label) ? "Movie" : `Episode ${number}`, epUrl, hasSub: !isDub, hasDub: isDub });
  }
  episodes.sort((a, b) => a.number - b.number);
  return episodes;
}

async function scrapeEmbeds(epUrl) {
  const html = await fetchHtml(epUrl, { Referer: `${BASE}/` });
  const streams = [];
  for (const m of html.matchAll(/<option\s+value="([A-Za-z0-9+/=]+)"\s+data-index="\d+"[^>]*>([^<]+)<\/option>/gi)) {
    const b64 = m[1];
    const serverName = m[2].trim();
    if (!serverName || /select video server/i.test(serverName)) continue;
    let embedUrl = null;
    try {
      const decoded = atob(b64);
      embedUrl = decoded.match(/src=["']([^"']+)["']/i)?.[1] ?? null;
    } catch { continue; }
    if (!embedUrl) continue;
    const embedOrigin = (() => { try { const u = new URL(embedUrl.startsWith("//") ? `https:${embedUrl}` : embedUrl); return `${u.protocol}//${u.host}/`; } catch { return epUrl; } })();
    streams.push({
      url: embedUrl,
      type: "embed",
      server: serverName,
      referer: embedOrigin,
      priority: streams.length === 0 ? 2 : 1,
      isActive: streams.length === 0,
    });
  }
  if (streams.length === 0) {
    for (const m of html.matchAll(/<iframe[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
      const src = m[1];
      if (/vidmoly|vtbe|streamtape|dood|filemoon|upn\.one|bysesa/i.test(src)) {
        const embedOrigin = (() => { try { const u = new URL(src.startsWith("//") ? `https:${src}` : src); return `${u.protocol}//${u.host}/`; } catch { return epUrl; } })();
        streams.push({ url: src, type: "embed", server: "Direct", referer: embedOrigin, priority: 2, isActive: true });
        break;
      }
    }
  }
  return streams;
}

async function resolveSeries(anilistId, ctx = {}) {
  const cacheKey = `np:animenosub:${anilistId}`;
  const cached = get(cacheKey);
  if (isFresh(cached)) return cached.data;

  const media = ctx.media ?? await getMedia(anilistId);
  const titles = buildTitles(media, ctx.anizip);
  const candidates = await findTopSlugs(titles, search);
  const expected = expectedCount(media, ctx.anizip, ctx.jikanEps);
  const offset = await getPrequelOffset(anilistId).catch(() => 0);
  const selected = await selectSeries(candidates, scrapeSeries, expected, media?.status, offset);
  if (!selected) throw new Error(`animenosub match not found for AniList ${anilistId}`);
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
    if (src.hasSub) sub.push({ ...base, id: `watch/animenosub/${anilistId}/sub/animenosub-${number}`, audio: "sub" });
    if (src.hasDub) dub.push({ ...base, id: `watch/animenosub/${anilistId}/dub/animenosub-${number}`, audio: "dub" });
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
      source: "animenosub",
      matchScore: Number(series.score.toFixed(3)),
      numbering: series.mode,
      episodeOffset: series.mode === "offset" ? series.offset : 0,
    },
    episodes: buildEpisodeLists(anilistId, series, episodes, localCtx, expected),
  };
}

async function withRetry(fn, attempts = 2) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (_) { if (i === attempts - 1) return null; }
  }
  return null;
}

function isByse(url) { return /bysesayeveum\.com\/e\//i.test(url); }
function isVidmoly(url) { return /vidmoly\.(net|biz|to)/i.test(url); }
function isNova(url) { return /upn\.one/i.test(url); }

async function handleWatch(anilistId, audio, epNum, ctx = {}) {
  const series = await resolveSeries(anilistId, ctx);
  const providerEp = series.mode === "offset" ? Number(epNum) + series.offset : Number(epNum);
  const episodes = await scrapeSeries(series.slug);
  const ep = episodes.find((e) => e.number === providerEp && (audio === "dub" ? e.hasDub : e.hasSub))
    ?? episodes.find((e) => e.number === providerEp);
  if (!ep) throw new Error(`animenosub episode ${providerEp} not found`);
  const embeds = await scrapeEmbeds(ep.epUrl);

  const resolvable = embeds.filter((s) => isByse(s.url) || isVidmoly(s.url) || isNova(s.url));
  const resolvedList = await Promise.all(resolvable.map((s) => {
    if (isByse(s.url)) return withRetry(() => resolveByse(s.url));
    if (isVidmoly(s.url)) return withRetry(() => resolveVidmoly(s.url));
    if (isNova(s.url)) return withRetry(() => resolveNova(s.url));
  }));
  const resolvedMap = new Map(resolvable.map((s, i) => [s.url, resolvedList[i]]));

  const streams = [];
  for (const stream of embeds) {
    const m3u8Urls = resolvedMap.get(stream.url);
    if (m3u8Urls) {
      const referer = isVidmoly(stream.url)
        ? "https://vidmoly.biz/"
        : isNova(stream.url)
          ? "https://nova.upn.one/"
          : "https://bysesayeveum.com/";
      for (const m3u8 of m3u8Urls) {
        streams.push({
          url: m3u8,
          type: "hls",
          server: stream.server,
          referer,
          priority: stream.priority,
          isActive: stream.isActive,
        });
      }
    }
    streams.push(stream);
  }

  return json({ anilistId: Number(anilistId), episode: Number(epNum), providerEpisode: providerEp, audio, streams });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Access-Control-Allow-Headers": "*" } });
    }
    try {
      const m = url.pathname.match(/^\/watch\/animenosub\/(\d+)\/(sub|dub)\/animenosub-(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message, "Raw-ERROR": err.rawBody ?? null, stack: err.stack }, 500);
    }
  },
};
