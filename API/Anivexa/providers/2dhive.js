import { getMedia } from "../core/anilist.js";
import { episodeMeta, expectedCount, json } from "../core/new-provider-utils.js";

async function getMalId(anilistId, ctx) {
  const idMal = ctx?.media?.idMal ?? (await getMedia(anilistId)).idMal;
  if (!idMal) throw new Error(`2dhive: no MAL ID found for AniList ${anilistId}`);
  return idMal;
}

const BASE = "https://2dhive.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchPage(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`2dhive ${res.status}: ${url}`);
  return res.text();
}

function extractPlayerProps(html) {
  const idx = html.indexOf("prefetchedHls");
  if (idx === -1) return null;
  const propsIdx = html.lastIndexOf('props="', idx);
  if (propsIdx === -1) return null;
  const valueIdx = propsIdx + 7;
  const endIdx = html.indexOf('"', valueIdx);
  if (endIdx === -1) return null;
  const raw = html.slice(valueIdx, endIdx)
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  try { return JSON.parse(raw); } catch { return null; }
}

function astroDecode(v) {
  if (!Array.isArray(v)) return v;
  const [type, data] = v;
  if (type === 0) {
    if (data === null || typeof data !== "object" || Array.isArray(data)) return data;
    return Object.fromEntries(Object.entries(data).map(([k, val]) => [k, astroDecode(val)]));
  }
  if (type === 1) return Array.isArray(data) ? data.map(astroDecode) : data;
  return data;
}

function decodeProps(raw) {
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, astroDecode(v)]));
}

function parseEpisodeNums(html, malId) {
  const re = new RegExp(`/episode\\?anime=${malId}&(?:amp;)?ep_num=(\\d+)`, "gi");
  const nums = new Set();
  for (const m of html.matchAll(re)) nums.add(Number(m[1]));
  return [...nums].sort((a, b) => a - b);
}

async function fetchEpisodePage(malId, epNum) {
  const html = await fetchPage(`${BASE}/episode?anime=${malId}&ep_num=${epNum}`);
  const rawProps = extractPlayerProps(html);
  if (!rawProps) throw new Error(`2dhive: no player props for mal ${malId} ep${epNum}`);
  return decodeProps(rawProps);
}

export async function getEpisodes(anilistId, ctx = {}) {
  const malId = await getMalId(anilistId, ctx);
  const animeHtml = await fetchPage(`${BASE}/anime?anime=${malId}`);
  const epNums = parseEpisodeNums(animeHtml, malId);
  if (!epNums.length) throw new Error(`2dhive: no episodes found for AniList ${anilistId} (MAL ${malId})`);

  const props = await fetchEpisodePage(malId, epNums[0]);
  const hasDub = Boolean(props.prefetchedHls?.dub?.content);
  const expected = expectedCount(ctx.media, ctx.anizip, ctx.jikanEps);

  const sub = [], dub = [];
  for (const num of epNums) {
    if (expected && num > expected) continue;
    const meta = episodeMeta(num, ctx);
    const base = {
      number: num,
      title: meta.title ?? `Episode ${num}`,
      duration: meta.duration ?? null,
      filler: meta.filler ?? false,
      uncensored: meta.uncensored ?? false,
      description: meta.description ?? null,
      image: meta.image ?? null,
      airDate: meta.airDate ?? null,
    };
    sub.push({ id: `watch/2dhive/${anilistId}/sub/2dhive-${num}`, ...base, audio: "sub" });
    if (hasDub) dub.push({ id: `watch/2dhive/${anilistId}/dub/2dhive-${num}`, ...base, audio: "dub" });
  }

  return {
    meta: {
      id: String(anilistId),
      source: "2dhive",
      matchScore: 1,
      numbering: "standard",
      episodeOffset: 0,
    },
    episodes: { sub, dub },
  };
}

