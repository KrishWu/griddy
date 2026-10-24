# Griddy frontend

Next.js 16 (App Router, Turbopack), React 19, MapLibre GL and Recharts, styled with
Tailwind 4. The pages are static shells around client components; data comes from the
FastAPI backend through relative `/api/*` URLs (`lib/api.ts`). Next 16 differs from older versions: read
`AGENTS.md` and `node_modules/next/dist/docs/` before writing Next-specific code.

## Develop

From the repo root, `scripts/dev.sh` starts the backend on :8000 and this app on
http://localhost:3000, which proxies `/api/*` to the backend (`next.config.ts`; set
`GRIDFORGE_API_ORIGIN` to point it elsewhere). Install with `npm ci`, never `npm install`
on a feature branch (see `CLAUDE.md`).

```bash
npm run typecheck   # next typegen + tsc
npm run lint
npm run build       # production build
```

## Layout

- `app/`: the pages: `/` (the planner), `/report` (printable report) and `/about`.
- `components/<module>/`: one folder per workstream module (`explore`, `forecast`,
  `simulate`, `sites`, `evaluate`, `builder`, `site_intel`), plus the app-wide `shell/`
  (layout, tabbed sidebars, panels), `settings/`, `glossary/` (jargon tooltips) and `about/`.
- `lib/`: `contract.ts` (types mirrored from `backend/app/contract.py`), `api.ts`,
  `store.tsx` (shared state: `useGridForge()`), `settings.tsx` (theme, text size, map
  options; saved in `localStorage`), `glossary.ts` and `format.ts`.
- `public/`: static files. `maplibre-gl-worker.mjs` is copied in by `postinstall`.

## Static export and deployment

`STATIC_EXPORT=1 npm run build` writes plain files to `out/` (no rewrites, so `/api/*`
needs something in front). Production is Cloudflare Pages at https://getgriddy.app, where
a Pages function forwards `/api/*` to the Render backend: see
`../deploy/cloudflare-pages/README.md`.
