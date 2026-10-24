# Cloudflare Pages deploy

The frontend ships as static files (`STATIC_EXPORT=1 next build` writes `frontend/out/`) to the
Cloudflare Pages project `griddy`, served at https://getgriddy.app. `functions/api/[[path]].js`
forwards `/api/*` to `BACKEND_ORIGIN` from `wrangler.toml`.

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

Redeploy the frontend after merging frontend changes: `scripts/deploy-frontend.sh`.
