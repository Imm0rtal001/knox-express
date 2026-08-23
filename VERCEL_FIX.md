# Parallel provider / Vercel fixes

## Provider loading

The three providers that imported the removed `cheerio-without-node-native` package now use the project's installed `cheerio` dependency:

- `hdhub4u.js`
- `vegamovies.js`
- `rogmovies.js`

`crypto-js` remains declared in `package.json` for MovieBlast.

## Parallel execution

Every enabled provider is started before the server awaits any provider result. `Promise.allSettled()` isolates provider failures, so one broken provider cannot cancel the others.

## Vercel

The explicit `functions.api/index.js.maxDuration` setting has been removed from `vercel.json` as requested. Vercel's platform/plan default function duration now applies.

There is no application-level scraper timeout.

## Diagnostics

After deployment, open:

`/api/providers/diagnostics`

This reports every configured provider, whether its file loads, and any module-load error.


## Current Vercel runtime error fix

If Vercel reports `Error: Function Runtimes must have a valid version`, the cause is the
explicit `functions.api/index.js.runtime` entry in `vercel.json`. This repository now
lets Vercel detect the Node.js function automatically and uses `package.json`'s
`engines.node` (`20.x`) for the Node version. The rewrite sends addon routes to
`api/index.js`.
