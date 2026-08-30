import { handleProgress } from './src/api/progress.js';
import { handleApiProxy, handleMangaDexProxy } from './src/api/proxy.js';
import { indexPage } from './src/pages/index.js';
import { detailPage } from './src/pages/detail.js';
import { watchPage } from './src/pages/watch.js';
import { readPage } from './src/pages/read.js';
import { notFoundPage } from './src/pages/notfound.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const pk = env.CLERK_PUBLISHABLE_KEY || '';
    const cu = env.CLERK_FRONTEND_API_URL || '';
    const anivexaApi = env.ANIVEXA_API_URL || 'https://anivexa-api-gubc.onrender.com';
    const streamProxy = env.STREAM_PROXY_URL || 'https://stream-proxy.muldera.workers.dev/?url=';
    const parts = path.split('/').filter(Boolean);
    let anilistId = null;
    if (parts.length >= 2 && ['detail', 'watch', 'read'].includes(parts[0])) { anilistId = parts[1]; }
    if (parts[0] === 'api' && parts[1] === 'progress') { return handleProgress(request, env, parts); }
    if (parts[0] === 'api') { return handleApiProxy(request, anivexaApi); }
    if (parts[0] === 'md') { return handleMangaDexProxy(request); }
    let html;
    if (path === '/' || path === '/index.html') { html = indexPage(pk, cu); }
    else if (parts[0] === 'detail' && anilistId && /^\d+$/.test(anilistId)) { html = detailPage(pk, cu, anilistId); }
    else if (parts[0] === 'watch' && anilistId && /^\d+$/.test(anilistId)) { html = watchPage(pk, cu, anilistId, anivexaApi, streamProxy); }
    else if (parts[0] === 'read' && anilistId && /^\d+$/.test(anilistId)) { html = readPage(pk, cu, anilistId, anivexaApi, streamProxy); }
    else { return new Response(notFoundPage(pk, cu), { status: 404, headers: { 'Content-Type': 'text/html; charset=UTF-8' } }); }
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
  }
};
