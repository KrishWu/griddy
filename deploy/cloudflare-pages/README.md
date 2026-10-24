# Cloudflare Pages deploy

The frontend ships as static files to the Cloudflare Pages project `griddy`, served at
https://getgriddy.app. `build.sh` runs `STATIC_EXPORT=1 next build` and copies `frontend/out/`
into `out/` here (Pages' GitHub builds only accept an output folder inside the root directory).
`functions/api/[[path]].js` forwards `/api/*` to `BACKEND_ORIGIN` from `wrangler.toml`.

**Frontend deploys are manual.** After merging frontend changes to `main`, run:

```bash
scripts/deploy-frontend.sh   # builds with build.sh, uploads with Wrangler (first time: npx wrangler login)
```

The Pages project is also connected to GitHub (`KrishWu/griddy`, root directory
`deploy/cloudflare-pages`, build command `bash build.sh`), but GitHub-built deployments
skip the `/api` code, so every `/api` call on them returns 404 (seen on `2c825c7`, and with
an advanced-mode `_worker.js` in #28). Keep automatic production deployments off in the
dashboard (Settings -> Builds -> Branch control).

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
