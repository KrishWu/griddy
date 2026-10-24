"use client";
// "Highlight area" map tool: click two corners to outline a rectangle; the Plan tab's area panel then
// estimates people and demand in it. Controls render inside that panel while drawing stays on the map.
import { useEffect, useId, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useAreaTools } from "./areaTools";
import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";
import { showLeftTabFromMap } from "@/components/shell/sidebarTabs";
import { SelectedZoning } from "./SelectedZoning";
import type { LngLat } from "@/lib/contract";
import { useGridForge } from "@/lib/store";

type ClickHandler = ((p: LngLat) => void) | null;
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export function ProjectMapTools({ mapRef, styleGen, clickHandlerRef }: {
  mapRef: RefObject<MLMap | null>; styleGen: number; clickHandlerRef: RefObject<ClickHandler>;
}) {
  const { scenario, updateScenario, selectSite } = useGridForge();
  const { host } = useAreaTools();
  const [drawing, setDrawing] = useState(false);
  const [first, setFirst] = useState<LngLat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
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
      setExpanded(true); // show "Load zoning for area", the next step
      showLeftTabFromMap("plan"); // the area's people and demand estimate (if that doesn't move the map)
    };
    return () => { clickHandlerRef.current = null; };
  }, [drawing, first, clickHandlerRef, selectSite, updateScenario]);

  useEffect(() => {
    if (!drawing) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setDrawing(false); setFirst(null); setError(null); }
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [drawing]);

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

  if (!host) return null;
  const chip = "rounded-md border border-zinc-200 text-xs text-zinc-800 dark:border-zinc-700 dark:text-zinc-100";
  return createPortal(<div className="flex flex-col items-start gap-1">
    <div className={`${chip} flex overflow-hidden`}>
      <button type="button" disabled={!styleGen} aria-pressed={drawing}
        className={`px-2.5 py-1 font-medium disabled:opacity-40 ${drawing ? "bg-emerald-700 text-white dark:bg-cyan-300 dark:text-slate-950" : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"}`}
        onClick={() => {
          if (!drawing) { mapRef.current?.getContainer().scrollIntoView({ block: "center" }); mapRef.current?.getCanvas().focus({ preventScroll: true }); }
          setDrawing(v => !v); setFirst(null); setError(null);
        }}>{drawing ? "Cancel selection" : "Highlight area"}</button>
      <button type="button" aria-expanded={expanded} aria-controls={detailsId}
        aria-label={expanded ? "Hide Highlight area help and zoning" : "Show Highlight area help and zoning"}
        title={expanded ? "Hide help and zoning" : "What is this? · zoning"}
        className="border-l border-zinc-200 px-2 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        onClick={() => setExpanded(v => !v)}>
        <svg viewBox="0 0 16 16" className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden>
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
    {drawing && <p role="status" className={`${chip} px-2 py-1 text-emerald-800 dark:text-emerald-300`}>{first ? "Click the opposite corner." : "Click the first corner of a rectangular area."}</p>}
    {error && <p role="alert" className={`${chip} max-w-72 px-2 py-1 text-red-700 dark:text-red-400`}>{error}</p>}
    {/* Always mounted (hidden when folded): SelectedZoning owns the zoning layer and its loaded zones. */}
    <div id={detailsId} hidden={!expanded} className={`${chip} w-72 max-w-full p-2`}>
      <p className="text-[11px] leading-snug text-zinc-600 dark:text-zinc-300">
        Click two opposite corners on the map to select an area.
      </p>
      <SelectedZoning mapRef={mapRef} styleGen={styleGen} footprint={footprint} />
    </div>
  </div>, host);
}