async function handleWatch(anilistId, audio, epNum) {
  const malId = await getMalId(anilistId);
  const referer = `${BASE}/episode?anime=${malId}&ep_num=${epNum}`;
  const fileKey = `${malId}_${epNum}_${audio}`;

  const [propsResult, hiAnimeResult, dlContent] = await Promise.allSettled([
    fetchEpisodePage(malId, epNum),
    audio !== "dub"
      ? fetch(`${BASE}/api/hianime?mal_id=${malId}&ep_num=${epNum}`, {
          headers: { "User-Agent": UA, "Referer": referer },
        }).then(r => r.ok ? r.json() : null).catch(() => null)
      : Promise.resolve(null),
    fetchDownloadHls(malId, audio, epNum),
  ]);

  const streams = [];
  const props = propsResult.status === "fulfilled" ? propsResult.value : null;

  if (props) {
    const hlsContent = audio === "dub"
      ? props.prefetchedHls?.dub?.content
      : props.prefetchedHls?.sub?.content;

    if (hlsContent) {
      streams.push({
        server: audio === "dub" ? "HLS DUB" : "HLS SUB",
        url: `/stream/2dhive/${anilistId}/${audio}/${epNum}`,
      });
    }

    const rawServers = Array.isArray(props.servers) ? props.servers : [];
    const hadfreeEntries = rawServers.filter(s =>
      s.server_name === "HAdfree" && Boolean(s.dub) === (audio === "dub") && s.slug
    );

    const hadfreeResults = await Promise.allSettled(
      hadfreeEntries.map(entry =>
        fetch(`${BASE}/api/hadfree?slug=${encodeURIComponent(entry.slug)}`, {
          headers: { "User-Agent": UA, "Referer": referer },
        }).then(r => r.ok ? r.json() : null).catch(() => null)
      )
    );

    for (const r of hadfreeResults) {
      if (r.status === "fulfilled" && r.value?.streamUrl) {
        streams.push({ server: "HAdfree", url: r.value.streamUrl });
      }
    }
  }

  streams.push({
    server: audio === "dub" ? "MegaPlay Dub" : "MegaPlay Sub",
    url: `https://megaplay.buzz/stream/mal/${malId}/${epNum}/${audio === "dub" ? "dub" : "sub"}`,
    type: "embed",
  });

  const hiAnime = hiAnimeResult.status === "fulfilled" ? hiAnimeResult.value : null;
  if (hiAnime?.m3u8) {
    const entry = { server: "hiAnime", url: hiAnime.m3u8 };
    if (hiAnime.subtitle) entry.subtitle = hiAnime.subtitle;
    streams.push(entry);
  }

  if (dlContent.status === "fulfilled" && dlContent.value) {
    streams.push({
      server: "Download",
      url: `/stream/2dhive/download/${anilistId}/${audio}/${epNum}`,
    });
  }

  return json({ anilistId: Number(anilistId), episode: Number(epNum), audio, streams });
}

async function fetchDownloadHls(malId, audio, epNum) {
  const fileKey = `${malId}_${epNum}_${audio}`;
  try {
    const res = await fetch(`${BASE}/download?file=${encodeURIComponent(fileKey)}`, {
      headers: {
        "User-Agent": UA,
        "Referer": `${BASE}/episode?anime=${malId}&ep_num=${epNum}`,
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/downloadPayload\s*=\s*(\{.*?\});/s);
    if (!m) return null;
    const payload = JSON.parse(m[1]);
    return payload.hlsContent || null;
  } catch {
    return null;
  }
}

async function handleDownloadStream(anilistId, audio, epNum) {
  const malId = await getMalId(anilistId);
  const content = await fetchDownloadHls(malId, audio, epNum);
  if (!content) {
    return new Response(JSON.stringify({ error: "No download stream found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
  return new Response(content, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

async function handleStream(anilistId, audio, epNum) {
  const malId = await getMalId(anilistId);
  const props = await fetchEpisodePage(malId, epNum);
  const content = audio === "dub"
    ? props.prefetchedHls?.dub?.content
    : props.prefetchedHls?.sub?.content;

  if (!content) {
    return new Response(JSON.stringify({ error: "No HLS stream found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  return new Response(content, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      let m = path.match(/^\/watch\/2dhive\/(\d+)\/(sub|dub)\/2dhive-(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);

      m = path.match(/^\/stream\/2dhive\/(\d+)\/(sub|dub)\/(\d+)\/?$/);
      if (m) return await handleStream(m[1], m[2], m[3]);

      m = path.match(/^\/stream\/2dhive\/download\/(\d+)\/(sub|dub)\/(\d+)\/?$/);
      if (m) return await handleDownloadStream(m[1], m[2], m[3]);

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message, stack: err.stack }, 500);
    }
  },
};
