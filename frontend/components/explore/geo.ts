// Small geo + defensive-parsing helpers for the Explore map and Site panel.  OWNER: workstream A.
import type { LngLat } from "@/lib/contract";

/** California bounding box [[west, south], [east, north]]. */
export const CA_BOUNDS: [[number, number], [number, number]] = [
  [-124.48, 32.53],
  [-114.13, 42.01],
];

const EARTH_RADIUS_KM = 6371.0088;
const RAD = Math.PI / 180;

/** Point `km` away from `p` along `bearingDeg` (spherical Earth; fine for a 25 km ring). */
export function destination(p: LngLat, km: number, bearingDeg: number): [number, number] {
  const d = km / EARTH_RADIUS_KM;
  const b = bearingDeg * RAD;
  const lat1 = p.lat * RAD;
  const lon1 = p.lon * RAD;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [round5(lon2 / RAD), round5(lat2 / RAD)];
}

/** Closed polygon ring approximating a geodesic circle. */
export function circleRing(center: LngLat, km: number, steps = 96): [number, number][] {
  const ring: [number, number][] = [];
  for (let i = 0; i < steps; i++) ring.push(destination(center, km, (360 * i) / steps));
  ring.push(ring[0]);
  return ring;
}

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Kilometres per degree of latitude on the same sphere as destination(). */
const KM_PER_DEG = EARTH_RADIUS_KM * RAD;

/** Local equirectangular offset: the point `dxKm` east and `dyKm` north of `p`, with the longitude
 *  scale taken at p's latitude (accurate to well under 1% within a few tens of km). */
export function offsetKm(p: LngLat, dxKm: number, dyKm: number): [number, number] {
  return [round6(p.lon + dxKm / (KM_PER_DEG * Math.cos(p.lat * RAD))), round6(p.lat + dyKm / KM_PER_DEG)];
}

/** Stable key for a location (~10 m), used to dedupe site-summary fetches. */
export const locKey = (p: LngLat) => `${p.lon.toFixed(4)},${p.lat.toFixed(4)}`;

export function sameLoc(a: LngLat | null | undefined, b: LngLat | null | undefined, tolDeg = 1e-3): boolean {
  return !!a && !!b && Math.abs(a.lon - b.lon) <= tolDeg && Math.abs(a.lat - b.lat) <= tolDeg;
}

export const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

// --- defensive readers for loosely typed JSON (SiteSummary.extras, feature properties) ---

export function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() ? v : null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

export function lngLat(v: unknown): LngLat | null {
  const r = rec(v);
  const lon = num(r?.lon);
  const lat = num(r?.lat);
  return lon !== null && lat !== null && Math.abs(lon) <= 180 && Math.abs(lat) <= 90 ? { lon, lat } : null;
}

/** Nested properties come back from MapLibre as JSON strings; accept either form. */
export function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

/** Only http(s) links are rendered, so a property can never become a javascript: URL. */
export function safeUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

// --- formatting ---

export function fmtMw(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "– MW";
  if (Math.abs(v) >= 100) return `${Math.round(v).toLocaleString()} MW`;
  if (Math.abs(v) >= 10) return `${v.toFixed(0)} MW`;
  return `${v.toFixed(1)} MW`;
}

/** Capacity in GW (one decimal) from 1,000 MW up, MW below: "28.9 GW", "656 MW". */
export function fmtCap(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "– MW";
  if (v === 0) return "0 MW";
  return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)} GW` : fmtMw(v);
}

export function fmtAcres(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "– acres";
  if (v >= 100) return `${Math.round(v).toLocaleString()} acres`;
  return `${v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2)} acres`;
}

export function fmtKm2(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "– km²";
  return `${v >= 10 ? v.toFixed(1) : v >= 0.1 ? v.toFixed(2) : v.toFixed(3)} km²`;
}

/** acres/MW: "6.0", "40.0", "0.05". */
export function fmtPerMw(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  return v >= 1 ? v.toFixed(1) : String(Number(v.toPrecision(2)));
}

const KEEP_UPPER = new Set(["II", "III", "IV", "VI", "VII", "VIII", "IX", "XI", "XII", "LLC", "LP", "BESS", "PV", "ESS", "USA"]);

/** "SANBORN HYBRID 3" -> "Sanborn Hybrid 3". Names that already use lower case are kept as written. */
export function readableName(s: string): string {
  if (/[a-z]/.test(s)) return s;
  return s.toLowerCase().replace(/[a-z0-9]+/g, (w) => (KEEP_UPPER.has(w.toUpperCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
}

/** "Kern" -> "Kern County" (names that already say County are kept). */
export function countyLabel(name: string | null | undefined): string {
  if (!name) return "This county";
  return /county$/i.test(name.trim()) ? name.trim() : `${name.trim()} County`;
}

export function fmtKm(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "– km";
  return v < 10 ? `${v.toFixed(1)} km` : `${Math.round(v).toLocaleString()} km`;
}

export function fmtKv(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) return "kV unknown";
  return v < 10 ? `${Number(v.toFixed(2))} kV` : `${Math.round(v)} kV`; // low voltages keep decimals: 0.48 kV, 4.16 kV
}
