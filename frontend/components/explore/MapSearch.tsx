"use client";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import type { Map as MLMap } from "maplibre-gl";
import { request } from "@/lib/api";
import { prefersReducedMotion } from "@/lib/settings";

interface Place { id: string; name: string; kind: string; location: { lon: number; lat: number }; bounds?: [number, number, number, number] }
export function MapSearch({ mapRef, ready, onNavigate }: { mapRef: RefObject<MLMap | null>; ready: boolean; onNavigate: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const seq = useRef(0);
  useEffect(() => () => { controller.current?.abort(); }, []);
  const search = async (event: FormEvent) => {
    event.preventDefault(); controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    const mine = ++seq.current; setBusy(true); setError(null);
    try {
      const response = await request<{ results: Place[] }>(`/explore/search?q=${encodeURIComponent(query.trim())}`, { signal: abort.signal });
      if (mine === seq.current) setResults(response.results);
    } catch (e) { if (!abort.signal.aborted) setError((e as Error).message); }
    finally { if (mine === seq.current) setBusy(false); }
  };
  const go = (p: Place) => {
    const map = mapRef.current; if (!map) return;
    onNavigate();
    // Settings > Reduce motion (or the OS): jump instead of animating.
    const motion = { animate: !prefersReducedMotion(), essential: true } as const;
    if (p.bounds) map.fitBounds([[p.bounds[0], p.bounds[1]], [p.bounds[2], p.bounds[3]]], { padding: 45, maxZoom: 12, duration: 800, ...motion });
    else map.flyTo({ center: [p.location.lon, p.location.lat], zoom: p.kind === "Place" ? 11 : 13, duration: 900, ...motion });
    setQuery(p.name); setResults(null);
  };
  return <div className="pointer-events-auto w-72 max-w-full rounded-md bg-white/95 p-2 text-xs shadow ring-1 ring-black/10 dark:bg-zinc-950/95 dark:ring-white/10">
    <form onSubmit={e => void search(e)} className="flex gap-1">
      <label className="sr-only" htmlFor="map-search">Find a California city, county, plant or coordinates</label>
      <input id="map-search" type="search" autoComplete="off" value={query} placeholder="City, county, plant or lat, lon" minLength={2} maxLength={120}
        className="min-w-0 flex-1 rounded border border-zinc-300 bg-transparent px-2 py-1.5 dark:border-zinc-700"
        onChange={e => { setQuery(e.target.value); setResults(null); setError(null); seq.current++; controller.current?.abort(); setBusy(false); }}
        onKeyDown={e => { if (e.key === "Escape") setResults(null); }} />
      <button type="submit" disabled={!ready || busy || query.trim().length < 2} className="rounded bg-emerald-800 px-2 py-1 text-white disabled:opacity-40 dark:bg-cyan-300 dark:text-slate-950">{busy ? "…" : "Find"}</button>
    </form>
    {error && <p role="alert" className="mt-1 text-[11px] text-red-600">Could not search. Try a city, county or coordinates.</p>}
    {results && <div className="mt-1 max-h-56 overflow-y-auto"><ul aria-label="Map search results">{results.map(p => <li key={p.id}><button type="button" onClick={() => go(p)} className="w-full rounded px-2 py-2 text-left hover:bg-zinc-100 focus:bg-zinc-100 dark:hover:bg-zinc-800 dark:focus:bg-zinc-800"><span className="font-medium">{p.name}</span><span className="ml-2 text-[10px] text-zinc-500">{p.kind}</span></button></li>)}</ul>
      {!results.length && <p className="p-2 text-zinc-500">No California matches. Try a city, county, power plant, or “37.77, -122.42”.</p>}
      <p className="border-t border-zinc-200 pt-1 text-[9px] text-zinc-500 dark:border-zinc-700">Local search · US Census 2024 + EIA/CEC/OSM grid layers</p>
    </div>}
  </div>;
}
