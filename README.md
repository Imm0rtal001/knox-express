# Knox Express Addon

This is an Express-based remote addon wrapper built from the supplied Knox provider repository.

## Features

- Standard `/manifest.json` endpoint for Nuvio/Stremio-style addon installation, including the Knox Express logo/icon so the addon appears with branding in the installed-addons section.
- `/stream/movie/:id.json` and `/stream/series/:id:season:episode.json` stream endpoints.
- Fetches all enabled providers in parallel so one slow provider does not delay every other provider.
- Provider timeout isolation so one failed scraper does not block all results.
- Responsive TV/mobile web UI at `/`.
- Enable/disable individual providers and enable/disable all.
- Persistent provider state in `data/providers.json`.
- Nuvio badge-friendly stream titles: quality metadata is preserved in the title so Nuvio badge regexes can match it.
- Live health and server logs.
- Custom DNS resolver selection: System, Cloudflare, Google, Quad9, AdGuard, or custom IPv4/IPv6 DNS servers.
- Supports numeric TMDB IDs and IMDb IDs (`tt...`) with TMDB ID resolution.

## Run

Requires Node.js 20+.

```bash
npm install
npm start
```

Open `http://localhost:7000/`.

For Nuvio, use:

`http://YOUR-HOST:7000/manifest.json`

For Fire TV/Android TV, the host running this server must be reachable from the device. A public HTTPS deployment is recommended for remote installation.

## Environment

- `PORT=7000`
- `TMDB_API_KEY=...` optional override for IMDb → TMDB resolution
- `PROVIDER_TIMEOUT_MS=15000`
- `PROVIDER_CONCURRENCY=3`

## Notes

The provider implementations remain under `providers/` and are loaded only when enabled. The original provider code was not rewritten, so provider-specific scraping behavior remains isolated from the Express addon layer.

Use only sources and content you are authorized to access.


## Vercel fetch behavior

All enabled providers are requested in parallel. On Vercel, provider aggregation is capped below the platform function-duration limit so the endpoint can return partial results instead of timing out. The 10/15/20/30 second provider timeout options remain available for self-hosted deployments.


## v4.0.8 provider fetch fixes
- Vercel region is set to Mumbai (`bom1`) to reduce latency and improve compatibility with India-focused upstream providers.
- Vercel function max duration is 60 seconds; the selected 10/15/20/30 second provider timeout is respected.
- Provider execution uses `Promise.allSettled()` so one rejected provider cannot abort the complete provider fetch.
- Provider results remain isolated and are returned even when other providers fail.
- If a provider's upstream site is unavailable or blocks Vercel, the addon cannot manufacture a stream; the dashboard logs the provider failure instead of hiding the failure behind a global error.
