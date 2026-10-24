"use client";
// Interactive grid map.  OWNER: workstream A (Explore / GIS).
// California grid layers (EIA-860 plants, CEC transmission, OSM substations, Census counties,
// CEC utility territories, LBNL interconnection queue by county), 2.5D footprints of the
// scenario's assets, popups, click-to-select-site, overlays from other modules,
// layer toggles + legend, and a bundled fallback basemap if the tile provider is down.
// Our sources/layers are (re)added on every 'style.load', so a basemap swap keeps them.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GeoJSONSource, LngLat as MLLngLat, Map as MLMap, MapGeoJSONFeature, Popup } from "maplibre-gl";

import { api, request } from "@/lib/api";
import type { Asset, Catalog, LngLat, SiteSummary } from "@/lib/contract";
import { useGridForge } from "@/lib/store";

import { footprintBounds, footprintsFC, loadCatalog } from "./footprints";
import { CA_BOUNDS, EMPTY_FC, circleRing, locKey, num } from "./geo";
import { LayerControl, type LayerStatus } from "./LayerControl";
import {
  AREA_LAYER_IDS,
  BASEMAP,
  CLICKABLE_LAYER_IDS,
  DATA_KEYS,
  DEFAULT_VISIBLE,
  INLINE_FALLBACK_STYLE,
  LAYERS,
  LAYER_IDS,
  LOCAL_SOURCES,
  SOURCE_ATTRIBUTION,
  asStyle,
  groupLayerIds,
  type DataKey,
  type LayerGroup,
  type LocalSource,
} from "./mapStyle";
import { popupContent } from "./popup";
import { readSummary, trackSiteSelection, useSiteSummary } from "./useSiteSummary";

type FC = GeoJSON.FeatureCollection;

const STYLE_TIMEOUT_MS = 8000;
const STYLE_PROBE_MS = 10000; // after the timeout, how long the basemap style URL gets to answer before we give up
const HIT_PX = 5; // query box half-size, so thin lines are clickable
const HOVER_LAYER_IDS = CLICKABLE_LAYER_IDS.filter((id) => !AREA_LAYER_IDS.includes(id)); // a fill would make every pixel "clickable"
const SITE_ZOOM = 9; // the 25 km ring fits comfortably
const SELECT_DELAY_MS = 250; // wait this long after a click on empty map, so a double-click zooms instead of moving the site
const FOOTPRINT_PITCH = 50;
const REFRAME_DELAY_MS = 300; // footprints on: refit this long after the asset set or site settles

/** Queue status from the boundaries layer: counties with active requests, or "unavailable" when the
 *  backend's queue file is missing (no county carries queue_active_mw). */
function queueStatus(fc: FC): number | "unavailable" {
  if (!fc.features.some((f) => num(f.properties?.queue_active_mw) !== null)) return "unavailable";
  return fc.features.filter((f) => (num(f.properties?.queue_active_projects) ?? 0) > 0).length;
}

type Padding = { top: number; right: number; bottom: number; left: number };

// D's AppShell floats the Site cards over the map from this viewport width (its LARGE query), as
// "absolute bottom-8 left-3 w-80 max-h-[55%]"; they reach that max height once the site summary and
// site intelligence load. Below it they sit in the sidebar. Map pixels throughout.
const FLOATING_CARDS_QUERY = "(min-width: 1024px)";
const CARDS = { left: 12, width: 320, bottom: 32, maxShare: 0.55 };
// The layers card wrapper below: right-2.5 top-[106px], holding the w-56 LayerControl.
const LAYERS_CARD = { right: 10, top: 106, width: 224 };

function siteCardsRect(h: number): { right: number; top: number } | null {
  if (typeof window === "undefined" || !window.matchMedia(FLOATING_CARDS_QUERY).matches) return null;
  return { right: CARDS.left + CARDS.width, top: h - CARDS.bottom - CARDS.maxShare * h };
}

/** Layers card max height: 45% of the map, clear of the scale bar; but when the map is too narrow for it to
 *  sit beside the floating Site cards (which paint on top), it stops above them so its toggles stay clickable.
 *  An overlap up to 8 px is fine: the card's 12 px left padding keeps the checkboxes clear. */
