"use client";
// "Highlight area" map tool: drag on the map to outline a rectangle (or click two corners), then drag
// the box to move it or its corner and edge handles to resize it. The Plan tab's area panel then
// estimates people and demand in it, and zoning can be loaded for it. Compact on the map: one button,
// with its help text and the zoning controls behind a disclosure. That opens when you press Done, since
// loading zoning is the next step; it stays shut while drawing and editing, as it would cover the box.
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import type { GeoJSONSource, Map as MLMap, MapMouseEvent, MapTouchEvent } from "maplibre-gl";
import { showLeftTabFromMap } from "@/components/shell/sidebarTabs";
import { SelectedZoning } from "./SelectedZoning";
import type { LngLat } from "@/lib/contract";
import { useGridForge } from "@/lib/store";

type ClickHandler = ((p: LngLat) => void) | null;
type Box = { west: number; south: number; east: number; north: number };
type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
type Drag = { kind: "draw" | "move" | "resize"; start: LngLat; x: number; y: number; box: Box; handle?: Handle; moved: boolean; last: Box };
type PointerEvent = MapMouseEvent | MapTouchEvent;

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const HANDLE_PX = 12; // how close the pointer must be to grab a corner or edge handle
const DRAG_PX = 3; // MapLibre's click tolerance: a press that moves further is a drag, not a click
const CURSOR: Record<Handle, string> = {
  nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
};

/** The footprint's lon/lat bounds; the tool only ever stores axis-aligned rectangles. */
function boxOf(geometry: unknown): Box | null {
  const pts: number[][] = [];
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number") pts.push(c as number[]);
    else if (Array.isArray(c)) c.forEach(walk);
  };
  walk((geometry as { coordinates?: unknown } | null)?.coordinates);
  if (!pts.length) return null;
  const lons = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
  return { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
}

const polygon = ({ west, south, east, north }: Box): GeoJSON.Polygon =>
  ({ type: "Polygon", coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] });

const span = (a: LngLat, b: LngLat): Box =>
  ({ west: Math.min(a.lon, b.lon), south: Math.min(a.lat, b.lat), east: Math.max(a.lon, b.lon), north: Math.max(a.lat, b.lat) });

function handles(b: Box): [Handle, number, number][] {
  const lon = (b.west + b.east) / 2, lat = (b.south + b.north) / 2;
  return [["nw", b.west, b.north], ["n", lon, b.north], ["ne", b.east, b.north], ["e", b.east, lat],
    ["se", b.east, b.south], ["s", lon, b.south], ["sw", b.west, b.south], ["w", b.west, lat]];
}

/** Drag one handle to p; the opposite side stays put, and crossing over flips the box instead of inverting it. */
function resized(b: Box, h: Handle, p: LngLat): Box {
  const r = { ...b };
  if (h.includes("w")) r.west = p.lon;
  if (h.includes("e")) r.east = p.lon;
  if (h.includes("n")) r.north = p.lat;
  if (h.includes("s")) r.south = p.lat;
  return { west: Math.min(r.west, r.east), east: Math.max(r.west, r.east), south: Math.min(r.south, r.north), north: Math.max(r.south, r.north) };
}

const invalid = (b: Box): string | null =>
  b.east - b.west < 0.0001 || b.north - b.south < 0.0001 || b.east - b.west > 2 || b.north - b.south > 2
    ? "Outline a nonzero area, no more than 2° across." : null;

const lngLat = (e: PointerEvent): LngLat => { const ll = e.lngLat.wrap(); return { lon: ll.lng, lat: ll.lat }; };

/** What the pointer is over: a handle (within HANDLE_PX of it on screen), the box itself, or nothing. Works on a rotated map. */
function hitTest(m: MLMap, b: Box, x: number, y: number): Handle | "inside" | null {
  for (const [h, lon, lat] of handles(b)) {
    const p = m.project([lon, lat]);
    if (Math.hypot(p.x - x, p.y - y) <= HANDLE_PX) return h;
  }
  const c = [[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north]].map(([lon, lat]) => m.project([lon, lat]));
  const sides = c.map((p, i) => { const q = c[(i + 1) % 4]; return Math.sign((q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x)); });
  return sides.every((s) => s >= 0) || sides.every((s) => s <= 0) ? "inside" : null;
}

