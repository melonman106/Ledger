const CORS_JSON = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

export async function handleProgress(request, env, parts) {
  // Binding variable name may be "DB" or the literal "ledger-db" depending on how it was added in the dashboard.
  const db = env.DB || env['ledger-db'] || env['ledger_db'];
  if (!db) { return new Response(JSON.stringify({ error: 'D1 binding not found. Expected a binding named DB or ledger-db.' }), { status: 500, headers: CORS_JSON }); }
  const url = new URL(request.url);
  try {
    if (request.method === 'GET') {
      const userId = url.searchParams.get('user');
      const id = url.searchParams.get('id');
      if (!userId) return new Response(JSON.stringify({ error: 'user required' }), { status: 400, headers: CORS_JSON });
      if (id) {
        const row = await db.prepare('SELECT * FROM watch_progress WHERE user_id = ? AND anilist_id = ?').bind(userId, id).first();
        return new Response(JSON.stringify({ item: row || null }), { headers: CORS_JSON });
      }
      const { results } = await db.prepare('SELECT * FROM watch_progress WHERE user_id = ? ORDER BY updated_at DESC LIMIT 20').bind(userId).all();
      return new Response(JSON.stringify({ items: results || [] }), { headers: CORS_JSON });
    }
    if (request.method === 'POST') {
      const body = await request.json();
      const { userId, anilistId, type, title, coverImage, episodeOrChapter, positionSeconds, durationSeconds, pageIndex } = body || {};
      if (!userId || !anilistId || !type || !title) return new Response(JSON.stringify({ error: 'missing fields' }), { status: 400, headers: CORS_JSON });
      await db.prepare(`INSERT INTO watch_progress (user_id, anilist_id, type, title, cover_image, episode_or_chapter, position_seconds, duration_seconds, page_index, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(user_id, anilist_id) DO UPDATE SET type=excluded.type, title=excluded.title, cover_image=excluded.cover_image,
        episode_or_chapter=excluded.episode_or_chapter, position_seconds=excluded.position_seconds, duration_seconds=excluded.duration_seconds,
        page_index=excluded.page_index, updated_at=excluded.updated_at`)
        .bind(userId, anilistId, type, title, coverImage || null, episodeOrChapter || null, positionSeconds ?? null, durationSeconds ?? null, pageIndex ?? null, Date.now())
        .run();
      return new Response(JSON.stringify({ ok: true }), { headers: CORS_JSON });
    }
    if (request.method === 'DELETE') {
      const anilistId = parts[2];
      const userId = url.searchParams.get('user');
      if (!userId || !anilistId) return new Response(JSON.stringify({ error: 'missing fields' }), { status: 400, headers: CORS_JSON });
      await db.prepare('DELETE FROM watch_progress WHERE user_id = ? AND anilist_id = ?').bind(userId, anilistId).run();
      return new Response(JSON.stringify({ ok: true }), { headers: CORS_JSON });
    }
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: CORS_JSON });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'progress error: ' + err.message }), { status: 500, headers: CORS_JSON });
  }
}
