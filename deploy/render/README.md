# Render deploy (backend)

`render.yaml` at the repo root is a Render Blueprint for the FastAPI backend: the free plan
(512 MB, 0.1 CPU), Python 3.13.5, built with `pip install -r backend/requirements.txt` and
started from `backend/`. It redeploys after CI passes on `main`. The frontend stays on
Cloudflare Pages, whose `/api/*` function forwards here (`deploy/cloudflare-pages`).

Free web services sleep after 15 minutes without traffic and take about a minute to wake,
so open the site a few minutes before judges do. With no card on file Render suspends the
service instead of billing; 750 free hours a month covers one service running all month.

## One-time setup

1. Sign up at https://render.com (no card needed).
2. Give Render's GitHub app access to `heruirayli/cleantech-hacks`. The repo is private and
   owned by heruirayli, so they approve the install request.
3. Dashboard -> New -> Blueprint -> pick the repo, branch `main` -> Apply. Leave
   `EE_PROJECT` and `EE_SERVICE_ACCOUNT_KEY` blank unless you do step 4.
4. Optional, Earth Engine: create a service account in the Earth Engine Cloud project, give
   it Earth Engine access, download its JSON key, and upload it in the service's
   Environment tab as a Secret File named `ee-key.json`. Then set
   `EE_SERVICE_ACCOUNT_KEY=/etc/secrets/ee-key.json` and `EE_PROJECT=<project id>`.
   Never commit the key.
5. Point the frontend at the service: set `BACKEND_ORIGIN` in
   `deploy/cloudflare-pages/wrangler.toml` to the service URL (`https://<name>.onrender.com`)
   and run `scripts/deploy-frontend.sh`.
