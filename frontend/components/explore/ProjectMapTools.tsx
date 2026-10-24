"use client";

import { useEffect, useState, type RefObject } from "react";
import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";
import { SelectedZoning } from "./SelectedZoning";
import type { LngLat } from "@/lib/contract";
import { useGridForge } from "@/lib/store";

type ClickHandler = ((p: LngLat) => void) | null;
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export function ProjectMapTools({ mapRef, styleGen, clickHandlerRef }: {
  mapRef: RefObject<MLMap | null>; styleGen: number; clickHandlerRef: RefObject<ClickHandler>;
}) {
  const { scenario, updateScenario, selectSite } = useGridForge();
  const [drawing, setDrawing] = useState(false);
  const [first, setFirst] = useState<LngLat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const footprint = scenario?.site.footprint;

  useEffect(() => {
    if (!drawing) { clickHandlerRef.current = null; return; }
    clickHandlerRef.current = (p) => {
      if (!first) { setFirst(p); return; }
      const west = Math.min(first.lon, p.lon), east = Math.max(first.lon, p.lon);
      const south = Math.min(first.lat, p.lat), north = Math.max(first.lat, p.lat);
      if (east - west < 0.0001 || north - south < 0.0001 || east - west > 2 || north - south > 2) {
        setError("Choose opposite corners of a nonzero area, no more than 2° apart."); return;
      }
      const geometry: GeoJSON.Polygon = { type: "Polygon", coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] };
      const center = { lon: (west + east) / 2, lat: (south + north) / 2 };
      // selectSite queues the new site synchronously; attaching a footprint then preserves it
      // while its optional site-card requests complete.
      void selectSite(center);
      updateScenario(s => ({ ...s, site: { ...s.site, footprint: geometry } }));
      setDrawing(false); setFirst(null); setError(null);
    };
    return () => { clickHandlerRef.current = null; };
  }, [drawing, first, clickHandlerRef, selectSite, updateScenario]);

  useEffect(() => {
    const m = mapRef.current;
    if (!m || !styleGen) return;
    const data: GeoJSON.FeatureCollection = footprint ? { type: "FeatureCollection", features: [
      { type: "Feature", geometry: footprint as unknown as GeoJSON.Geometry, properties: {} },
    ] } : EMPTY;
    if (!m.getSource("project-footprint")) {
      m.addSource("project-footprint", { type: "geojson", data });
      m.addLayer({ id: "project-footprint-fill", source: "project-footprint", type: "fill", paint: { "fill-color": "#10b981", "fill-opacity": 0.13 } });
      m.addLayer({ id: "project-footprint-outline", source: "project-footprint", type: "line", paint: { "line-color": "#047857", "line-width": 3 } });
    } else m.getSource<GeoJSONSource>("project-footprint")?.setData(data);
    if (!m.getSource("area-corner")) {
      m.addSource("area-corner", { type: "geojson", data: EMPTY });
      m.addLayer({ id: "area-corner", source: "area-corner", type: "circle", paint: { "circle-radius": 5, "circle-color": "#047857", "circle-stroke-color": "white", "circle-stroke-width": 2 } });
    }
    m.getSource<GeoJSONSource>("area-corner")?.setData(first ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [first.lon, first.lat] }, properties: {} }] } : EMPTY);
  }, [footprint, first, mapRef, styleGen]);

  return <div className="pointer-events-auto w-72 max-w-[calc(100vw-5rem)] rounded-md bg-white/95 p-2 text-xs text-zinc-800 shadow ring-1 ring-black/10 dark:bg-zinc-900/95 dark:text-zinc-100">
    <div className="flex flex-wrap items-center gap-2">
      <button disabled={!styleGen} aria-pressed={drawing} className={`rounded border px-2 py-1 ${drawing ? "border-emerald-700 bg-emerald-50 text-emerald-900" : "border-zinc-300 dark:border-zinc-600"}`}
        onClick={() => { setDrawing(v => !v); setFirst(null); setError(null); }}>{drawing ? "Cancel selection" : "Highlight area"}</button>
    </div>
    {drawing && <p className="mt-1 text-emerald-700">{first ? "Click the opposite corner." : "Click the first corner of a rectangular area."}</p>}
    {error && <p role="alert" className="mt-1 text-red-700">{error}</p>}
    <SelectedZoning mapRef={mapRef} styleGen={styleGen} footprint={footprint} />
  </div>;
}
