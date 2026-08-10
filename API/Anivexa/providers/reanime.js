const __name = (fn, _) => fn;
import { getMedia } from '../core/anilist.js';
import { buildTitles } from '../core/new-provider-utils.js';
import { get as cacheGet, set as cacheSet, isFresh as cacheIsFresh, SHOW_IDENTITY_TTL } from '../core/smartcache.js';

var BASE = "https://reanime.to";
var FLIX = "https://flixcloud.cc";
var ANIZIP2 = "https://api.ani.zip/mappings";
var UA5 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
var H = { "User-Agent": UA5, Accept: "application/json, */*" };
var enc = new TextEncoder();
var dec = new TextDecoder();
async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", typeof s === "string" ? enc.encode(s) : s);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256hex, "sha256hex");
function b64toU8(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
__name(b64toU8, "b64toU8");
async function deriveFields(seed) {
  let e = seed;
  for (let i = 0; i < 3; i++) e = await sha256hex(e + i);
  let l = e;
  for (let i = 0; i < 3; i++) l = await sha256hex(l + i);
  return {
    keyField: "kf_" + e.substring(8, 16),
    ivField: "ivf_" + e.substring(16, 24),
    containerName: "cd_" + e.substring(24, 32),
    arrayName: "ad_" + e.substring(32, 40),
    objectName: "od_" + e.substring(40, 48),
    tokenField: e.substring(48, 64) + "_" + e.substring(56, 64),
    keyFrag2Field: l.substring(0, 16) + "_" + l.substring(16, 24)
  };
}
__name(deriveFields, "deriveFields");
function extractSsrObj(html) {
  const m = html.match(/\{type:"data",data:(\{)/);
  if (!m) throw new Error("SSR data block not found");
  let depth = 0;
  const start = html.indexOf("{", m.index + m[0].length - 1);
  for (let i = start; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") {
      if (--depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error("SSR brace matching failed");
}
__name(extractSsrObj, "extractSsrObj");
function parseJsLiteral(src) {
  let i = 0;
  function ws() {
    while (i < src.length && /\s/.test(src[i])) i++;
  }
  __name(ws, "ws");
  function parseValue() {
    ws();
    if (src[i] === "{") return parseObject();
    if (src[i] === "[") return parseArray();
    if (src[i] === '"') return parseDStr();
    if (src[i] === "'") return parseSStr();
    if (src.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (src.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (src.startsWith("null", i)) {
      i += 4;
      return null;
    }
    if (src.startsWith("undefined", i)) {
      i += 9;
      return null;
    }
    if (src.startsWith("!0", i)) {
      i += 2;
      return true;
    }
    if (src.startsWith("!1", i)) {
      i += 2;
      return false;
    }
    const m = src.slice(i).match(/^-?[\d.]+([eE][+-]?\d+)?/);
    if (m) {
      i += m[0].length;
      return parseFloat(m[0]);
    }
    throw new Error(`JS parse error at pos ${i}: ...${src.slice(i, i + 20)}`);
  }
  __name(parseValue, "parseValue");
  function parseDStr() {
    let r = "";
    i++;
    while (i < src.length && src[i] !== '"') {
      if (src[i] === "\\") {
        i++;
        const e = { n: "\n", t: "       ", r: "\r", '"': '"', "\\": "\\" };
        r += e[src[i]] ?? src[i];
        i++;
      } else r += src[i++];
    }
    i++;
    return r;
  }
  __name(parseDStr, "parseDStr");
  function parseSStr() {
    let r = "";
    i++;
    while (i < src.length && src[i] !== "'") {
      if (src[i] === "\\") {
        i++;
        r += src[i] === "'" ? "'" : { n: "\n", t: "     ", r: "\r", "\\": "\\" }[src[i]] ?? src[i];
        i++;
      } else r += src[i++];
    }
    i++;
    return r;
  }
  __name(parseSStr, "parseSStr");
  function parseKey() {
    ws();
    if (src[i] === '"') return parseDStr();
    if (src[i] === "'") return parseSStr();
    const m = src.slice(i).match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/);
    if (m) {
      i += m[0].length;
      return m[0];
    }
    throw new Error(`Bad key at pos ${i}: ${src.slice(i, i + 20)}`);
  }
  __name(parseKey, "parseKey");
  function parseObject() {
    const obj = {};
    i++;
    ws();
    while (i < src.length && src[i] !== "}") {
      if (src[i] === ",") {
        i++;
        ws();
        continue;
      }
      const k = parseKey();
      ws();
      i++;
      obj[k] = parseValue();
      ws();
    }
    i++;
    return obj;
  }
  __name(parseObject, "parseObject");
  function parseArray() {
    const arr = [];
    i++;
    ws();
    while (i < src.length && src[i] !== "]") {
      if (src[i] === ",") {
        i++;
        ws();
        continue;
      }
      arr.push(parseValue());
      ws();
    }
    i++;
    return arr;
  }
  __name(parseArray, "parseArray");
  return parseValue();
}
__name(parseJsLiteral, "parseJsLiteral");
function parseWasmDecrypt(wasmBytes) {
  const b = wasmBytes;
  let pos = 8;
  while (pos < b.length) {
    const secId = b[pos++];
    let sz = 0, sh = 0, by;
    do {
      by = b[pos++];
      sz |= (by & 127) << sh;
      sh += 7;
    } while (by & 128);
    if (secId === 10) {
      pos++;
      let sbs = 0, sh2 = 0, by2;
      do {
        by2 = b[pos++];
        sbs |= (by2 & 127) << sh2;
        sh2 += 7;
      } while (by2 & 128);
      pos += sbs;
      break;
    }
    pos += sz;
  }
  let rbs = 0, sh3 = 0, by3;
  do {
    by3 = b[pos++];
    rbs |= (by3 & 127) << sh3;
    sh3 += 7;
  } while (by3 & 128);
  const r = b.slice(pos, pos + rbs);
  function leb(arr, i) {
    let v = 0, s = 0, b2;
    do {
      b2 = arr[i++];
      v |= (b2 & 127) << s;
      s += 7;
    } while (b2 & 128);
    return [v, i];
  }
  __name(leb, "leb");
  const XOR_END = [32, 2, 32, 5, 106, 45, 0, 0, 115, 33, 6];
  let txStart = -1;
  outer: for (let i = 0; i < r.length - XOR_END.length; i++) {
    for (let j = 0; j < XOR_END.length; j++) if (r[i + j] !== XOR_END[j]) continue outer;
    txStart = i + XOR_END.length;
    break;
  }
  if (txStart < 0) throw new Error("WASM: transform start not found");
  let txEnd = -1, step = 36;
  for (let i = txStart; i < r.length - 4; i++) {
    if (r[i] === 32 && r[i + 1] === 5 && r[i + 2] === 65) {
      const [val, ni] = leb(r, i + 3);
      if (r[ni] === 108) {
        txEnd = i;
        step = val;
        break;
      }
    }
  }
  if (txEnd < 0) throw new Error("WASM: keystream not found");
  const code = r.slice(txStart, txEnd);
  function transform(inputByte) {
    let local6 = inputByte & 255;
    const stk = [];
    let i = 0;
    while (i < code.length) {
      const op = code[i++];
      if (op === 32) {
        const [idx, ni] = leb(code, i);
        i = ni;
        stk.push(idx === 6 ? local6 : 0);
      } else if (op === 33) {
        const [idx, ni] = leb(code, i);
        i = ni;
        const v = stk.pop();
        if (idx === 6) local6 = v & 255;
      } else if (op === 65) {
        const [v, ni] = leb(code, i);
        i = ni;
        stk.push(v);
      } else if (op === 106) {
        const b2 = stk.pop(), a = stk.pop();
        stk.push(a + b2 & 255);
      } else if (op === 107) {
        const b2 = stk.pop(), a = stk.pop();
        stk.push(a - b2 + 256 & 255);
      } else if (op === 113) {
        const b2 = stk.pop(), a = stk.pop();
        stk.push(a & b2 & 255);
      } else if (op === 114) {
        const b2 = stk.pop(), a = stk.pop();
        stk.push((a | b2) & 255);
      } else if (op === 115) {
        const b2 = stk.pop(), a = stk.pop();
        stk.push((a ^ b2) & 255);
      } else if (op === 116) {
        const b2 = stk.pop(), a = stk.pop();
        stk.push(a << (b2 & 7) & 255);
      } else if (op === 118) {
        const b2 = stk.pop(), a = stk.pop();
        stk.push(a >>> (b2 & 7) & 255);
      }
    }
    return local6;
  }
  __name(transform, "transform");
  return { step, transform };
}
__name(parseWasmDecrypt, "parseWasmDecrypt");
function runDecrypt(wasmBytes, frag1, kf2, T, seedInt) {
  const { step, transform } = parseWasmDecrypt(wasmBytes);
  const out = new Uint8Array(frag1.length);
  for (let i = 0; i < frag1.length; i++) {
    const c = (frag1[i] ^ kf2[i] ^ T[i]) & 255;
    out[i] = transform(c) ^ i * step + seedInt & 255;
  }
  return out;
}
__name(runDecrypt, "runDecrypt");
async function decryptEmbed(html) {
  const raw = extractSsrObj(html);
  const data = parseJsLiteral(raw);
  const seed = data.obfuscation_seed;
  if (!seed) {
    const e = new Error("obfuscation_seed missing");
    e.debug = { topKeys: Object.keys(data).slice(0, 20) };
    throw e;
  }
  const fields = await deriveFields(seed);
  const ocd = data.obfuscated_crypto_data;
  if (!ocd) {
    const e = new Error("obfuscated_crypto_data missing");
    e.debug = { fields, topKeys: Object.keys(data).slice(0, 20) };
    throw e;
  }
  const container = ocd[fields.containerName];
  if (!container) {
    const e = new Error(`containerName "${fields.containerName}" not in ocd`);
    e.debug = { fields, ocdKeys: Object.keys(ocd).slice(0, 10) };
    throw e;
  }
  const arr = container[fields.arrayName];
  if (!arr) {
    const e = new Error(`arrayName "${fields.arrayName}" not in container`);
    e.debug = { fields, containerKeys: Object.keys(container).slice(0, 10) };
    throw e;
  }
  const obj = arr[0][fields.objectName];
  if (!obj) {
    const e = new Error(`objectName "${fields.objectName}" not in arr[0]`);
    e.debug = { fields, arr0Keys: Object.keys(arr[0]).slice(0, 10) };
    throw e;
  }
  const frag1 = b64toU8(obj[fields.keyField]);
  const iv = b64toU8(obj[fields.ivField]);
  const kf2raw = data[fields.keyFrag2Field];
  if (!kf2raw) {
    const e = new Error(`kf2 field "${fields.keyFrag2Field}" not in data`);
    e.debug = { fields, topKeys: Object.keys(data).slice(0, 20) };
    throw e;
  }
  const kf2 = b64toU8(kf2raw);
  const token = data[fields.tokenField];
  if (!token) {
    const e = new Error(`tokenField "${fields.tokenField}" missing`);
    e.debug = { fields, topKeys: Object.keys(data).slice(0, 20) };
    throw e;
  }
  const tokData = await fetch(`${FLIX}/api/m3u8/${token}`, { headers: { ...H, Referer: `${BASE}/` } }).then(async (r) => {
    if (!r.ok) { const _raw = await r.text().catch(() => null); const _e = new Error(`Token API ${r.status}`); _e.rawBody = _raw; throw _e; }
    return r.json();
  });
  const vidKey = (await sha256hex(token + "vid")).substring(0, 10);
  const keyKey = (await sha256hex(token + "key")).substring(0, 10);
  const v_bytes = b64toU8(tokData[vidKey]);
  const T_bytes = b64toU8(tokData[keyKey]);
  if (!v_bytes.length || !T_bytes.length) {
    const e = new Error(`Token fields missing. vidKey="${vidKey}" keyKey="${keyKey}"`);
    e.debug = { tokKeys: Object.keys(tokData).slice(0, 10) };
    throw e;
  }
  const seedInt = parseInt(seed.substring(0, 8), 16);
  const wPayload = b64toU8(data.w_payload ?? "");
  if (!wPayload.length) throw new Error("w_payload missing from embed data");
  let wasmOut;
  try {
    wasmOut = runDecrypt(wPayload, frag1, kf2, T_bytes, seedInt);
  } catch (pe) {
    pe.wasmHex = Array.from(wPayload).map((b) => b.toString(16).padStart(2, "0")).join("");
    throw pe;
  }
  const keyMat = await crypto.subtle.importKey("raw", wasmOut, { name: "PBKDF2" }, false, ["deriveBits"]);
  const derived = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(seed), iterations: 1e3, hash: "SHA-256" },
    keyMat,
    256
  ));
  for (let i = 0; i < 32; i++) derived[i] ^= seed.charCodeAt(i % seed.length);
  const aesKeyBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", derived));
  const aesKey = await crypto.subtle.importKey("raw", aesKeyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, aesKey, v_bytes);
  } catch (err) {
    err.debug = {
      seedInt: "0x" + seedInt.toString(16),
      frag1Len: frag1.length,
      kf2Len: kf2.length,
      T_bytesLen: T_bytes.length,
      ivLen: iv.length,
      v_bytesLen: v_bytes.length,
      wPayloadLen: wPayload.length,
      wasmOutHex: Array.from(wasmOut).map((b) => b.toString(16).padStart(2, "0")).join("")
    };
    throw err;
  }
  const url = dec.decode(plain).trim().replace(/\0+$/, "");
  if (!url.startsWith("http")) throw new Error(`Unexpected decrypted value: ${url.substring(0, 60)}`);
  return {
    url,
    subtitles: data.subtitles ?? [],
    thumbnails_vtt: data.thumbnails_vtt ?? null,
    video_title: data.video_title ?? null,
    intro_chapter: data.intro_chapter ?? null,
    outro_chapter: data.outro_chapter ?? null,
    video_id: data.video_id ?? null
  };
}
__name(decryptEmbed, "decryptEmbed");
async function searchReanime(query) {
  const data = await fetch(`${BASE}/api/v1/search?${new URLSearchParams({ q: query, limit: 10 })}`, { headers: H }).then(async (r) => {
    const _raw = await r.text();
    if (!r.ok) { const _e = new Error(`reanime search ${r.status}`); _e.rawBody = _raw; throw _e; }
    try { return JSON.parse(_raw); } catch (_pe) { _pe.rawBody = _raw; throw _pe; }
  });
  return Array.isArray(data?.results) ? data.results : [];
}
__name(searchReanime, "searchReanime");
async function fetchAnimeDetail(animeId) {
  const res = await fetch(`${BASE}/api/v1/anime/${animeId}`, { headers: H });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}
__name(fetchAnimeDetail, "fetchAnimeDetail");
// Extract AniList ID embedded in AniList CDN cover image URLs.
// e.g. https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx16498-xxxx.jpg → 16498
function extractAnilistIdFromCover(coverImage) {
  const urls = [coverImage?.extra_large, coverImage?.large, coverImage?.medium].filter(Boolean);
  for (const url of urls) {
    const m = url.match(/anilist\.co\/.*\/bx(\d+)-/);
    if (m) return Number(m[1]);
  }
  return null;
}
__name(extractAnilistIdFromCover, "extractAnilistIdFromCover");
async function resolveSeries(anilistId, ctx = {}) {
  const cacheKey = `np:reanime:${anilistId}`;
  const cached = cacheGet(cacheKey);
  if (cacheIsFresh(cached)) return cached.data;

  const media = ctx.media ?? await getMedia(anilistId);
  const malId = media?.idMal ?? null;
  const queries = buildTitles(media, ctx.anizip).slice(0, 5);

  const candidates = new Map();
  await Promise.all(queries.map(async (q) => {
    for (const r of await searchReanime(q).catch(() => [])) {
      if (r?.anime_id && !candidates.has(r.anime_id)) candidates.set(r.anime_id, r);
    }
  }));

  // Fast pass: AniList CDN cover URLs embed the AniList ID as bx{id}-*.
  // If a candidate's cover image already confirms our ID we can skip detail fetches entirely.
  for (const [id, r] of candidates) {
    const coverId = extractAnilistIdFromCover(r.cover_image);
    if (coverId && coverId === Number(anilistId)) {
      const data = {
        animeId: id,
        title: r.title?.english || r.title?.romaji || id,
        anilistId: Number(anilistId),
        malId: null,
        subbed: Number.isFinite(r.subbed) ? r.subbed : null,
        dubbed: Number.isFinite(r.dubbed) ? r.dubbed : null,
        episodesCount: Number.isFinite(r.episodes) ? r.episodes : null,
        matchType: "cover_image",
        matchScore: 1,
      };
      cacheSet(cacheKey, data, SHOW_IDENTITY_TTL);
      return data;
    }
  }

  // Fallback: fetch detail pages only for candidates that had no AniList CDN cover
  // (TMDB / MAL covers don't embed an ID we can read directly).
  const needsDetail = [...candidates.keys()].filter(
    (id) => extractAnilistIdFromCover(candidates.get(id)?.cover_image) === null
  );
  const details = await Promise.all(
    needsDetail.map(async (id) => ({ id, detail: await fetchAnimeDetail(id).catch(() => null) }))
  );

  for (const { id, detail } of details) {
    if (detail?.anilist_id && Number(detail.anilist_id) === Number(anilistId)) {
      const data = {
        animeId: id,
        title: detail.title?.english || detail.title?.romaji || candidates.get(id)?.title?.english || id,
        anilistId: Number(anilistId),
        malId: detail.mal_id || null,
        subbed: Number.isFinite(detail.subbed) ? detail.subbed : null,
        dubbed: Number.isFinite(detail.dubbed) ? detail.dubbed : null,
        episodesCount: Number.isFinite(detail.episodes) ? detail.episodes : null,
        matchType: "anilist",
        matchScore: 1,
      };
      cacheSet(cacheKey, data, SHOW_IDENTITY_TTL);
      return data;
    }
  }

  if (malId) {
    for (const { id, detail } of details) {
      const detailMal = detail?.mal_id;
      if (detailMal && Number(detailMal) === Number(malId)) {
        const data = {
          animeId: id,
          title: detail.title?.english || detail.title?.romaji || id,
          anilistId: Number(anilistId),
          malId: Number(detailMal),
          subbed: Number.isFinite(detail.subbed) ? detail.subbed : null,
          dubbed: Number.isFinite(detail.dubbed) ? detail.dubbed : null,
          episodesCount: Number.isFinite(detail.episodes) ? detail.episodes : null,
          matchType: "mal",
          matchScore: 0.9,
        };
        cacheSet(cacheKey, data, SHOW_IDENTITY_TTL);
        return data;
      }
    }
  }

  throw new Error(`No confirmed reanime match for AniList ${anilistId}`);
}
__name(resolveSeries, "resolveSeries");
async function fetchEpisodesList(animeId, limit = 2000) {
  const data = await fetch(`${BASE}/api/v1/anime/${animeId}/episodes?${new URLSearchParams({ limit })}`, { headers: H }).then(async (r) => {
    const _raw = await r.text();
    if (!r.ok) { const _e = new Error(`reanime episodes ${r.status}`); _e.rawBody = _raw; throw _e; }
    try { return JSON.parse(_raw); } catch (_pe) { _pe.rawBody = _raw; throw _pe; }
  });
  return Array.isArray(data?.data) ? data.data : [];
}
__name(fetchEpisodesList, "fetchEpisodesList");
async function fetchAnizip(anilistId) {
  return fetch(`${ANIZIP2}?anilist_id=${anilistId}`).then((r) => r.json()).catch(() => null);
}
__name(fetchAnizip, "fetchAnizip");
function mergeEpisode(anilistId, ep, meta, audio) {
  const number = ep.episode_number;
  return {
    id: `watch/reanime/${anilistId}/${audio}/reanime-${number}`,
    number,
    title: meta?.title?.en || meta?.title?.["x-jat"] || ep.title || `Episode ${number}`,
    titleJapanese: meta?.title?.ja || ep.title_japanese || null,
    titleRomanji: meta?.title?.["x-jat"] || ep.title_romanji || null,
    image: meta?.image || ep.thumbnail || null,
    airDate: meta?.airdate || ep.aired || null,
    duration: meta?.runtime ? meta.runtime * 60 : (ep.duration ? ep.duration * 60 : null),
    score: null,
    filler: ep.is_filler ?? meta?.filler ?? false,
    recap: ep.is_recap ?? false,
    description: meta?.overview || ep.description || null,
    audio
  };
}
__name(mergeEpisode, "mergeEpisode");
function json3(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
}
__name(json3, "json");
async function handleEpisodes3(anilistId, url) {
  const series = await resolveSeries(anilistId);
  const [reanimeEps, anizip] = await Promise.all([
    fetchEpisodesList(series.animeId),
    fetchAnizip(anilistId)
  ]);
  if (!reanimeEps.length) return json3({ error: `No reanime episodes found for AniList ID ${anilistId} (slug ${series.animeId})` }, 404);
  const episodes = reanimeEps.map((ep) => {
    const meta = anizip?.episodes?.[String(ep.episode_number)] ?? null;
    return mergeEpisode(anilistId, ep, meta, "sub");
  }).sort((a, b) => a.number - b.number);
  return json3({
    anime: series.title,
    anilistId: Number(anilistId),
    malId: series.malId,
    animeId: series.animeId,
    episodes,
    pagination: { currentPage: 1, lastPage: 1, hasNextPage: false }
  });
}
__name(handleEpisodes3, "handleEpisodes");
async function resolveStream3(anilistId, audio, ep) {
  const series = await resolveSeries(anilistId);
  const title2 = series.title;
  const slug = series.animeId;
  const order = { "HD-2": 0, "HD-1": 1 };
  const byPrio = (arr) => arr.slice().sort((a, b) => (order[a.serverName] ?? 9) - (order[b.serverName] ?? 9));
  const [watchRes, flixRes] = await Promise.allSettled([
    fetch(`${BASE}/api/watch/${slug}/${ep}`, { headers: H }).then(async (r) => {
      const _raw = await r.text();
      if (!r.ok) { const _e = new Error(`watch ${r.status}`); _e.rawBody = _raw; throw _e; }
      try { return JSON.parse(_raw); } catch (_pe) { _pe.rawBody = _raw; throw _pe; }
    }),
    fetch(`${BASE}/api/flix/${anilistId}/${ep}`, { headers: H }).then(async (r) => {
      const _raw = await r.text();
      if (!r.ok) { const _e = new Error(`flix ${r.status}`); _e.rawBody = _raw; throw _e; }
      try { return JSON.parse(_raw); } catch (_pe) { _pe.rawBody = _raw; throw _pe; }
    })
  ]);
  const watchData = watchRes.status === "fulfilled" ? watchRes.value : null;
  const flixData = flixRes.status === "fulfilled" ? flixRes.value : null;
  const links = [...watchData?.episode_links ?? []];
  if (flixData?.success && flixData?.servers) {
    const seen = new Set(links.map((s) => s["$id"]));
    for (const s of flixData.servers) {
      if (!seen.has(s["$id"])) links.push(s);
    }
  }
  const audioTypes = audio === "sub" ? ["sub", "s-sub"] : ["dub", "s-dub"];
  const servers = byPrio(links.filter((s) => audioTypes.includes(s.dataType)));
  if (!servers.length) throw Object.assign(new Error(`No ${audio} servers for "${title2}" ep ${ep}`), { status: 404 });
  const embedRes = await fetch(servers[0].dataLink, { headers: { ...H, Referer: `${BASE}/` } });
  if (!embedRes.ok) throw Object.assign(new Error(`Embed fetch failed: ${embedRes.status}`), { status: 502 });
  const stream = await decryptEmbed(await embedRes.text());
  return { title: title2, slug, watchData, stream, server: servers[0].serverName, servers };
}
__name(resolveStream3, "resolveStream");
async function handleWatch3(anilistId, audio, epNum, origin) {
  if (audio !== "sub" && audio !== "dub") return json3({ error: "audio must be sub or dub" }, 400);
  const ep = parseInt(epNum);
  if (isNaN(ep)) return json3({ error: `Invalid episode: ${epNum}` }, 400);
  let resolved;
  try {
    resolved = await resolveStream3(anilistId, audio, ep);
  } catch (e) {
    return json3({ error: e.message, "Raw-ERROR": e.rawBody ?? null, stack: e.stack }, e.status ?? 500);
  }
  const { title: title2, slug, watchData, stream, server, servers } = resolved;
  const redirectUrl = `${origin}/stream/reanime/${anilistId}/${audio}/${ep}`;
  return json3({
    anime: title2,
    slug,
    ep,
    audio,
    server,
    stream_url: stream.url,
    redirect_url: redirectUrl,
    streams: [
      { url: stream.url, type: "hls" },
      { url: redirectUrl, type: "hls-redirect" },
      ...servers.map((s) => ({ url: s.dataLink, type: "embed", server: s.serverName }))
    ],
    subtitles: stream.subtitles,
    thumbnails_vtt: stream.thumbnails_vtt,
    video_title: stream.video_title,
    intro: stream.intro_chapter,
    outro: stream.outro_chapter,
    intro_start: watchData?.intro_start ?? null,
    intro_end: watchData?.intro_end ?? null,
    outro_start: watchData?.outro_start ?? null,
    outro_end: watchData?.outro_end ?? null,
    allServers: servers.map((s) => ({ name: s.serverName, type: s.dataType, embed: s.dataLink }))
  });
}
__name(handleWatch3, "handleWatch");
async function handleStream3(anilistId, audio, epNum) {
  if (audio !== "sub" && audio !== "dub") return json3({ error: "audio must be sub or dub" }, 400);
  const ep = parseInt(epNum);
  if (isNaN(ep)) return json3({ error: `Invalid episode: ${epNum}` }, 400);
  let resolved;
  try {
    resolved = await resolveStream3(anilistId, audio, ep);
  } catch (e) {
    return json3({ error: e.message, "Raw-ERROR": e.rawBody ?? null, stack: e.stack }, e.status ?? 500);
  }
  return new Response(null, {
    status: 302,
    headers: {
      "Location": resolved.stream.url,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store"
    }
  });
}
__name(handleStream3, "handleStream");
async function handleProxy3(url) {
  const target = url.searchParams.get("url");
  const referer = url.searchParams.get("referer") ?? `${FLIX}/`;
  if (!target) return json3({ error: "Missing required ?url= param" }, 400);
  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return json3({ error: "Invalid url param" }, 400);
  }
  const upstream = await fetch(target, {
    headers: {
      "User-Agent": UA5,
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": referer,
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "cross-site"
    }
  });
  const ct = upstream.headers.get("Content-Type") ?? "";
  const isM3U8 = ct.includes("mpegurl") || ct.includes("x-mpegurl") || targetUrl.pathname.endsWith(".m3u8") || targetUrl.pathname.endsWith(".m3u");
  const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
  if (!upstream.ok) {
    return new Response(await upstream.text(), { status: upstream.status, headers: { "Content-Type": ct || "text/plain", ...corsHeaders } });
  }
  if (isM3U8) {
    const text = await upstream.text();
    const rewritten = rewriteM3U8(text, target, url.origin);
    return new Response(rewritten, { status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl", ...corsHeaders } });
  }
  return new Response(upstream.body, { status: upstream.status, headers: { "Content-Type": ct || "application/octet-stream", ...corsHeaders } });
}
__name(handleProxy3, "handleProxy");
var reanime_default = {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Access-Control-Allow-Headers": "*" } });
    }
    try {
      let m;
      if (path === "/healthz") return json3({ status: "ok", provider: "reanime" });
      if (path === "/proxy") return await handleProxy3(url);
      m = path.match(/^\/episodes\/(\d+)$/);
      if (m) return await handleEpisodes3(m[1], url);
      m = path.match(/^\/watch\/(\d+)\/(sub|dub)\/(\d+)$/);
      if (m) return await handleWatch3(m[1], m[2], m[3], url.origin);
      m = path.match(/^\/stream\/(\d+)\/(sub|dub)\/(\d+)$/);
      if (m) return await handleStream3(m[1], m[2], m[3]);
      return json3({ error: "Not found", routes: ["GET /episodes/:anilistId", "GET /watch/:anilistId/sub|dub/:ep", "GET /stream/:anilistId/sub|dub/:ep", "GET /proxy?url=&referer="] }, 404);
    } catch (err) {
      return json3({ error: err.message, "Raw-ERROR": err.rawBody ?? null, ...err.debug ? { debug: err.debug } : {}, stack: err.stack }, 500);
    }
  }
};
async function getEpisodes3(anilistId, ctx = {}) {
  const series = await resolveSeries(anilistId, ctx);
  const anizip = ctx.anizip !== void 0 ? ctx.anizip : await fetchAnizip(anilistId);
  const reanimeEps = await fetchEpisodesList(series.animeId);
  if (!reanimeEps.length) throw new Error(`No reanime episodes found for AniList ${anilistId} (slug ${series.animeId})`);

  const hasSub = series.subbed == null || series.subbed > 0;
  const dubCount = series.dubbed ?? 0;
  const sub = [], dub = [];
  for (const ep of reanimeEps) {
    const meta = anizip?.episodes?.[String(ep.episode_number)] ?? null;
    if (hasSub) sub.push(mergeEpisode(anilistId, ep, meta, "sub"));
    if (dubCount > 0 && ep.episode_number <= dubCount) dub.push(mergeEpisode(anilistId, ep, meta, "dub"));
  }
  sub.sort((a, b) => a.number - b.number);
  dub.sort((a, b) => a.number - b.number);
  return {
    meta: { title: series.title, malId: series.malId, animeId: series.animeId },
    episodes: { sub, dub }
  };
}
__name(getEpisodes3, "getEpisodes");
export default reanime_default;
export { getEpisodes3 as getEpisodes };