function layersMaxHeight(w: number, h: number): number {
  const base = Math.min(0.45 * h, h - 176);
  const cards = siteCardsRect(h);
  if (!cards || cards.right - (w - LAYERS_CARD.right - LAYERS_CARD.width) <= 8) return base;
  return Math.max(96, Math.min(base, cards.top - 8 - LAYERS_CARD.top));
}

/** Camera padding for framing footprints: the largest clear rectangle of the map, away from the view
 *  buttons (top-left), the layers card (top-right), D's floating Site cards (bottom-left) and the scale bar.
 *  Extra room at the bottom covers what the pitch and extrusions push below the fitted bounds. */
function framePadding(m: MLMap): Padding {
  const { clientWidth: w, clientHeight: h } = m.getContainer();
  const cards = siteCardsRect(h);
  const layersLeft = w - LAYERS_CARD.right - LAYERS_CARD.width;
  const layersBottom = LAYERS_CARD.top + layersMaxHeight(w, h);
  const gap = 12;
  const top = 48; // below the view buttons
  const floor = 40; // scale bar and attribution
  const aboveCards = cards ? h - cards.top + gap : floor;
  const candidates: Padding[] = [
    { top, left: gap, right: w - layersLeft + gap, bottom: aboveCards }, // beside the layers card
    { top: layersBottom + gap, left: cards ? cards.right + gap : gap, right: gap, bottom: floor }, // below it
    { top: layersBottom + gap, left: gap, right: gap, bottom: aboveCards }, // between it and the cards
  ];
  const size = (p: Padding) => [w - p.left - p.right, h - p.top - p.bottom] as const;
  const area = (p: Padding) => Math.max(0, size(p)[0]) * Math.max(0, size(p)[1]);
  const best = candidates.reduce((a, b) => (area(b) > area(a) ? b : a));
  const [bw, bh] = size(best);
  if (bw >= 120 && bh >= 100) return { ...best, bottom: best.bottom + Math.round(Math.min(0.08 * h, 0.25 * bh)) };
  // No clear rectangle (a map under ~380 px with floating cards): stay above the Site cards, which can't
  // be moved, and accept the layers card, which folds.
  if (cards && h - top - aboveCards >= 100) return { top, left: gap, right: gap, bottom: aboveCards };
  return { top: 40, right: 40, bottom: 40, left: 40 };
}

// One fetch per layer per page load, shared across remounts (StrictMode, error-boundary resets).
const layerCache = new Map<DataKey, Promise<FC>>();
function loadLayer(key: DataKey): Promise<FC> {
  let p = layerCache.get(key);
  if (!p) {
    // `utilities` isn't in api.layer's union type; same endpoint family.
    p = (key === "utilities" ? request<FC>("/layers/utilities") : api.layer(key)).then((fc) => {
      if (fc?.type !== "FeatureCollection" || !Array.isArray(fc.features)) throw new Error(`/layers/${key} is not a FeatureCollection`);
      return fc;
    });
    layerCache.set(key, p);
    p.catch(() => layerCache.delete(key));
  }
  return p;
}

const emptyFC = (): FC => ({ type: "FeatureCollection", features: [] });

function siteFC(p: LngLat | undefined, name: string | undefined): FC {
  return {
    type: "FeatureCollection",
    features: p
      ? [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [p.lon, p.lat] },
            properties: { id: "site", name: name ?? "Selected site", coords: `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}` },
          },
        ]
      : [],
  };
}

function assetsFC(assets: Asset[] | undefined): FC {
  const features: GeoJSON.Feature[] = [];
  for (const a of assets ?? []) {
    const loc = a.location;
    if (!loc || !Number.isFinite(loc.lon) || !Number.isFinite(loc.lat)) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [loc.lon, loc.lat] },
      properties: { id: a.id, name: a.name ?? null, kind: a.kind, capacity_mw: a.capacity_mw, duration_h: a.duration_h ?? null },
    });
  }
  return { type: "FeatureCollection", features };
}

