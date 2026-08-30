# Multi-file split — migration notes

## What changed
`Worker.js` (1,165 lines, one file) is now `src/` (12 files, same 1,206 lines of actual code, just organized):

```
src/
  index.js              — fetch handler + routing (was lines 1-23)
  api/
    progress.js         — D1 progress endpoints (GET/POST/DELETE)
    proxy.js            — AniList/Anivexa + MangaDex proxies
  lib/
    icons.js            — SVG icon() library
    theme.js            — commonCSS(), clerkHead(), themeInitScript(), siteMeta()
    auth.js             — commonAuthJS(), headerMarkup()
    skeletons.js         — all skeleton-loader HTML generators
  pages/
    index.js            — homepage
    detail.js
    watch.js
    read.js
    notfound.js
```

## What did NOT change
Every single function's logic, byte-for-byte. I verified this directly: I imported both the old monolithic file and the new split version side by side and diffed the actual HTML output of every page — `indexPage`, `detailPage`, `watchPage`, `readPage`, `notFoundPage` all produced **character-for-character identical output**. This is a pure reorganization, not a rewrite.

## What you need to change to deploy this

**Your `wrangler.toml`'s `main` entry point:**

```toml
main = "src/index.js"
```

(previously presumably `main = "Worker.js"` or similar — update it to point at the new entry file). Keep your existing `[[d1_databases]]` block and all your env vars exactly as they are; nothing about your bindings changed.

That's the only required change. Wrangler's bundler (esbuild under the hood) resolves the `import`/`export` statements across all 12 files automatically at deploy time and produces one Worker script, exactly like it always has — there's no new build step for you to run, no npm packages added, no framework introduced.

## Verification performed
- `node --check` on all 12 files individually — pass
- Full import graph loads cleanly in Node (no circular imports, no missing exports)
- Every page function called through the real module graph, output diffed against the original monolithic file — **identical**
- Installed real Wrangler and ran `wrangler deploy --dry-run` — bundled successfully, 116.83 KiB (26.61 KiB gzipped), correctly detected the `ledger-db` D1 binding, well under the 3MB free-tier Worker size limit
- Ran the actual bundled Worker under `wrangler dev` and hit every route (`/`, `/detail/:id`, `/watch/:id`, `/read/:id`, an unknown path) — all returned correct HTTP status codes (200/200/200/200/404)

This is about as close to "guaranteed to work" as I can get without your live Anivexa/Clerk/AniList credentials.

