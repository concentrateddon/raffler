# Raffler

An offline-first PWA for running community prize raffles without paper tickets. Vanilla HTML/CSS/JS — no build step.

- `public/` — the deployable site (`index.html`, `app.js`, `styles.css`, `sw.js`, manifest, icons, `_headers`)
- `tools/icon.svg` — source artwork for the PNG icons in `public/icons/`
- `wrangler.jsonc` — Cloudflare Workers static-assets config (serves `public/`)

## Run locally

```bash
python3 -m http.server 8787 --directory public
```

Open http://localhost:8787 (service workers work on `localhost`).

## Deploy to Cloudflare

```bash
npx wrangler deploy
```

Or connect the repo to Cloudflare Pages with `public` as the build output directory and no build command.

**Every deploy that changes a file in `public/` must bump `CACHE` in `public/sw.js`** (e.g. `raffler-v2`), otherwise installed copies keep serving the old files.

## Data

All raffle data is kept in `localStorage` on the device (key `raffler.state.v1`). Nothing is ever sent over the network.