/** 25 km ring around the site plus dashed links to the nearest 220 kV+ substation and line. */
function contextFC(p: LngLat | undefined, summary: SiteSummary | null): FC {
  if (!p) return EMPTY_FC;
  const features: GeoJSON.Feature[] = [
    { type: "Feature", geometry: { type: "Polygon", coordinates: [circleRing(p, 25)] }, properties: { id: "ring-25km", kind: "ring" } },
  ];
  const v = summary ? readSummary(summary) : null;
  if (v && v.inCalifornia !== false) {
    const from = [p.lon, p.lat];
    const targets: [string, LngLat | null | undefined][] = [
      ["link-substation", v.hvSubstation?.location],
      ["link-line", v.hvLine?.point],
    ];
    for (const [id, to] of targets) {
      if (to) features.push({ type: "Feature", geometry: { type: "LineString", coordinates: [from, [to.lon, to.lat]] }, properties: { id, kind: "link" } });
    }
  }
  return { type: "FeatureCollection", features };
}

export function MapView() {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const { scenario, selectSite, overlays } = useGridForge();
  const { summary } = useSiteSummary();
  const center = scenario?.site.location;
  const siteName = scenario?.site.name;
  const assets = scenario?.assets;

  // >0 once our layers exist on the current style (overlays can be drawn); bumps on every style load.
  const [styleGen, setStyleGen] = useState(0);
  const ready = styleGen > 0;
  const drawn = useRef(new Map<string, string>()); // overlay id -> signature currently on the map
  const [visible, setVisible] = useState(DEFAULT_VISIBLE);
  const [hiddenOverlays, setHiddenOverlays] = useState<ReadonlySet<string>>(() => new Set());
  const [status, setStatus] = useState<LayerStatus>({});
  const [fallback, setFallback] = useState(false);
  const retryBasemap = useRef<(() => void) | null>(null);
  // Map size, so the layers card can stop above D's floating Site cards when the map is narrow.
  const [layersMaxH, setLayersMaxH] = useState<number | null>(null);
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const ro = new ResizeObserver(() => setLayersMaxH(Math.round(layersMaxHeight(node.clientWidth, node.clientHeight))));
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  // Latest values for map event handlers (they're registered once).
  const selectRef = useRef(selectSite);
  const visibleRef = useRef(visible);
  const hiddenOverlaysRef = useRef(hiddenOverlays);
  const layerData = useRef<Partial<Record<DataKey, FC>>>({});
  const localData = useRef<Record<LocalSource, FC>>({ "site-context": EMPTY_FC, assets: EMPTY_FC, site: EMPTY_FC, footprints: EMPTY_FC });
  const [catalog, setCatalog] = useState<Catalog | "error" | null>(null);
  // View state: ease to the site once, unless the user already moved the map.
  const userMoved = useRef(false);
  const didInitialEase = useRef(false);
  const lastCenterKey = useRef<string | null>(null);
  const clickedKey = useRef<string | null>(null);

  useEffect(() => {
    selectRef.current = selectSite;
  }, [selectSite]);

  useEffect(() => {
    let cancelled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let selectTimer: ReturnType<typeof setTimeout> | undefined;
    let popup: Popup | null = null;
    let raf = 0;
    let gen = 0;

    // Fetch every layer in parallel right away (alongside the MapLibre chunk); add each as it arrives.
    for (const key of DATA_KEYS) {
      loadLayer(key).then(
        (fc) => {
          if (cancelled) return;
          layerData.current[key] = fc;
          map.current?.getSource<GeoJSONSource>(key)?.setData(fc);
          setStatus((s) => ({ ...s, [key]: fc.features.length, ...(key === "boundaries" ? { queue: queueStatus(fc) } : {}) }));
        },
        (err: unknown) => {
          if (cancelled) return;
          console.warn(`layer ${key} failed to load`, err);
          setStatus((s) => ({ ...s, [key]: "error", ...(key === "boundaries" ? { queue: "error" as const } : {}) }));
        },
      );
    }
    // C's technology catalog (land per MW) sizes the 2.5D footprints; without it that toggle is unavailable.
    loadCatalog().then(
      (c) => {
        if (!cancelled) setCatalog(c);
      },
      (err: unknown) => {
        if (cancelled) return;
        console.warn("catalog failed to load; asset footprints unavailable", err);
        setCatalog("error");
      },
    );

    (async () => {
      const maplibregl = await import("maplibre-gl");
      if (cancelled || !el.current || map.current) return;
      maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs"); // copied to public/ by npm postinstall
      const m = new maplibregl.Map({
        container: el.current,
        style: BASEMAP,
        bounds: CA_BOUNDS,
        fitBoundsOptions: { padding: 24 },
        attributionControl: { compact: true },
      });
      map.current = m;
      m.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");
      m.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

      // (Re)add our sources + layers; runs on every style load (initial basemap or fallback).
      const install = () => {
        for (const key of DATA_KEYS) {
          if (!m.getSource(key)) m.addSource(key, { type: "geojson", data: layerData.current[key] ?? emptyFC(), attribution: SOURCE_ATTRIBUTION[key] });
        }
        for (const id of LOCAL_SOURCES) {
          if (!m.getSource(id)) m.addSource(id, { type: "geojson", data: localData.current[id] });
        }
        for (const { spec, group } of LAYERS) {
          try {
            if (!m.getLayer(spec.id)) m.addLayer(spec);
            if (group && !visibleRef.current[group]) m.setLayoutProperty(spec.id, "visibility", "none");
          } catch (err) {
            console.error(`layer ${spec.id} could not be added`, err);
          }
        }
      };

      let styleLoaded = false;
      let swapping = false;
      const swapToFallback = async (reason: string) => {
        if (swapping || cancelled) return;
        swapping = true;
        clearTimeout(fallbackTimer);
        console.warn(`Basemap unavailable (${reason}); switching to the bundled fallback style.`);
        const fetched = await request<unknown>("/explore/fallback-style").then(asStyle, () => null);
        if (cancelled || map.current !== m || styleLoaded) return; // the real basemap made it after all
        drawn.current.clear();
        setStyleGen(0);
        setFallback(true);
        m.setStyle(fetched ?? INLINE_FALLBACK_STYLE, { diff: false }); // full rebuild -> 'style.load'
      };
      // Slow is not down (venue Wi-Fi, a busy laptop): after the timeout, fall back only if the
      // basemap's style URL is actually unreachable. Real load errors fall back right away (below).
      const probeThenSwap = async () => {
        if (styleLoaded) return;
        const reachable = await fetch(BASEMAP, { signal: AbortSignal.timeout(STYLE_PROBE_MS) }).then((r) => r.ok, () => false);
        if (!reachable && !styleLoaded) void swapToFallback(`basemap unreachable after ${STYLE_TIMEOUT_MS / 1000} s`);
      };
      const armFallbackTimer = () => {
        clearTimeout(fallbackTimer);
        fallbackTimer = setTimeout(() => void probeThenSwap(), STYLE_TIMEOUT_MS);
      };
      armFallbackTimer();
      retryBasemap.current = () => {
        if (cancelled || map.current !== m) return;
        styleLoaded = false;
        swapping = false;
        drawn.current.clear();
        setStyleGen(0);
        setFallback(false);
        m.setStyle(BASEMAP, { diff: false }); // errors or a dead URL land back on the fallback
        armFallbackTimer();
      };

      m.on("error", (e) => {
        if (!styleLoaded) void swapToFallback(e.error?.message ?? "style error");
        else console.error("map error", e.error); // keep MapLibre's default logging
      });
      m.on("style.load", () => {
        styleLoaded = true;
        clearTimeout(fallbackTimer);
        install();
        drawn.current.clear(); // overlays belonged to the previous style
        setStyleGen(++gen);
      });

      const hitsAt = (pt: { x: number; y: number }, layers: string[]): MapGeoJSONFeature[] => {
        const present = layers.filter((id) => m.getLayer(id)); // querying a missing layer is an error
        if (!present.length) return [];
        return m.queryRenderedFeatures(
          [
            [pt.x - HIT_PX, pt.y - HIT_PX],
            [pt.x + HIT_PX, pt.y + HIT_PX],
          ],
          { layers: present },
        );
      };
      const openPopup = (f: MapGeoJSONFeature, at: MLLngLat): Popup => {
        const g = f.geometry;
        const anchor: [number, number] = g.type === "Point" ? [g.coordinates[0], g.coordinates[1]] : [at.lng, at.lat];
        return new maplibregl.Popup({ closeOnClick: false, maxWidth: "280px", offset: 8, className: "z-20" }) // above the z-10 layers card
          .setLngLat(anchor)
          .setDOMContent(popupContent(f.layer.id, f.properties))
          .addTo(m);
      };

      m.on("click", (e) => {
        userMoved.current = true;
        clearTimeout(selectTimer);
        popup?.remove();
        popup = null;
        const hits = hitsAt(e.point, CLICKABLE_LAYER_IDS); // topmost first
        const feature = hits.find((f) => !AREA_LAYER_IDS.includes(f.layer.id));
        if (feature) {
          popup = openPopup(feature, e.lngLat);
          return;
        }
        if (e.originalEvent.detail > 1) return; // 2nd click of a double-click: the map zooms instead
        // Empty map (or only an area fill): select a site here, unless a double-click follows, then
        // show the topmost area's popup (a queue county above a utility territory).
        const ll = e.lngLat.wrap(); // a click on a world copy still means -180..180
        const p = { lon: ll.lng, lat: ll.lat };
        const area = hits.find((f) => AREA_LAYER_IDS.includes(f.layer.id));
        selectTimer = setTimeout(() => {
          clickedKey.current = locKey(p);
          trackSiteSelection(p, selectRef.current(p));
          if (area) popup = openPopup(area, e.lngLat);
        }, SELECT_DELAY_MS);
      });
      m.on("dblclick", () => clearTimeout(selectTimer));

      let hoverPt = { x: 0, y: 0 };
      m.on("mousemove", (e) => {
        hoverPt = e.point;
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (map.current !== m) return;
          m.getCanvas().style.cursor = hitsAt(hoverPt, HOVER_LAYER_IDS).length ? "pointer" : "";
        });
      });
      m.on("mouseout", () => {
        m.getCanvas().style.cursor = "";
      });
      m.on("movestart", (e) => {
        if (e.originalEvent) userMoved.current = true; // drag / wheel / touch, not our own easeTo
      });
    })();

    const overlaysOnMap = drawn.current;
    return () => {
      cancelled = true;
      retryBasemap.current = null;
      clearTimeout(fallbackTimer);
      clearTimeout(selectTimer);
      if (raf) cancelAnimationFrame(raf);
      popup?.remove();
      map.current?.remove();
      map.current = null;
      overlaysOnMap.clear();
      lastCenterKey.current = null;
      didInitialEase.current = false;
      setStyleGen(0);
    };
  }, []);

  // Client-side sources: selected site, placed assets, site context (ring + links), asset footprints
  // (live with the scenario's capacities, e.g. D's sliders).
  const site = useMemo(() => siteFC(center, siteName), [center, siteName]);
  const placed = useMemo(() => assetsFC(assets), [assets]);
  const context = useMemo(() => contextFC(center, summary), [center, summary]);
  const footprints = useMemo(() => (catalog && catalog !== "error" ? footprintsFC(assets, center, catalog) : EMPTY_FC), [assets, center, catalog]);
  useEffect(() => {
    localData.current = { site, assets: placed, "site-context": context, footprints };
    const m = map.current;
    if (!m) return;
    for (const id of LOCAL_SOURCES) m.getSource<GeoJSONSource>(id)?.setData(localData.current[id]);
  }, [site, placed, context, footprints]);

  // Camera: ease to the site the first time it is known (unless the user already moved);
  // later, follow it only if it changed without a map click and is off-screen (e.g. a preset switch).
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !center) return;
    const key = locKey(center);
    if (key === lastCenterKey.current) return;
    lastCenterKey.current = key;
    const target: [number, number] = [center.lon, center.lat];
    if (!didInitialEase.current) {
      didInitialEase.current = true;
      if (!userMoved.current) m.easeTo({ center: target, zoom: 8, duration: 1500 });
    } else if (key !== clickedKey.current && !m.getBounds().contains(target)) {
      m.easeTo({ center: target, duration: 800 });
    }
  }, [center, ready]);

  // Layer toggles (local state, not the shared store).
  useEffect(() => {
    visibleRef.current = visible;
    const m = map.current;
    if (!m || !ready) return;
    for (const g of Object.keys(visible) as LayerGroup[]) {
      for (const id of groupLayerIds(g)) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", visible[g] ? "visible" : "none");
    }
  }, [visible, ready]);

  useEffect(() => {
    hiddenOverlaysRef.current = hiddenOverlays;
    const m = map.current;
    if (!m || !ready) return;
    for (const id of drawn.current.keys()) {
      if (m.getLayer(`ov-${id}`)) m.setLayoutProperty(`ov-${id}`, "visibility", hiddenOverlays.has(id) ? "none" : "visible");
    }
  }, [hiddenOverlays, ready]);

  // Draw overlays published by other modules (e.g. satellite imagery from workstream E).
  // Waits until our layers exist, then syncs by id: changed or vanished overlays are removed.
  // Re-runs on every style load (styleGen), since a basemap swap drops all overlay layers.
  useEffect(() => {
    const m = map.current;
    if (!m || !styleGen) return;
    const want = new Map(overlays.map((o) => [o.id, JSON.stringify([o.type, o.url, o.data, o.opacity])]));
    for (const [id, sig] of drawn.current) {
      if (want.get(id) === sig) continue;
      if (m.getLayer(`ov-${id}`)) m.removeLayer(`ov-${id}`);
      if (m.getSource(`ov-${id}`)) m.removeSource(`ov-${id}`);
      drawn.current.delete(id);
    }
    // Overlays sit below every grid layer (utilities, counties, lines, substations, plants, site).
    const below = LAYER_IDS.find((id) => m.getLayer(id));
    for (const o of overlays) {
      if (drawn.current.has(o.id)) continue;
      const visibility = hiddenOverlaysRef.current.has(o.id) ? "none" : "visible";
      try {
        if (o.type === "raster" && o.url) {
          // Relative URLs (e.g. E's cached tiles at /api/...) must be absolute for the map
          // worker; plain concatenation keeps the {z}/{x}/{y} placeholders unencoded.
          const url = o.url.startsWith("/") ? window.location.origin + o.url : o.url;
          m.addSource(`ov-${o.id}`, { type: "raster", tiles: [url], tileSize: 256, attribution: o.attribution ?? undefined });
          m.addLayer({ id: `ov-${o.id}`, type: "raster", source: `ov-${o.id}`, layout: { visibility }, paint: { "raster-opacity": o.opacity ?? 0.8 } }, below);
        } else if (o.type === "geojson" && o.data) {
          m.addSource(`ov-${o.id}`, { type: "geojson", data: o.data, attribution: o.attribution ?? undefined });
          m.addLayer(
            { id: `ov-${o.id}`, type: "fill", source: `ov-${o.id}`, layout: { visibility }, paint: { "fill-color": "#10b981", "fill-opacity": (o.opacity ?? 0.8) * 0.4 } },
            below,
          );
        }
        if (m.getLayer(`ov-${o.id}`)) drawn.current.set(o.id, want.get(o.id)!);
      } catch (err) {
        console.warn(`overlay ${o.id} failed; will retry on the next change`, err);
        if (m.getLayer(`ov-${o.id}`)) m.removeLayer(`ov-${o.id}`);
        if (m.getSource(`ov-${o.id}`)) m.removeSource(`ov-${o.id}`);
      }
    }
  }, [overlays, styleGen]);

  const fitCalifornia = useCallback(() => {
    userMoved.current = true; // an explicit view choice: don't auto-ease to the site afterwards
    map.current?.fitBounds(CA_BOUNDS, { padding: 24, pitch: 0, duration: 900 });
  }, []);
  // Footprints on: tilt to 2.5D and frame them with the site; off: back to a flat map.
  const tiltForFootprints = useCallback(
    (on: boolean) => {
      const m = map.current;
      if (!m) return;
      userMoved.current = true;
      if (!on) {
        m.easeTo({ pitch: 0, duration: 900 });
        return;
      }
      const bounds = footprintBounds(localData.current.footprints, center);
      if (bounds) m.fitBounds(bounds, { padding: framePadding(m), pitch: FOOTPRINT_PITCH, maxZoom: 14, duration: 1400 });
      else m.easeTo({ pitch: FOOTPRINT_PITCH, duration: 900 });
    },
    [center],
  );
  // Footprints on: refit when the asset set or the site changes (a preset switch), debounced, but not
  // on capacity edits, so dragging a slider doesn't move the camera. The toggle itself already framed them.
  const footprintKey = useMemo(
    () => JSON.stringify([(assets ?? []).map((a) => [a.id, a.kind, a.location ? locKey(a.location) : null]), center ? locKey(center) : null]),
    [assets, center],
  );
  const framedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!visible.footprints) {
      framedKey.current = null;
      return;
    }
    if (framedKey.current === null) {
      framedKey.current = footprintKey; // just toggled on: toggleGroup framed this set
      return;
    }
    if (footprintKey === framedKey.current) return;
    const t = setTimeout(() => {
      framedKey.current = footprintKey;
      tiltForFootprints(true);
    }, REFRAME_DELAY_MS);
    return () => clearTimeout(t);
  }, [visible.footprints, footprintKey, tiltForFootprints]);
  const flyToSite = useCallback(() => {
    if (!center) return;
    userMoved.current = true;
    map.current?.flyTo({ center: [center.lon, center.lat], zoom: SITE_ZOOM, duration: 1200 });
  }, [center]);
  const toggleGroup = useCallback(
    (g: LayerGroup) => {
      const on = !visibleRef.current[g];
      setVisible((v) => ({ ...v, [g]: on }));
      if (g === "footprints") tiltForFootprints(on);
    },
    [tiltForFootprints],
  );
  const toggleOverlay = useCallback(
    (id: string) =>
      setHiddenOverlays((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );

  const pending = DATA_KEYS.filter((k) => status[k] === undefined).length;
  const groupStatus: LayerStatus = {
    ...status,
    footprints: catalog === "error" ? "unavailable" : catalog ? footprints.features.length : undefined,
  };
  const button =
    "px-2.5 py-1 font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-200 dark:hover:bg-zinc-800";

  return (
    <div className="relative h-full w-full">
      <div ref={el} className="h-full w-full" />
      {/* Top-left: view buttons and the basemap notice (D's Site cards float over the bottom-left). */}
      <div className="pointer-events-none absolute left-2 top-2 z-10 flex flex-col items-start gap-1.5">
        <div className="pointer-events-auto flex divide-x divide-zinc-200 overflow-hidden rounded-md bg-white/95 text-xs shadow ring-1 ring-black/10 dark:divide-zinc-700 dark:bg-zinc-900/95 dark:ring-white/10">
          <button type="button" className={button} onClick={fitCalifornia} disabled={!ready} title="Fit California">
            California
          </button>
          <button type="button" className={button} onClick={flyToSite} disabled={!ready || !center} title="Fly to the selected site">
            Site
          </button>
        </div>
        {fallback && (
          <span className="pointer-events-auto rounded bg-amber-50 px-2 py-0.5 text-[10px] text-amber-800 shadow ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-800">
            Basemap offline: showing grid layers on a plain background ·{" "}
            <button type="button" className="font-medium underline" onClick={() => retryBasemap.current?.()}>
              Retry
            </button>
          </span>
        )}
      </div>
      {/* Top-right, below MapLibre's zoom/compass control (10 px margin + 3 x 29 px buttons): layers + legend,
          capped at ~45% of the map height and always clear of the scale bar and attribution (bottom-right),
          and of the floating Site cards on narrow maps (layersMaxHeight). */}
      <div
        className="pointer-events-none absolute right-2.5 top-[106px] z-10 flex max-h-[min(45%,calc(100%-11rem))] flex-col items-end"
        style={layersMaxH !== null ? { maxHeight: layersMaxH } : undefined}
      >
        <LayerControl
          container={el}
          visible={visible}
          onToggle={toggleGroup}
          status={groupStatus}
          overlays={overlays.map((o) => ({ id: o.id, label: o.label }))}
          hiddenOverlays={hiddenOverlays}
          onToggleOverlay={toggleOverlay}
        />
      </div>
      {pending > 0 && (
        <div className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full bg-white/95 px-3 py-1 text-xs text-zinc-600 shadow ring-1 ring-black/10 dark:bg-zinc-900/95 dark:text-zinc-300 dark:ring-white/10">
          Loading grid data… {DATA_KEYS.length - pending}/{DATA_KEYS.length}
        </div>
      )}
    </div>
  );
}
