# Cloudflare Pages deploy

The frontend ships as static files to the Cloudflare Pages project `griddy`, served at
https://getgriddy.app. `build.sh` runs `STATIC_EXPORT=1 next build` and copies `frontend/out/`
into `out/` here, because Pages only accepts an output folder inside its root directory.
`functions/api/[[path]].js` forwards `/api/*` to `BACKEND_ORIGIN` from `wrangler.toml`.

Pages builds every push to `main` from GitHub (`KrishWu/griddy`) with root directory
`deploy/cloudflare-pages` and build command `bash build.sh`. `scripts/deploy-frontend.sh`
uploads a local build instead, if a GitHub build ever needs bypassing.

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

Merging to `main` redeploys the frontend; no manual step is needed.
