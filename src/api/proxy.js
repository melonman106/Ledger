export async function handleApiProxy(request, anivexaApi) {
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

export async function handleMangaDexProxy(request) {
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
