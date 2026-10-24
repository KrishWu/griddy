"use client";
// Interactive grid map.  OWNER: workstream A (Explore / GIS).
// STUB: basemap + the four /api/layers + click-to-select-site + overlays from other modules.
import { useEffect, useRef, useState } from "react";
import type { Map as MLMap, GeoJSONSource } from "maplibre-gl";

import { api } from "@/lib/api";
import type { LngLat } from "@/lib/contract";
import { useGridForge } from "@/lib/store";

const BASEMAP = "https://tiles.openfreemap.org/styles/positron";

function siteFeature(p?: LngLat): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: p ? [{ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: {} }] : [],
  };
}

export function MapView() {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const { scenario, selectSite, overlays } = useGridForge();
  const center = scenario?.site.location;
  const centerRef = useRef(center);
  const [ready, setReady] = useState(false); // our layers exist; overlays can be drawn
  const drawn = useRef(new Map<string, string>()); // overlay id -> signature currently on the map

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const maplibregl = await import("maplibre-gl");
      if (cancelled || !el.current || map.current) return;
      maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs"); // copied to public/ by npm postinstall
      const m = new maplibregl.Map({ container: el.current, style: BASEMAP, center: [-119.47, 35.4], zoom: 7 });
      map.current = m;
      m.addControl(new maplibregl.NavigationControl(), "top-right");
      m.on("load", async () => {
        const [plants, lines, subs] = await Promise.all([api.layer("plants"), api.layer("transmission"), api.layer("substations")]);
        m.addSource("transmission", { type: "geojson", data: lines });
        m.addLayer({ id: "transmission", type: "line", source: "transmission", paint: { "line-color": "#7c3aed", "line-width": 2 } });
        m.addSource("substations", { type: "geojson", data: subs });
        m.addLayer({ id: "substations", type: "circle", source: "substations", paint: { "circle-radius": 5, "circle-color": "#7c3aed" } });
        m.addSource("plants", { type: "geojson", data: plants });
        m.addLayer({ id: "plants", type: "circle", source: "plants", paint: { "circle-radius": 6, "circle-color": "#f59e0b", "circle-stroke-width": 1, "circle-stroke-color": "#fff" } });
        m.addSource("site", { type: "geojson", data: siteFeature(centerRef.current) });
        m.addLayer({ id: "site", type: "circle", source: "site", paint: { "circle-radius": 9, "circle-color": "#10b981", "circle-stroke-width": 2, "circle-stroke-color": "#fff" } });
        setReady(true);
      });
      m.on("click", (e) => selectSite({ lon: e.lngLat.lng, lat: e.lngLat.lat }));
    })();
    const overlaysOnMap = drawn.current;
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      overlaysOnMap.clear();
      setReady(false);
    };
  }, [selectSite]);

  // Keep the selected-site marker in sync with the scenario.
  useEffect(() => {
    centerRef.current = center;
    (map.current?.getSource("site") as GeoJSONSource | undefined)?.setData(siteFeature(center));
  }, [center]);

  // Draw overlays published by other modules (e.g. satellite imagery from workstream E).
  // Waits until our layers exist, then syncs by id: changed or vanished overlays are removed.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const want = new Map(overlays.map((o) => [o.id, JSON.stringify([o.type, o.url, o.data, o.opacity])]));
    for (const [id, sig] of drawn.current) {
      if (want.get(id) === sig) continue;
      if (m.getLayer(`ov-${id}`)) m.removeLayer(`ov-${id}`);
      if (m.getSource(`ov-${id}`)) m.removeSource(`ov-${id}`);
      drawn.current.delete(id);
    }
    for (const o of overlays) {
      if (drawn.current.has(o.id)) continue;
      try {
        if (o.type === "raster" && o.url) {
          // Relative URLs (e.g. E's cached tiles at /api/...) must be absolute for the map
          // worker; plain concatenation keeps the {z}/{x}/{y} placeholders unencoded.
          const url = o.url.startsWith("/") ? window.location.origin + o.url : o.url;
          m.addSource(`ov-${o.id}`, { type: "raster", tiles: [url], tileSize: 256, attribution: o.attribution ?? undefined });
          // If you rename or split the transmission layer, update this beforeId.
          const below = m.getLayer("transmission") ? "transmission" : undefined; // keep grid lines on top
          m.addLayer({ id: `ov-${o.id}`, type: "raster", source: `ov-${o.id}`, paint: { "raster-opacity": o.opacity ?? 0.8 } }, below);
        } else if (o.type === "geojson" && o.data) {
          m.addSource(`ov-${o.id}`, { type: "geojson", data: o.data });
          m.addLayer({ id: `ov-${o.id}`, type: "fill", source: `ov-${o.id}`, paint: { "fill-color": "#10b981", "fill-opacity": (o.opacity ?? 0.8) * 0.4 } });
        }
        if (m.getLayer(`ov-${o.id}`)) drawn.current.set(o.id, want.get(o.id)!);
      } catch (err) {
        console.warn(`overlay ${o.id} failed; will retry on the next change`, err);
        if (m.getLayer(`ov-${o.id}`)) m.removeLayer(`ov-${o.id}`);
        if (m.getSource(`ov-${o.id}`)) m.removeSource(`ov-${o.id}`);
      }
    }
  }, [overlays, ready]);

  return <div ref={el} className="h-full w-full" />;
}
