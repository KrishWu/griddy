"use client";
// Interactive grid map.  OWNER: workstream A (Explore / GIS).
// California grid layers (EIA-860 plants, CEC transmission, OSM substations, Census counties,
// CEC utility territories, LBNL interconnection queue by county), 2.5D footprints of the
// scenario's assets, popups, click-to-select-site, overlays from other modules, and a bundled
// fallback basemap if the tile provider is down. Layer toggles + legend live in the sidebar's Layers
// tab (LayerControl); visibility is shared with it through layerState.tsx.
// Phase 2: a "Forecast & sites" drawer (ForecastView) over the right of the map, a county
// demand-growth choropleth and recommended-site markers, all from the shared Phase 2 state.
// Our sources/layers are (re)added on every 'style.load', so a basemap swap keeps them.
// Settings (lib/settings.tsx) pick the basemap (follow theme / light / dark; Mixed keeps it light),
// filter the canvas (contrast, brightness) and turn camera animations off under reduced motion.
// A locate button under the zoom controls (like Google Maps) flies to the viewer's own location.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { GeoJSONSource, LngLat as MLLngLat, Map as MLMap, MapGeoJSONFeature, Popup } from "maplibre-gl";

import { countyByGeoid, scenarioLabel } from "@/components/forecast/forecastData";
import { ForecastView } from "@/components/forecast/ForecastView";
import { forecastAdjusted, getPhase2State, usePhase2 } from "@/components/forecast/usePhase2";
import { PanelGuard } from "@/components/shell/PanelGuard";
import { showLeftTabFromMap } from "@/components/shell/sidebarTabs";
import { api, request } from "@/lib/api";
import type { Asset, Catalog, DemandForecast, LngLat, SiteCandidate, SiteRecommendation, SiteSummary } from "@/lib/contract";
import { prefersReducedMotion, useSettings } from "@/lib/settings";
import { useGridForge } from "@/lib/store";

import { closeForecastDrawer, isForecastDrawerOpen, subscribeForecastDrawer, toggleForecastDrawer, useForecastDrawer } from "./forecastDrawer";
import { footprintBounds, footprintsFC, loadCatalog } from "./footprints";
import { CA_BOUNDS, EMPTY_FC, circleRing, locKey, num } from "./geo";
import { useLayerState, type LayerStatus } from "./layerState";
import {
  AREA_LAYER_IDS,
  BASEMAP,
  CLICKABLE_LAYER_IDS,
  DATA_KEYS,
  INLINE_FALLBACK_STYLE,
  LAYERS,
  LAYER_IDS,
  LOCAL_SOURCES,
  SOURCE_ATTRIBUTION,
  asStyle,
  demandPaint,
  groupLayerIds,
  type DataKey,
  type LayerGroup,
  type LocalSource,
} from "./mapStyle";
import { demandCard, popupContent, recSiteCard, type DemandInfo } from "./popup";
import { installRecommendationStars } from "./recommendationStars";
import { ProjectMapTools } from "./ProjectMapTools";
import { MapSearch } from "./MapSearch";
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
const LOCATE_ZOOM = 13; // closest the locate button zooms; a coarse (IP / Wi-Fi) fix frames its accuracy circle instead
const LOCATE_NOTE_MS = 8000; // how long a "couldn't find you" note stays up

/** What the map says when the browser can't give a position (GeolocationPositionError codes). */
function locateMessage(code: number): string {
  if (code === 1) return "Location is blocked for this site. Allow it in your browser's site settings, then reload.";
  if (code === 3) return "Finding your location took too long. Try again.";
  return "Couldn't find your location. Check that location is turned on for this browser in your computer's settings.";
}

/** Queue status from the boundaries layer: counties with active requests, or "unavailable" when the
 *  backend's queue file is missing (no county carries queue_active_mw). */
