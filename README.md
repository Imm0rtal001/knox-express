# Knox Express Addon

This is an Express-based remote addon wrapper built from the supplied Knox provider repository.

## Features

- Standard `/manifest.json` endpoint for Nuvio/Stremio-style addon installation, including the Knox Express logo/icon so the addon appears with branding in the installed-addons section.
- `/stream/movie/:id.json` and `/stream/series/:id:season:episode.json` stream endpoints.
- Fetches all enabled providers in parallel so one slow provider does not delay every other provider.
- Responsive TV/mobile web UI at `/`.
- Enable/disable individual providers and enable/disable all.
- Persistent provider state in `data/providers.json`.
- Nuvio-friendly provider stream metadata: provider, scraper/server, release filename, quality, resolution, file size, language, audio, codec, source, HDR, subtitles, and display badges are returned in every normalized stream.
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
- `PROVIDER_CONCURRENCY=3`

## Notes

The provider implementations remain under `providers/` and are loaded only when enabled. The original provider code was not rewritten, so provider-specific scraping behavior remains isolated from the Express addon layer.

Use only sources and content you are authorized to access.


## Vercel fetch behavior



## v4.0.23 provider metadata fetch/display fixes
- Every provider result is normalized into a common metadata shape.
- Provider name and scraper/server label are returned separately.
- Release filename, quality/resolution, file size, source, language, audio, codec, HDR, subtitles, bitrate, and display badges are preserved when present or detected from the scraped release text.
- `description` is formatted as a mobile-friendly multi-line block so clients can show provider/server, size, release filename, and source details similar to the reference UI.
- Existing provider-specific fields and playback headers remain intact.

## v4.0.8 provider fetch fixes
- Vercel region is set to Mumbai (`bom1`) to reduce latency and improve compatibility with India-focused upstream providers.
- Provider execution uses `Promise.allSettled()` so one rejected provider cannot abort the complete provider fetch.
- Provider results remain isolated and are returned even when other providers fail.
- If a provider's upstream site is unavailable or blocks Vercel, the addon cannot manufacture a stream; the dashboard logs the provider failure instead of hiding the failure behind a global error.

### Deployment behavior

- Provider/application timeout limits are disabled; scrapers are allowed to run until the hosting platform or upstream request itself ends.
- No Vercel `maxDuration` limit is configured by this repository.

## Fire TV / Nuvio compatibility fixes (v4.0.26)
- Correctly parses TMDB/IMDb movie and series IDs used by Nuvio TV.
- Adds CORS and OPTIONS support for Fire TV/WebView clients.
- Adds HEAD compatibility for manifest and stream endpoints.
- Pins Vercel runtime to Node.js 20 for stable deployment.