export function ProjectMapTools({ mapRef, styleGen, clickHandlerRef }: {
  mapRef: RefObject<MLMap | null>; styleGen: number; clickHandlerRef: RefObject<ClickHandler>;
}) {
  const { scenario, updateScenario, selectSite } = useGridForge();
  const [drawing, setDrawing] = useState(false);
  const [editing, setEditingState] = useState(false);
  const [first, setFirst] = useState<LngLat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const footprint = scenario?.site.footprint;
  const box = useMemo(() => (footprint ? boxOf(footprint) : null), [footprint]);
  const edit = editing && !!box;

  // The box is the area: the site moves to its center and the Plan tab re-estimates for it.
  const commit = (b: Box) => {
    // selectSite queues the new site synchronously; attaching a footprint then preserves it
    // while its optional site-card requests complete.
    void selectSite({ lon: (b.west + b.east) / 2, lat: (b.south + b.north) / 2 });
    updateScenario((s) => ({ ...s, site: { ...s.site, footprint: polygon(b) } }));
    setError(null);
  };
  const finishDrawing = (b: Box) => {
    const why = invalid(b);
    if (why) { setError(why); return; }
    commit(b);
    setDrawing(false); setFirst(null);
    setEditingState(true); // handles appear so the new box can be nudged straight away
    showLeftTabFromMap("plan"); // the area's people and demand estimate (if that doesn't move the map)
  };
  // The map listeners below stay subscribed through a drag; they read the latest box and actions here.
  const latest = useRef({ box, commit, finishDrawing });
  useEffect(() => { latest.current = { box, commit, finishDrawing }; });

  // Two clicks still work while drawing: the first corner, then the opposite one.
  useEffect(() => {
    if (!drawing) { clickHandlerRef.current = null; return; }
    clickHandlerRef.current = (p) => {
      if (!first) { setFirst(p); return; }
      latest.current.finishDrawing(span(first, p));
    };
    return () => { clickHandlerRef.current = null; };
  }, [drawing, first, clickHandlerRef]);

  // Dragging: a new box while drawing; while editing, the box (move) or a handle (resize). A press
  // anywhere else pans the map as usual. Changes are committed on release, not on every move.
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !styleGen || (!drawing && !edit)) return;
    const canvas = m.getCanvas();
    let drag: Drag | null = null;
    const setCursor = (c: string | null) => {
      if (c) canvas.dataset.areaCursor = c; else delete canvas.dataset.areaCursor;
      canvas.style.cursor = c ?? "";
    };
    const preview = (b: Box) => {
      m.getSource<GeoJSONSource>("project-footprint")?.setData({ type: "Feature", geometry: polygon(b), properties: {} });
      m.getSource<GeoJSONSource>("area-handles")?.setData(drag?.kind === "draw" ? EMPTY : handlePoints(b));
    };
    const onDown = (e: PointerEvent) => {
      if ("points" in e && e.points.length > 1) return; // pinch-zoom stays with the map
      const b = latest.current.box;
      if (drawing) {
        e.preventDefault(); // no pan: this press outlines the box
        const p = lngLat(e);
        drag = { kind: "draw", start: p, x: e.point.x, y: e.point.y, box: span(p, p), moved: false, last: span(p, p) };
        return;
      }
      if (!b) return;
      const hit = hitTest(m, b, e.point.x, e.point.y);
      if (!hit) return;
      e.preventDefault();
      drag = { kind: hit === "inside" ? "move" : "resize", handle: hit === "inside" ? undefined : hit, start: lngLat(e), x: e.point.x, y: e.point.y, box: b, moved: false, last: b };
      setCursor(hit === "inside" ? "grabbing" : CURSOR[hit]);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) {
        const b = latest.current.box;
        if (edit && b) {
          const hit = hitTest(m, b, e.point.x, e.point.y);
          setCursor(hit === "inside" ? "move" : hit ? CURSOR[hit] : null);
        }
        return;
      }
      if (!drag.moved && Math.hypot(e.point.x - drag.x, e.point.y - drag.y) <= DRAG_PX) return;
      drag.moved = true;
      const p = lngLat(e), b = drag.box;
      drag.last = drag.kind === "draw" ? span(drag.start, p)
        : drag.kind === "move" ? { west: b.west + p.lon - drag.start.lon, east: b.east + p.lon - drag.start.lon, south: b.south + p.lat - drag.start.lat, north: b.north + p.lat - drag.start.lat }
        : resized(b, drag.handle!, p);
      preview(drag.last);
    };
    const onUp = () => {
      const d = drag;
      drag = null;
      if (!d) return;
      setCursor(edit ? "move" : null);
      if (!d.moved) return; // a click: while drawing it is a corner (handled by the click handler above)
      if (d.kind === "draw") { latest.current.finishDrawing(d.last); return; }
      const why = invalid(d.last);
      if (why) { setError(why); preview(d.box); return; }
      latest.current.commit(d.last);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (drawing) { setDrawing(false); setFirst(null); } else setEditingState(false);
    };
    if (drawing) setCursor("crosshair");
    m.on("mousedown", onDown); m.on("touchstart", onDown);
    m.on("mousemove", onMove); m.on("touchmove", onMove);
    m.on("mouseup", onUp); m.on("touchend", onUp);
    window.addEventListener("mouseup", onUp); // released outside the map
    window.addEventListener("keydown", onKey);
    return () => {
      m.off("mousedown", onDown); m.off("touchstart", onDown);
      m.off("mousemove", onMove); m.off("touchmove", onMove);
      m.off("mouseup", onUp); m.off("touchend", onUp);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
      setCursor(null);
    };
  }, [drawing, edit, mapRef, styleGen]);

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
    if (!m.getSource("area-handles")) {
      m.addSource("area-handles", { type: "geojson", data: EMPTY });
      m.addLayer({ id: "area-handles", source: "area-handles", type: "circle", paint: { "circle-radius": 5.5, "circle-color": "white", "circle-stroke-color": "#047857", "circle-stroke-width": 2.5 } });
    }
    m.getSource<GeoJSONSource>("area-handles")?.setData(edit && box ? handlePoints(box) : EMPTY);
    if (!m.getSource("area-corner")) {
      m.addSource("area-corner", { type: "geojson", data: EMPTY });
      m.addLayer({ id: "area-corner", source: "area-corner", type: "circle", paint: { "circle-radius": 5, "circle-color": "#047857", "circle-stroke-color": "white", "circle-stroke-width": 2 } });
    }
    m.getSource<GeoJSONSource>("area-corner")?.setData(first ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [first.lon, first.lat] }, properties: {} }] } : EMPTY);
  }, [footprint, box, first, edit, mapRef, styleGen]);

  const label = drawing ? "Cancel" : edit ? "Done" : box ? "Edit area" : "Highlight area";
  const onMain = () => {
    setError(null); setFirst(null);
    if (drawing) setDrawing(false);
    else if (edit) { setEditingState(false); setExpanded(true); } // show "Load zoning for area", the next step
    else if (box) setEditingState(true);
    else setDrawing(true);
  };
  const chip = "pointer-events-auto rounded-md bg-white/95 text-xs text-zinc-800 shadow ring-1 ring-black/10 dark:bg-zinc-900/95 dark:text-zinc-100 dark:ring-white/10";
  return <div className="flex flex-col items-start gap-1">
    <div className={`${chip} flex overflow-hidden`}>
      <button type="button" disabled={!styleGen} aria-pressed={drawing || edit}
        className={`px-2.5 py-1 font-medium disabled:opacity-40 ${drawing || edit ? "bg-emerald-700 text-white dark:bg-cyan-300 dark:text-slate-950" : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"}`}
        onClick={onMain}>{label}</button>
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
    {drawing && <p role="status" className={`${chip} px-2 py-1 text-emerald-800 dark:text-emerald-300`}>{first ? "Click the opposite corner." : "Drag on the map to outline an area, or click two corners."}</p>}
    {edit && <p role="status" className={`${chip} max-w-72 px-2 py-1 text-emerald-800 dark:text-emerald-300`}>
      Drag the box to move it, or a corner or edge to resize it.{" "}
      <button type="button" className="font-medium underline" onClick={() => { setEditingState(false); setFirst(null); setDrawing(true); }}>Redraw</button>
    </p>}
    {error && <p role="alert" className={`${chip} max-w-72 px-2 py-1 text-red-700 dark:text-red-400`}>{error}</p>}
    {/* Always mounted (hidden when folded): SelectedZoning owns the zoning layer and its loaded zones. */}
    <div id={detailsId} hidden={!expanded} className={`${chip} w-72 max-w-full p-2`}>
      <p className="text-[11px] leading-snug text-zinc-600 dark:text-zinc-300">
        Drag on the map to outline a rectangle (or click two opposite corners). Then drag the box to move it, or its corners and edges to resize it. The Plan tab estimates the residents, households and electricity demand inside it.
      </p>
      <SelectedZoning mapRef={mapRef} styleGen={styleGen} footprint={footprint} />
    </div>
  </div>;
}

function handlePoints(b: Box): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: handles(b).map(([h, lon, lat]) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { handle: h } })) };
}