function queueStatus(fc: FC): number | "unavailable" {
  if (!fc.features.some((f) => num(f.properties?.queue_active_mw) !== null)) return "unavailable";
  return fc.features.filter((f) => (num(f.properties?.queue_active_projects) ?? 0) > 0).length;
}

type Padding = { top: number; right: number; bottom: number; left: number };

const DARK_STYLE = "https://tiles.openfreemap.org/styles/dark";
const styleUrl = (tone: "light" | "dark") => (tone === "dark" ? DARK_STYLE : BASEMAP);

// "Forecast & sites" drawer over the right of the map; on a map too narrow to keep a useful strip
// beside it, it takes the full width. While it is open, MapLibre's controls move to its left edge.
const DRAWER_W = 420;
const DRAWER_FULL_BELOW = 680;

function drawerWidth(open: boolean, w: number | null): number {
  if (!open) return 0;
  return w !== null && w < DRAWER_FULL_BELOW ? w : DRAWER_W;
}

/** Camera options for our own moves: a jump instead of an animation under reduced motion (the
 *  setting, or the OS when unset), and `essential` so MapLibre follows our setting, not only the OS. */
function motion(): { animate: boolean; essential: true } {
  return { animate: !prefersReducedMotion(), essential: true };
}

/** Camera padding for framing footprints: the map minus the overlays that stay on it (search, view
 *  buttons at the top left, zoom/compass at the top right, scale bar and attribution
 *  at the bottom). The Site cards and layers card used to float here; they live in the sidebars now.
 *  Extra room at the bottom covers what the pitch and extrusions push below the fitted bounds.
 *  `shift`: px on the right covered by the forecast drawer. */
function framePadding(m: MLMap, shift = 0): Padding {
  const p = framePaddingIn(m.getContainer().clientWidth - shift, m.getContainer().clientHeight);
  return { ...p, right: p.right + shift };
}

