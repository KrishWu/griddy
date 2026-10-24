// Pages "advanced mode" Worker (build.sh copies it to out/_worker.js). It forwards /api/*
// to the FastAPI backend, the job Next's rewrite does in dev, so the frontend keeps calling
// relative /api URLs with no CORS; out/_routes.json sends only /api traffic here, so every
// other path is served straight from the static files.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    const target = new URL(url.pathname + url.search, env.BACKEND_ORIGIN);
    try {
      return await fetch(new Request(target, request));
    } catch {
      return Response.json({ detail: "The Griddy backend is offline right now." }, { status: 502 });
    }
  },
};
