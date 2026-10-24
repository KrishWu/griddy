// Forwards /api/* from the static site to the FastAPI backend, the job Next's rewrite
// does in dev, so the frontend keeps calling relative /api URLs with no CORS.
export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, env.BACKEND_ORIGIN);
  try {
    return await fetch(new Request(target, request));
  } catch {
    return Response.json({ detail: "The Griddy backend is offline right now." }, { status: 502 });
  }
}