function framePaddingIn(w: number, h: number): Padding {
  const p: Padding = { top: Math.round(Math.min(124, 0.3 * h)), left: 16, right: 52, bottom: 40 };
  const bw = w - p.left - p.right;
  const bh = h - p.top - p.bottom;
  if (bw < 120 || bh < 100) return { top: 24, right: 24, bottom: 24, left: 24 };
  return { ...p, bottom: p.bottom + Math.round(Math.min(0.08 * h, 0.25 * bh)) };
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

/** Recommended sites (B's ranking) as points; empty when the recommendation is unavailable. */
function recSitesFC(rec: SiteRecommendation | null): FC {
  if (!rec?.available || !Array.isArray(rec.sites)) return EMPTY_FC;
  const features: GeoJSON.Feature[] = [];
  for (const s of rec.sites) {
    const loc = s.location;
    if (!loc || !Number.isFinite(loc.lon) || !Number.isFinite(loc.lat)) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [loc.lon, loc.lat] },
      properties: {
        id: s.id,
        kind: s.kind,
        mw: s.mw,
        county: s.county ?? null,
        region: s.region,
        reason: s.reason,
        capex_usd: s.capex_usd ?? null,
        gen_tie_usd: s.gen_tie_usd ?? null,
        d_line_hv_km: s.d_line_hv_km,
        suitability: s.suitability,
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/** What the demand-growth popup shows for a county (by geoid) in the current forecast. */
function demandInfo(f: DemandForecast | null, geoid: unknown): DemandInfo | null {
  if (!f?.available) return null;
  const county = countyByGeoid(f, typeof geoid === "string" ? geoid : null);
  return {
    county,
    year: f.year,
    baseYear: f.base_year ?? 2024,
    scenario: `${scenarioLabel(f.scenario)}${forecastAdjusted(f) ? " (adjusted)" : ""}`,
    regionName: county ? (f.regions?.find((r) => r.region === county.region)?.name ?? null) : null,
  };
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
  // Basemap tone: "follow theme" means dark in Dark, light in Light and Mixed (Mixed keeps the map light).
  const { settings, basemap: tone } = useSettings();
  const toneRef = useRef(tone);
  const appliedTone = useRef(tone);
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const areaClick = useRef<((p: LngLat) => void) | null>(null);
  const { scenario, selectSite, selectRecommendedSite, overlays } = useGridForge();
  const { summary } = useSiteSummary();
  // Phase 2: the forecast and site recommendation for the drawer's current what-if (shared state).
  const forecast = usePhase2((s) => s.forecast);
  const forecastStatus = usePhase2((s) => s.forecastStatus);
  const recommendation = usePhase2((s) => s.recommendation);
  const drawerOpen = useForecastDrawer();
  const center = scenario?.site.location;
  const siteName = scenario?.site.name;
  const assets = scenario?.assets;

  // >0 once our layers exist on the current style (overlays can be drawn); bumps on every style load.
  const [styleGen, setStyleGen] = useState(0);
  const ready = styleGen > 0;
  const drawn = useRef(new Map<string, string>()); // overlay id -> signature currently on the map
  // Layer visibility is shared with the sidebar's Layers tab (layerState.tsx, provided by AppShell).
  const { visible, setVisible, hiddenOverlays, setStatus: publishStatus } = useLayerState();
  const [status, setStatus] = useState<LayerStatus>({});
  const [fallback, setFallback] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);
  const retryBasemap = useRef<(() => void) | null>(null);
  useEffect(() => {
    toneRef.current = tone;
    if (appliedTone.current !== tone) {
      appliedTone.current = tone;
      retryBasemap.current?.();
    }
  }, [tone]);
  // Map size, so the forecast drawer can size itself. MapLibre tracks its container too; the explicit
  // resize() below keeps the canvas in step the moment a sidebar collapses or expands (no stretched frame).
  const [mapSize, setMapSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const ro = new ResizeObserver(() => {
      const w = node.clientWidth;
      const h = node.clientHeight;
      setMapSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
      map.current?.resize();
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  const drawerPx = drawerWidth(drawerOpen, mapSize?.w ?? null);
  // Px on the right the drawer covers while a strip of map stays beside it (0 when closed or full width).
  const shift = drawerOpen && (mapSize === null || drawerPx < mapSize.w) ? drawerPx : 0;

  // Latest values for map event handlers (they're registered once).
  const selectRef = useRef(selectSite);
  const selectRecommendedRef = useRef(selectRecommendedSite);
  const visibleRef = useRef(visible);
  const hiddenOverlaysRef = useRef(hiddenOverlays);
  const layerData = useRef<Partial<Record<DataKey, FC>>>({});
  const localData = useRef<Record<LocalSource, FC>>({ "site-context": EMPTY_FC, assets: EMPTY_FC, site: EMPTY_FC, footprints: EMPTY_FC, "rec-sites": EMPTY_FC });
  const forecastRef = useRef<DemandForecast | null>(forecast);
  const shiftRef = useRef(shift);
  const [catalog, setCatalog] = useState<Catalog | "error" | null>(null);
  // View state: ease to the site once, unless the user already moved the map.
  const userMoved = useRef(false);
  const didInitialEase = useRef(false);
  const lastCenterKey = useRef<string | null>(null);
  const clickedKey = useRef<string | null>(null);

  useEffect(() => {
    selectRef.current = selectSite;
    selectRecommendedRef.current = selectRecommendedSite;
  }, [selectSite, selectRecommendedSite]);
  useEffect(() => {
    forecastRef.current = forecast;
  }, [forecast]);
  useEffect(() => {
    shiftRef.current = shift;
  }, [shift]);

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
        style: styleUrl(toneRef.current),
        bounds: CA_BOUNDS,
        fitBoundsOptions: { padding: 24 },
        attributionControl: { compact: true },
        reduceMotion: prefersReducedMotion(), // pan/zoom inertia; our own camera moves use motion()
      });
      map.current = m;
      m.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");
      // Locate me, under the zoom buttons: one browser geolocation fix per click (the browser asks
      // permission the first time), a blue dot with its accuracy circle, framed beside the drawer.
      // Camera options are set per click so they follow the drawer and the reduced-motion setting.
      class LocateControl extends maplibregl.GeolocateControl {
        override trigger(): boolean {
          userMoved.current = true; // an explicit view choice: don't auto-ease to the site afterwards
          this.options.fitBoundsOptions = { maxZoom: LOCATE_ZOOM, padding: framePadding(m, shiftRef.current), duration: 1200, ...motion() };
          setLocateError(null);
          setLocating(true);
          return super.trigger();
        }
      }
      const locate = new LocateControl({ positionOptions: { enableHighAccuracy: false, maximumAge: 60_000, timeout: 10_000 } });
      locate.on("geolocate", () => setLocating(false));
      locate.on("error", (e) => {
        setLocating(false);
        setLocateError(locateMessage(e.code));
      });
      m.addControl(locate, "top-right");
      m.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

      // (Re)add our sources + layers; runs on every style load (initial basemap or fallback).
      const install = () => {
        installRecommendationStars(m);
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
        const fallbackStyle = fetched ?? INLINE_FALLBACK_STYLE;
        m.setStyle(toneRef.current === "dark" ? { ...fallbackStyle, layers: [{ id: "background", type: "background", paint: { "background-color": "#0c182a" } }] } : fallbackStyle, { diff: false });
      };
      // Slow is not down (venue Wi-Fi, a busy laptop): after the timeout, fall back only if the
      // basemap's style URL is actually unreachable. Real load errors fall back right away (below).
      const probeThenSwap = async () => {
        if (styleLoaded) return;
        const url = styleUrl(toneRef.current);
        const reachable = await fetch(url, { signal: AbortSignal.timeout(STYLE_PROBE_MS) }).then((r) => r.ok, () => false);
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
        m.setStyle(styleUrl(toneRef.current), { diff: false });
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
      // "Use this site" on a recommended site: make it the scenario site and fly there (beside the drawer).
      const adoptSite = (p: LngLat, candidate?: SiteCandidate) => {
        userMoved.current = true;
        clickedKey.current = locKey(p);
        trackSiteSelection(p, candidate ? selectRecommendedRef.current(candidate) : selectRef.current(p));
        showLeftTabFromMap("site"); // the new site's summary, where the viewer looks next
        m.flyTo({ center: [p.lon, p.lat], zoom: Math.max(m.getZoom(), SITE_ZOOM), offset: [-shiftRef.current / 2, 0], duration: 1200, ...motion() });
      };
      const contentFor = (f: MapGeoJSONFeature, pop: Popup): HTMLElement => {
        if (f.layer.id === "demand-fill") return demandCard(f.properties, demandInfo(forecastRef.current, f.properties?.geoid));
        if (f.layer.id === "rec-sites" && f.geometry.type === "Point") {
          const [lon, lat] = f.geometry.coordinates;
          const candidate = getPhase2State().recommendation?.sites?.find((site) => site.id === f.properties?.id);
          const usable = candidate && Number.isFinite(candidate.mw) && candidate.mw > 0 && candidate.mw <= 20000;
          return recSiteCard(f.properties, usable ? () => {
            pop.remove();
            adoptSite({ lon, lat }, candidate);
          } : null);
        }
        return popupContent(f.layer.id, f.properties);
      };
      const openPopup = (f: MapGeoJSONFeature, at: MLLngLat): Popup => {
        const g = f.geometry;
        const anchor: [number, number] = g.type === "Point" ? [g.coordinates[0], g.coordinates[1]] : [at.lng, at.lat];
        const pop = new maplibregl.Popup({ closeOnClick: false, maxWidth: "280px", offset: 8, className: "z-20" }); // above the z-10 map overlays
        return pop.setLngLat(anchor).setDOMContent(contentFor(f, pop)).addTo(m);
      };

      m.on("click", (e) => {
        userMoved.current = true;
        clearTimeout(selectTimer);
        popup?.remove();
        popup = null;
        if (areaClick.current) {
          const ll = e.lngLat.wrap();
          areaClick.current({ lon: ll.lng, lat: ll.lat });
          return;
        }
        const hits = hitsAt(e.point, CLICKABLE_LAYER_IDS); // topmost first
        const feature = hits.find((f) => !AREA_LAYER_IDS.includes(f.layer.id));
        if (feature) {
          popup = openPopup(feature, e.lngLat);
          return;
        }
        const zone = hitsAt(e.point, ["zoning-fill"])[0];
        if (zone) { popup = openPopup(zone, e.lngLat); return; }
        if (e.originalEvent.detail > 1) return; // 2nd click of a double-click: the map zooms instead
        // Empty map (or only an area fill): select a site here, unless a double-click follows, then
        // show the topmost area's popup (a queue county above a utility territory).
        const ll = e.lngLat.wrap(); // a click on a world copy still means -180..180
        const p = { lon: ll.lng, lat: ll.lat };
        const area = hits.find((f) => AREA_LAYER_IDS.includes(f.layer.id));
        selectTimer = setTimeout(() => {
          clickedKey.current = locKey(p);
          trackSiteSelection(p, selectRef.current(p));
          showLeftTabFromMap("site"); // the sidebar shows the clicked site's summary (if that doesn't move the map)
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
          // ProjectMapTools sets data-area-cursor while the Highlight area box is being drawn or edited.
          const canvas = m.getCanvas();
          canvas.style.cursor = canvas.dataset.areaCursor || (areaClick.current ? "crosshair" : hitsAt(hoverPt, HOVER_LAYER_IDS).length ? "pointer" : "");
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
  const recSites = useMemo(() => recSitesFC(recommendation), [recommendation]);
  useEffect(() => {
    localData.current = { site, assets: placed, "site-context": context, footprints, "rec-sites": recSites };
    const m = map.current;
    if (!m) return;
    for (const id of LOCAL_SOURCES) m.getSource<GeoJSONSource>(id)?.setData(localData.current[id]);
  }, [site, placed, context, footprints, recSites]);

  // Demand-growth choropleth: recolor the counties for the current forecast (paint only, no geometry
  // upload), again after every style load since install() re-adds the layer with its default paint.
  const demand = useMemo(() => demandPaint(forecast?.available ? (forecast.counties ?? []) : []), [forecast]);
  useEffect(() => {
    const m = map.current;
    if (!m || !styleGen || !m.getLayer("demand-fill")) return;
    m.setPaintProperty("demand-fill", "fill-color", demand.color);
    m.setPaintProperty("demand-fill", "fill-opacity", demand.opacity);
  }, [demand, styleGen]);

  // Drawer open: MapLibre's zoom/compass (top-right) and scale/attribution (bottom-right) move to its left edge.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    for (const sel of [".maplibregl-ctrl-top-right", ".maplibregl-ctrl-bottom-right"]) {
      const node = m.getContainer().querySelector<HTMLElement>(sel);
      if (!node) continue;
      node.style.transition = "right 150ms ease-out";
      node.style.right = shift ? `${shift}px` : "";
    }
  }, [shift, styleGen]);

  // The first time the drawer opens, show the demand-growth layer statewide beside it.
  const autoDemand = useRef(false);
  useEffect(
    () =>
      subscribeForecastDrawer(() => {
        if (!isForecastDrawerOpen() || autoDemand.current) return;
        autoDemand.current = true;
        setVisible((v) => ({ ...v, demand: true, queue: false }));
        const m = map.current;
        const w = el.current?.clientWidth ?? 0;
        const px = drawerWidth(true, w);
        if (m && px < w) {
          userMoved.current = true;
          // Into the clear part of the map beside the drawer.
          m.fitBounds(CA_BOUNDS, { padding: framePadding(m, px), pitch: 0, duration: 900, ...motion() });
        }
      }),
    [setVisible],
  );
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeForecastDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  useEffect(() => {
    if (!locateError) return;
    const t = setTimeout(() => setLocateError(null), LOCATE_NOTE_MS);
    return () => clearTimeout(t);
  }, [locateError]);

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
      if (!userMoved.current) m.easeTo({ center: target, zoom: 8, duration: 1500, ...motion() });
    } else if (key !== clickedKey.current && !m.getBounds().contains(target)) {
      m.easeTo({ center: target, duration: 800, ...motion() });
    }
  }, [center, ready]);

  // Layer toggles (shared with the Layers tab through layerState, not the app store).
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
    const m = map.current;
    if (!m) return;
    const s = shiftRef.current; // drawer open: into the clear part of the map beside it
    m.fitBounds(CA_BOUNDS, { padding: s ? framePadding(m, s) : 24, pitch: 0, duration: 900, ...motion() });
  }, []);
  // Footprints on: tilt to 2.5D and frame them with the site; off: back to a flat map.
  const tiltForFootprints = useCallback(
    (on: boolean) => {
      const m = map.current;
      if (!m) return;
      userMoved.current = true;
      if (!on) {
        m.easeTo({ pitch: 0, duration: 900, ...motion() });
        return;
      }
      const bounds = footprintBounds(localData.current.footprints, center);
      if (bounds) m.fitBounds(bounds, { padding: framePadding(m, shiftRef.current), pitch: FOOTPRINT_PITCH, maxZoom: 14, duration: 1400, ...motion() });
      else m.easeTo({ pitch: FOOTPRINT_PITCH, duration: 900, ...motion() });
    },
    [center],
  );
  // Footprints on: refit when the asset set or the site changes (a preset switch), debounced, but not
  // on capacity edits, so dragging a slider doesn't move the camera. The toggle itself already framed them.
  const footprintKey = useMemo(
    () => JSON.stringify([(assets ?? []).map((a) => [a.id, a.kind, a.location ? locKey(a.location) : null]), center ? locKey(center) : null]),
    [assets, center],
  );
  // The footprints toggle lives in the Layers tab now: tilt and frame when it flips (not on mount).
  const footprintsOn = useRef(visible.footprints);
  useEffect(() => {
    if (footprintsOn.current === visible.footprints) return;
    footprintsOn.current = visible.footprints;
    tiltForFootprints(visible.footprints);
  }, [visible.footprints, tiltForFootprints]);
  const framedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!visible.footprints) {
      framedKey.current = null;
      return;
    }
    if (framedKey.current === null) {
      framedKey.current = footprintKey; // just toggled on: the effect above framed this set
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
    map.current?.flyTo({ center: [center.lon, center.lat], zoom: SITE_ZOOM, offset: [-shiftRef.current / 2, 0], duration: 1200, ...motion() });
  }, [center]);

  const pending = DATA_KEYS.filter((k) => status[k] === undefined).length;
  const groupStatus: LayerStatus = {
    ...status,
    footprints: catalog === "error" ? "unavailable" : catalog ? footprints.features.length : undefined,
    demand: forecast?.available ? (forecast.counties?.length ?? 0) : forecast || forecastStatus === "error" ? "unavailable" : undefined,
    sites: recommendation?.available ? recSites.features.length : undefined, // listed only when available
  };
  // Publish the counts to the Layers tab (only when they change, so no render loop).
  const statusKey = JSON.stringify(groupStatus);
  useEffect(() => {
    publishStatus(JSON.parse(statusKey) as LayerStatus);
  }, [statusKey, publishStatus]);
  // Settings > Map contrast / brightness: a CSS filter on the canvas only (globals.css), none at 100 %.
  const { mapContrast, mapBrightness } = settings;
  const mapFilter = mapContrast === 100 && mapBrightness === 100 ? undefined : `contrast(${mapContrast}%) brightness(${mapBrightness}%)`;
  const button =
    "px-2.5 py-1 font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-200 dark:hover:bg-zinc-800";

  return (
    <div className="relative h-full w-full overflow-hidden" style={mapFilter ? ({ "--map-filter": mapFilter } as CSSProperties) : undefined}>
      <div ref={el} className="h-full w-full" />
      {/* Top-left: search, view controls and basemap notices. Kept clear of the
          zoom/compass (top-right) and, while it is open, of the forecast drawer, so on a narrow strip of
          map the search box narrows instead of sliding under them. */}
      <div
        className="pointer-events-none absolute left-2 top-2 z-10 flex flex-col items-start gap-1.5"
        style={{ maxWidth: `calc(100% - ${shift}px - 3.5rem)` }}
      >
        <MapSearch mapRef={map} ready={ready} onNavigate={() => { userMoved.current = true; }} />
        <div className="pointer-events-auto flex divide-x divide-zinc-200 overflow-hidden rounded-md bg-white/95 text-xs shadow ring-1 ring-black/10 dark:divide-zinc-700 dark:bg-zinc-900/95 dark:ring-white/10">
          <button type="button" className={button} onClick={fitCalifornia} disabled={!ready} title="Fit California">
            California
          </button>
          <button type="button" className={button} onClick={flyToSite} disabled={!ready || !center} title="Fly to the selected site">
            Site
          </button>
          <button
            type="button"
            className={drawerOpen ? "bg-zinc-900 px-2.5 py-1 font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300" : button}
            onClick={toggleForecastDrawer}
            aria-pressed={drawerOpen}
            title="Demand forecast and where to build"
          >
            Forecast
          </button>
        </div>
        <ProjectMapTools mapRef={map} styleGen={styleGen} clickHandlerRef={areaClick} />
        {fallback && (
          <span className="pointer-events-auto rounded bg-amber-50 px-2 py-0.5 text-[10px] text-amber-800 shadow ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-800">
            Basemap offline: showing grid layers on a plain background ·{" "}
            <button type="button" className="font-medium underline" onClick={() => retryBasemap.current?.()}>
              Retry
            </button>
          </span>
        )}
        {locating && (
          <span role="status" className="rounded bg-white/95 px-2 py-0.5 text-[10px] text-zinc-600 shadow ring-1 ring-black/10 dark:bg-zinc-900/95 dark:text-zinc-300 dark:ring-white/10">
            Finding your location…
          </span>
        )}
        {locateError && (
          <span role="alert" className="max-w-72 rounded bg-amber-50 px-2 py-0.5 text-[10px] text-amber-800 shadow ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-800">
            {locateError}
          </span>
        )}
      </div>
      {drawerOpen && (
        <aside
          data-chrome // a panel: black in the Mixed theme, like the sidebars
          className="absolute inset-y-0 right-0 z-30 flex max-w-full flex-col border-l border-zinc-200 bg-white text-zinc-900 shadow-xl dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
          style={{ width: drawerPx }}
          aria-label="Forecast and sites"
        >
          <header className="flex shrink-0 items-start justify-between gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">Forecast &amp; sites</h2>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">California demand growth by scenario, and where to build for it</p>
            </div>
            <button
              type="button"
              onClick={closeForecastDrawer}
              aria-label="Close the forecast"
              title="Close (Esc)"
              className="shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
              </svg>
            </button>
          </header>
          {/* No top padding on the scroller itself: the forecast's sticky headline sticks to its very top. */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-6">
            <div className="pt-3">
              <PanelGuard name="Forecast">
                <ForecastView embedded />
              </PanelGuard>
            </div>
          </div>
        </aside>
      )}
      {pending > 0 && (
        <div className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full bg-white/95 px-3 py-1 text-xs text-zinc-600 shadow ring-1 ring-black/10 dark:bg-zinc-900/95 dark:text-zinc-300 dark:ring-white/10">
          Loading grid data… {DATA_KEYS.length - pending}/{DATA_KEYS.length}
        </div>
      )}
    </div>
  );
}
