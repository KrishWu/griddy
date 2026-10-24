# Cloudflare Pages deploy

The frontend ships as static files to the Cloudflare Pages project `griddy`, served at
https://getgriddy.app. `build.sh` runs `STATIC_EXPORT=1 next build` and copies `frontend/out/`
into `out/` here (Pages' GitHub builds only accept an output folder inside the root directory).
`functions/api/[[path]].js` forwards `/api/*` to `BACKEND_ORIGIN` from `wrangler.toml`.

**Deploying the frontend.** Pages is connected to GitHub (`KrishWu/griddy`, root directory
`deploy/cloudflare-pages`, build command `bash build.sh`). Automatic production deployments are
off for now, so each merge to `main` shows up as an Idle production deployment. To put `main` live:

- Cloudflare dashboard: Workers & Pages -> griddy -> Deployments -> the Idle entry -> ... ->
  Retry deployment, which builds it from GitHub; or
- `scripts/deploy-frontend.sh`, which builds locally with `build.sh` and uploads with Wrangler
  (first time: `npx wrangler login`).

GitHub builds include the `/api` code: the PR previews for #31-#33 and the production build of
`5f5877a` (`5b59f56f`) all served `/api` on 2026-10-24. The first GitHub builds that day (`2c825c7`,
and #28's preview) skipped it, so every `/api` call returned 404; the cause was never confirmed.
After any production deploy, check that https://getgriddy.app/api/health returns 200, and roll back
in the dashboard if it doesn't. Turning automatic production deployments back on (Settings ->
Builds -> Branch control) makes every merge to `main` go live by itself.

The backend runs on Render at https://griddy-api.onrender.com (`render.yaml`,
`deploy/render/README.md`). Its free plan sleeps after 15 minutes idle, so the first `/api`
call after a quiet spell waits about a minute.

## Fallback: the backend on a laptop

Point `BACKEND_ORIGIN` at https://api.getgriddy.app and redeploy, then keep the laptop awake
with the backend and the tunnel running:

```bash
scripts/dev.sh                     # backend on :8000 (and the dev frontend on :3000)
cloudflared tunnel run griddy-api  # in another terminal
```

One-time setup on that laptop:

```bash
npx wrangler login                                   # Cloudflare account that owns getgriddy.app
brew install cloudflared && cloudflared tunnel login # pick getgriddy.app
cloudflared tunnel create griddy-api
cloudflared tunnel route dns griddy-api api.getgriddy.app
```

plus `~/.cloudflared/config.yml` pointing the tunnel at `http://127.0.0.1:8000`, and the
custom domain `getgriddy.app` added to the Pages project in the Cloudflare dashboard.
