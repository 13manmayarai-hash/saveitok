# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

SaveItOk (saveitok.com) is a static site plus two Netlify serverless functions that lets users download videos from TikTok, Douyin, Instagram, and Facebook (HD, no watermark, no signup). There is no framework, no bundler, and no `package.json` — every page is a single self-contained HTML file with an inline `<style>` block and inline `<script>`, deployed as-is by Netlify.

## Commands

There is no build step, package manager, linter, or test suite in this repo — it's plain HTML/CSS/JS. Useful commands:

- **Local static preview**: `python3 -m http.server 8000` from the repo root, then visit `http://localhost:8000/index.html` (or any other page). This serves pages but `/api/download` and `/api/proxy` calls will fail since there's no function runtime.
- **Local preview with working functions**: `netlify dev` (requires the Netlify CLI and a `ZM_API_KEY` env var — see `netlify/functions/download.js`) proxies both the static files and the two functions together, matching `netlify.toml`'s redirects.
- **Deploy**: pushing to the connected branch triggers a Netlify build automatically; `[build] functions = "netlify/functions"` in `netlify.toml` is the only build config.
- **Screenshot/visual verification**: use Playwright against a local `http.server` instance — there's no other way to verify CSS/layout changes in this repo.

## Architecture

### Page inventory
- `index.html` — the main app (hero, download widget, "how it works", supported platforms, FAQ, AdSense placements, cookie banner).
- `tiktok-downloader.html`, `tiktok-without-watermark.html`, `instagram-downloader.html`, `instagram-reels-downloader.html`, `instagram-story-downloader.html`, `facebook-video-downloader.html`, `douyin-downloader.html` — SEO landing pages targeting long-tail keywords. Each one duplicates its own copy of the download widget markup, CSS, and JS (not shared with `index.html` or with each other) — **all 7 currently carry byte-identical `<style>` blocks**, so a style change meant to apply to all of them should be made once and propagated to each file (verify with `md5sum` on the extracted style block before assuming they're still identical).
- `privacy.html`, `terms.html`, `dmca.html`, `404.html` — static content pages, each with their own inline stylesheet (same design tokens as `index.html`, restated per file since there's no shared CSS file).
- `netlify.toml` maps clean URLs (e.g. `/tiktok-downloader`) to their `.html` files, sets security headers, routes `/api/download` and `/api/proxy` to the two functions, and catches all unmatched routes to `404.html`. Note: it redirects `/facebook-reels-downloader` → `facebook-reels-downloader.html`, but that file does not exist in the repo (only `facebook-video-downloader.html` does).
- `robots.txt` / `sitemap.xml` / `manifest.json` — standard SEO/PWA metadata, kept in sync with the page list above manually.

### Orphaned / unused files
`app.css`, `styles.css`, and `preview.html` implement a second, unrelated design system (lemon-yellow `#F2FD7D` background, deep-teal ink, monochrome) and are **not linked from any live page** — no HTML file references `app.css` or `styles.css`, and nothing links to `preview.html`. Treat these as a design mockup/prototype, not part of the active site, unless told otherwise.

### Design system (active, on index.html + all 7 landing pages + legal/404 pages)
A "modern, playful, bold" visual language implemented via CSS custom properties, restated independently in each file's inline `<style>` block (no shared stylesheet exists):
- Cream background (`--bg: #FFF7EC`), near-black ink (`--text: #191521`) used for both text and borders.
- Accent gradient pink→yellow (`--accent: #FF3D81`, `--yellow: #FFC93C`, `--accent2: #7C3AED` purple).
- Bold 2.5px black borders + chunky offset "sticker" box-shadows (e.g. `6px 6px 0 var(--border2)`) on cards and buttons, with a hover/press bounce (`translate(-2px,-2px)` on hover, `translate(2px,2px)` on active, shadow shrinking to match).
- Headings in `Fredoka` (loaded from Google Fonts, weights 500/600/700 — it has no 800 weight, so headings cap at `font-weight:700`), body text in `Inter`.
- `index.html` additionally has floating blurred color "blob" background shapes and small animated emoji "stickers" in the hero.

### AdSense
Only `index.html` (and the unused `preview.html`) wires up Google AdSense. The publisher ID and per-slot ad unit IDs live in a single `ADSENSE` JS object near the top of `index.html`'s `<head>`; each `<ins class="adsbygoogle">` element gets its `data-ad-slot` set from `ADSENSE.SLOTS.*` at runtime and only pushes to `adsbygoogle` once that slot ID is non-empty (so leaving a slot ID blank in `ADSENSE.SLOTS` is the mechanism for disabling that placement). The 7 SEO landing pages currently have no ads at all.

### Serverless functions (`netlify/functions/`)
- **`download.js`** — `POST /api/download`. Calls the ZM API (`https://api.zm.io.vn/v1/social/autolink`) server-to-server using the `ZM_API_KEY` env var (never exposed to the client), then normalizes ZM's response into a `picker` array (ranked best-quality-first: `hd_no_watermark` > `no_watermark` > `watermark`, audio appended or prioritized depending on the requested quality). Validates the URL is `http(s)` and under 2048 chars before calling out.
- **`proxy.js`** — `GET /api/proxy?url=<encoded>&name=<filename>`. Streams a video CDN URL through the server (via `fetch` + base64 response body) so the browser downloads it directly instead of hitting the CDN cross-origin — this is what forces a real file download via `Content-Disposition: attachment` and works around Douyin's China-only CDN geo-block. **This is a deliberately closed proxy, not a general one**: `ALLOWED_HOST_SUFFIXES` allowlists only the known TikTok/Douyin/Instagram/Facebook CDN domains, and `isPrivateHost` blocks private/internal/link-local IP ranges (SSRF hardening) — any change here needs to preserve both checks. Netlify's free-tier function limits (~10s execution, response size) cap proxied file size at 9MB raw.
- Every download widget across all 8 pages (`index.html` + 7 landing pages) calls these same two endpoints with the same request/response shape, so a change to the API contract (e.g. the `picker` item shape) must be reflected in every page's JS, not just `index.html`'s.

### Known content inconsistencies
Contact email differs by page: `dmca.html` uses `saveit.dmca@gmail.com`, `index.html`'s footer uses `saveit.support@gmail.com`, while `privacy.html`/`terms.html` (and the unused `preview.html`) use `hello@saveitok.com`. Not necessarily a bug — flagging so it isn't assumed to be one canonical address when editing these pages.
