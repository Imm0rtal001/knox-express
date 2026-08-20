# Vercel deployment fix — v4.0.4

The previous deployment failed during `vercel build` with:

`Error: Function Runtimes must have a valid version`

Cause: `vercel.json` used the legacy/invalid `runtime: nodejs22.x` value inside the `functions` block. Vercel's current runtime configuration does not require that override here.

## Fix

- Removed the `functions.runtime` override completely.
- Kept `api/index.js` as the Node/Express serverless entrypoint.
- Kept Node 22 selected through `package.json` `engines` / Vercel Project Settings.
- Kept the rewrite to the Express entrypoint.
- No `now.json` is included.

## Deploy

Upload the ZIP contents as a new Vercel project, or replace the project files and deploy with **Redeploy**. If Vercel asks for a Node.js version, choose **22.x** (20.x is also supported by Vercel).

Do not add a `functions.runtime: nodejs22.x` entry back into `vercel.json`.

## Node.js 24 deployment

This release targets Node.js 24.x, which is the current default supported Node.js major on Vercel. Keep the Vercel Project Settings -> Build and Deployment -> Node.js Version set to **24.x** so the dashboard and repository configuration stay aligned.

## Provider toggle persistence on Vercel

Vercel functions are stateless between invocations. For provider enable/disable settings to persist across separate requests, configure an Upstash Redis REST connection in the deployment:

- `KV_REST_API_URL` + `KV_REST_API_TOKEN`, or
- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`

The addon uses the REST API directly and stores provider state under `knox:provider-state`.
Without these variables, toggles persist for the current process/self-hosted server but Vercel may reset them on a new function instance.
