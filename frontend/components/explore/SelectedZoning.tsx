"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";

import { Term } from "@/components/glossary/Term";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const COLORS = { Residential: "#fbbf24", Industrial: "#a78bfa", Commercial: "#f87171", Agricultural: "#86efac", "Open space": "#2dd4bf", Other: "#7dd3fc" };

export function SelectedZoning({ mapRef, styleGen, footprint }: { mapRef: RefObject<MLMap | null>; styleGen: number; footprint?: GeoJSON.Polygon | null }) {
  const key = JSON.stringify(footprint ?? null);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const [state, setState] = useState<{ key: string; data: GeoJSON.FeatureCollection; loading: boolean; message: string } | null>(null);
  const [shown, setShown] = useState(false);
  const current = state?.key === key ? state : null;
  const data = shown && current ? current.data : EMPTY;
  const drawn = useRef<{ source: GeoJSONSource; data: GeoJSON.FeatureCollection } | null>(null);

  useEffect(() => () => { sequence.current++; controller.current?.abort(); }, [key]);
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !styleGen) return;
    if (!m.getSource("zoning")) {
      m.addSource("zoning", { type: "geojson", data: EMPTY, buffer: 0, tolerance: 1, maxzoom: 14, attribution: "California LCI historical zoning" });
      const before = m.getLayer("transmission") ? "transmission" : m.getLayer("site") ? "site" : undefined;
      m.addLayer({ id: "zoning-fill", source: "zoning", type: "fill", paint: { "fill-opacity": 0.33,
        "fill-color": ["match", ["get", "category"], "Residential", COLORS.Residential, "Industrial", COLORS.Industrial, "Commercial", COLORS.Commercial, "Agricultural", COLORS.Agricultural, "Open space", COLORS["Open space"], COLORS.Other] } }, before);
      m.addLayer({ id: "zoning-line", source: "zoning", type: "line", minzoom: 11, paint: { "line-color": "#64748b", "line-width": 0.5, "line-opacity": 0.5 } }, before);
    }
    const source = m.getSource<GeoJSONSource>("zoning")!;
    const previous = drawn.current;
    if (previous?.source !== source || previous.data !== data) {
      const appended = previous?.source === source && previous.data.features.length < data.features.length && previous.data.features.every((f, i) => data.features[i] === f);
      if (appended) {
        // Stable feature IDs let the worker add the new page without reprocessing old pages.
        void source.updateData({ add: data.features.slice(previous!.data.features.length) }).catch(() => {
          if (mapRef.current?.getSource("zoning") === source && drawn.current?.source === source) source.setData(drawn.current.data);
        });
      } else source.setData(data);
      drawn.current = { source, data };
    }
  }, [data, styleGen, mapRef]);

  const load = async () => {
    if (!footprint) return;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    const mine = ++sequence.current;
    setShown(true);
    setState({ key, data: EMPTY, loading: true, message: "Connecting to zoning data…" });
    const accumulated: GeoJSON.Feature[] = [];
    let complete = false;
    const publish = (loading: boolean, message: string) => {
      if (mine === sequence.current) setState({ key, data: { type: "FeatureCollection", features: [...accumulated] }, loading, message });
    };
    try {
      const response = await fetch("/api/explore/zoning/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ footprint }), signal: abort.signal });
      if (!response.ok || !response.body) throw new Error(response.status === 422 ? "Highlight a smaller California area (maximum 100 km²)." : "Zoning service unavailable. Try again.");
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let pending = "";
      while (true) {
        const chunk = await reader.read();
        pending += decoder.decode(chunk.value, { stream: !chunk.done });
        const lines = pending.split("\n"); pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "features") {
            accumulated.push(...event.features);
            publish(true, `${accumulated.length} zones rendered · loading more…`);
            // Let MapLibre and the browser paint this batch before consuming another.
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          } else if (event.type === "complete") {
            complete = true;
            const status = event.metadata.status;
            publish(false, status === "unavailable" ? "Zoning unavailable. Try again." : status === "partial" ? `${accumulated.length} zones shown · partial coverage; highlight a smaller area for more detail.` : `${accumulated.length} zones loaded in the highlighted area.`);
          }
        }
        if (chunk.done) break;
      }
      if (!complete) throw new Error("Connection ended early. Loaded zones are kept; retry for complete coverage.");
    } catch (e) {
      if ((e as Error).name !== "AbortError") publish(false, (e as Error).message);
    }
  };
  return <div className="mt-2 border-t border-zinc-200 pt-2 dark:border-zinc-700">
    <p className="mb-1.5 text-[11px] text-zinc-500">Highlight up to 100 km², then load <Term k="zoning">zoning</Term> progressively. Moving the map keeps loaded zones.</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={!footprint || !styleGen || current?.loading} onClick={() => void load()} className="rounded bg-emerald-700 px-2 py-1.5 font-medium text-white disabled:opacity-40 dark:bg-cyan-300 dark:text-slate-950">{current?.loading ? "Rendering zones…" : "Load zoning for area"}</button>
      {current?.loading && <button type="button" className="underline" onClick={() => { controller.current?.abort(); sequence.current++; setState(s => s ? { ...s, loading: false, message: `${s.data.features.length} zones kept · loading stopped.` } : s); }}>Stop</button>}
      {current && !current.loading && current.data.features.length > 0 && <button type="button" className="underline" onClick={() => setShown(v => !v)}>{shown ? "Hide zones" : "Show zones"}</button>}
    </div>
    {current && <p role="status" aria-live="polite" className="mt-1.5 text-[11px]">{current.message}</p>}
    {current && <details className="mt-1 text-[10px]"><summary className="cursor-pointer text-zinc-500">Zoning legend &amp; source</summary>
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1">{Object.entries(COLORS).map(([label, color]) => <span key={label} className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ backgroundColor: color }} />{label}</span>)}</div>
      <p className="mt-1 text-zinc-500">LCI data largely collected 2021–23; boundaries generalized to about 4 m. Verify current allowed uses locally. <a href="https://publish.data.ca.gov/dataset/california-statewide-zoning-south" className="underline" target="_blank" rel="noreferrer">Source</a></p>
    </details>}
  </div>;
}
