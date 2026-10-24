// Feature popups for the Explore map, built as DOM with textContent (never raw HTML),
// so property strings from external datasets can't inject markup.  OWNER: workstream A.
import type { AssetKind, CountyForecast } from "@/lib/contract";
import { usd } from "@/lib/format";

import { BATTERY_REF_HOURS } from "./footprints";
import { countyLabel, fmtAcres, fmtCap, fmtKm2, fmtKv, fmtMw, fmtPerMw, num, parseMaybeJson, rec, safeUrl, str } from "./geo";
import {
  ASSET_FUEL,
  ASSET_LABEL,
  DEMAND_CREDIT,
  FUEL_COLOR,
  FUEL_LABEL,
  QUEUE_CREDIT,
  UTILITY_TYPE_LABEL,
  asFuel,
  voltageClass,
} from "./palette";

type Props = Record<string, unknown>;
type Row = [label: string, value: string | null];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function card(opts: { title: string; swatch?: string; ring?: boolean; subtitle?: string | null; rows: Row[]; source: string | null; link?: { href: string | null; text: string } }): HTMLElement {
  const root = el("div", "min-w-[180px] max-w-[260px] font-sans text-xs leading-snug text-zinc-800");
  const head = el("div", "flex items-start gap-1.5");
  if (opts.swatch) {
    const dot = el("span", "mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full");
    if (opts.ring) dot.style.border = `2px solid ${opts.swatch}`;
    else dot.style.backgroundColor = opts.swatch;
    head.append(dot);
  }
  head.append(el("div", "pr-4 text-sm font-semibold text-zinc-900", opts.title));
  root.append(head);
  if (opts.subtitle) root.append(el("div", "mt-0.5 text-zinc-600", opts.subtitle));
  const rows = opts.rows.filter((r): r is [string, string] => !!r[1]);
  if (rows.length) {
    const dl = el("dl", "mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5");
    for (const [k, v] of rows) dl.append(el("dt", "text-zinc-500", k), el("dd", "break-words text-zinc-800", v));
    root.append(dl);
  }
  if (opts.link?.href) {
    const a = el("a", "mt-1.5 inline-block text-sky-700 underline", opts.link.text);
    a.href = opts.link.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    root.append(a);
  }
  if (opts.source) root.append(el("div", "mt-1.5 border-t border-zinc-200 pt-1 text-[10px] text-zinc-500", `Source: ${opts.source}`));
  return root;
}

const years = (a: unknown, b: unknown) => {
  const y1 = num(a);
  const y2 = num(b);
  if (y1 === null && y2 === null) return null;
  return y1 !== null && y2 !== null && y1 !== y2 ? `${y1}–${y2}` : String(y1 ?? y2);
};

function plantCard(p: Props): HTMLElement {
  const fuel = asFuel(p.fuel);
  const mix = rec(parseMaybeJson(p.fuel_mix));
  const mixText =
    mix && Object.keys(mix).length > 1
      ? Object.entries(mix)
          .map(([f, mw]) => [f, num(mw) ?? 0] as const)
          .sort((a, b) => b[1] - a[1])
          .map(([f, mw]) => `${FUEL_LABEL[asFuel(f)]} ${fmtMw(mw)}`)
          .join(", ")
      : null;
  const gens = num(p.n_generators);
  return card({
    title: str(p.name) ?? "Power plant",
    swatch: FUEL_COLOR[fuel],
    subtitle: `${FUEL_LABEL[fuel]} · ${fmtMw(num(p.capacity_mw))}${str(p.status) ? ` · ${str(p.status)}` : ""}`,
    rows: [
      ["Fuel mix", mixText],
      ["Technology", str(p.technology)],
      ["Operator", str(p.operator)],
      ["County", str(p.county)],
      ["BA", str(p.balancing_authority)],
      ["Grid", num(p.grid_voltage_kv) !== null ? fmtKv(num(p.grid_voltage_kv)) : null],
      ["Online", years(p.first_year, p.last_year)],
      ["Units", gens !== null ? String(gens) : null],
      ["EIA ID", str(p.plant_code)],
    ],
    source: str(p.source) ?? "EIA-860 2024",
  });
}

function substationCard(p: Props): HTMLElement {
  const kv = num(p.voltage_kv);
  const all = parseMaybeJson(p.voltages_kv);
  const list = Array.isArray(all) ? all.map(num).filter((v): v is number => v !== null && v > 0) : [];
  const ts = str(p.osm_timestamp);
  return card({
    title: str(p.name) ?? "Substation",
    swatch: voltageClass(kv).color,
    ring: true,
    subtitle: list.length > 1 ? list.map((v) => `${v}`).join(" / ") + " kV" : fmtKv(kv),
    rows: [
      ["Operator", str(p.operator)],
      ["Type", str(p.substation_type)],
      ["OSM edit", ts ? ts.slice(0, 10) : null],
    ],
    link: { href: safeUrl(p.osm_url), text: "View on OpenStreetMap" },
    source: "© OpenStreetMap contributors (ODbL)",
  });
}

function lineCard(p: Props): HTMLElement {
  const kv = num(p.voltage_kv);
  const lineType = str(p.line_type);
  const lengthMi = num(p.length_mi);
  const updated = str(p.source_updated);
  const operational = p.operational !== false;
  return card({
    title: str(p.name) ?? "Transmission line",
    swatch: voltageClass(kv).color,
    subtitle: `${fmtKv(kv)}${operational ? "" : " · not operational"}`,
    rows: [
      ["Owner", str(p.owner)],
      ["Status", str(p.status)],
      ["Circuit", str(p.circuit)],
      ["Type", lineType === "OH" ? "Overhead" : lineType === "UG" ? "Underground" : lineType === "UW" ? "Underwater" : lineType],
      ["Length", lengthMi !== null ? `${lengthMi.toFixed(1)} mi` : null],
    ],
    source: `${str(p.source) ?? "CEC California Electric Transmission Lines"}${updated ? ` (updated ${updated.slice(0, 10)})` : ""}`,
  });
}

function utilityCard(p: Props): HTMLElement {
  const type = str(p.utility_type);
  const area = num(p.area_km2);
  const date = str(p.source_date);
  return card({
    title: str(p.name) ?? "Utility territory",
    subtitle: type === "IOU" || type === "POU" ? UTILITY_TYPE_LABEL[type] : type,
    rows: [
      ["Acronym", str(p.acronym)],
      ["Area", area !== null ? `${Math.round(area).toLocaleString()} km²` : null],
      ["Note", str(p.note)],
    ],
    link: { href: safeUrl(p.url), text: "Utility website" },
    source: `${str(p.source) ?? "CEC Electric Load Serving Entities"}${date ? ` (${date.slice(0, 10)})` : ""}`,
  });
}

function assetCard(p: Props): HTMLElement {
  const kind = str(p.kind);
  const label = kind && kind in ASSET_LABEL ? ASSET_LABEL[kind as keyof typeof ASSET_LABEL] : (kind ?? "Asset");
  const cap = num(p.capacity_mw);
  const dur = num(p.duration_h);
  return card({
    title: str(p.name) ?? label,
    subtitle: `${label} · ${fmtMw(cap)}${dur !== null ? ` · ${dur} h` : ""}`,
    rows: [],
    source: "Scenario asset (planned)",
  });
}

/** County under the interconnection-queue choropleth (properties added to the boundaries layer by the backend). */
function queueCard(p: Props): HTMLElement {
  const n = num(p.queue_active_projects);
  const mw = num(p.queue_active_mw);
  const ia = num(p.queue_ia_executed_mw);
  let subtitle: string;
  if (n === null || mw === null) subtitle = "No queue data for this county";
  else if (n === 0) subtitle = "No active interconnection requests";
  else subtitle = `${n.toLocaleString()} active request${n === 1 ? "" : "s"} · ${fmtCap(mw)}${ia !== null && ia > 0 ? ` (${fmtCap(ia)} with signed agreements)` : ""}`;
  return card({
    title: str(p.full_name) ?? countyLabel(str(p.name)),
    subtitle,
    rows: [["Note", n ? "Requested capacity, not a build forecast" : null]],
    source: QUEUE_CREDIT,
  });
}

function isAssetKind(k: string | null): k is AssetKind {
  return k !== null && k in ASSET_LABEL;
}

/** A scenario asset's land footprint (footprints.ts): MW x acres/MW (batteries also x hours/4). */
function footprintCard(p: Props): HTMLElement {
  const kind = str(p.kind);
  const label = isAssetKind(kind) ? ASSET_LABEL[kind] : (kind ?? "Asset");
  const name = str(p.name);
  const hours = num(p.duration_h);
  const facts = `${fmtMw(num(p.capacity_mw))}${hours !== null ? ` / ${hours} h` : ""} · ${fmtAcres(num(p.acres))} (${fmtKm2(num(p.area_km2))}) at ${fmtPerMw(num(p.land_acres_per_mw))} acres/MW`;
  const notes = [
    p.min_display === true ? "Not to scale: minimum display size" : null,
    kind === "onshore_wind" ? "Wind area is turbine spacing; most of the land stays usable" : null,
    hours !== null && hours !== BATTERY_REF_HOURS ? `Land rate is for a ${BATTERY_REF_HOURS} h system, scaled by ${hours}/${BATTERY_REF_HOURS}` : null,
  ].filter(Boolean);
  return card({
    title: name ?? label,
    swatch: isAssetKind(kind) ? FUEL_COLOR[ASSET_FUEL[kind]] : undefined,
    subtitle: name ? `${label} · ${facts}` : facts,
    rows: [
      ["Note", notes.length ? notes.join(". ") : null],
      ["Land use", `Estimate (assumption): ${str(p.lapm_source) ?? "Evaluate catalog"}`],
      ["Layout", p.placed === "auto" ? "Schematic, east of the site" : "At the asset's location"],
      ["Height", "Schematic, for legibility"],
    ],
    link: { href: str(p.source_url), text: "Land-use study" },
    source: str(p.source) ?? "Evaluate catalog land-use assumption",
  });
}

function siteCard(p: Props): HTMLElement {
  return card({ title: str(p.name) ?? "Selected site", subtitle: str(p.coords), rows: [], source: null });
}

/** What the demand-growth popup needs from the current forecast. */
export interface DemandInfo {
  county: CountyForecast | null;
  year: number;
  baseYear: number;
  scenario: string;
  regionName: string | null;
}

const signed = (v: number) => (Math.round(v) === 0 ? "0 MW" : `${v > 0 ? "+" : "−"}${fmtMw(Math.abs(v))}`);

/** County under the demand-growth choropleth: its new P90 peak by the target year. */
export function demandCard(p: Props, info: DemandInfo | null): HTMLElement {
  const title = str(p.full_name) ?? countyLabel(str(p.name));
  const c = info?.county;
  if (!info || !c) return card({ title, subtitle: "No demand estimate for this county", rows: [], source: null });
  const added = num(c.added_load_mw) ?? 0;
  return card({
    title,
    subtitle: `${signed(c.growth_peak_mw_p90)} P90 peak by ${info.year}${added > 0 ? ` (incl. ${fmtMw(added)} new data centers)` : ""}`,
    rows: [
      ["Peak (P90)", `${fmtMw(c.base_peak_mw)} in ${info.baseYear} → ${fmtMw(c.peak_mw_p90)}`],
      ["Region", info.regionName ?? str(c.region)],
      ["Scenario", info.scenario],
      ["Note", "Estimate: regional load split by population"],
    ],
    source: DEMAND_CREDIT,
  });
}

/** A recommended site (B's ranking) with a button that makes it the scenario site. */
export function recSiteCard(p: Props, onUse: () => void): HTMLElement {
  const kind = str(p.kind);
  const label = isAssetKind(kind) ? ASSET_LABEL[kind] : (kind ?? "Site");
  const capex = num(p.capex_usd);
  const tie = num(p.gen_tie_usd);
  const lineKm = num(p.d_line_hv_km);
  const root = card({
    title: label,
    swatch: isAssetKind(kind) ? FUEL_COLOR[ASSET_FUEL[kind]] : undefined,
    subtitle: ["Recommended site", fmtMw(num(p.mw)), str(p.county) ? countyLabel(str(p.county)) : null].filter(Boolean).join(" · "),
    rows: [
      ["Why here", str(p.reason)],
      ["CAPEX", capex !== null ? `${usd(capex)} (estimate)` : null],
      ["Gen-tie", tie !== null ? `${usd(tie)}${lineKm !== null ? ` · ${lineKm.toFixed(1)} km to a 220 kV+ line` : ""}` : null],
    ],
    source: "Screening candidate, not a buildable site: needs a utility interconnection study",
  });
  const button = el("button", "mt-2 w-full rounded bg-zinc-900 px-2 py-1 text-xs font-medium text-white hover:bg-zinc-700", "Use this site");
  button.type = "button";
  button.addEventListener("click", onUse);
  // Before the source line, right under the facts.
  root.insertBefore(button, root.lastElementChild);
  return root;
}

/** Popup content for a feature of one of our clickable layers. */
export function popupContent(layerId: string, properties: Props | null | undefined): HTMLElement {
  const p = properties ?? {};
  if (layerId === "zoning-fill") return card({ title: str(p.Code) ?? "Zoning code unavailable", subtitle: str(p.Description),
    rows: [["Jurisdiction", str(p.Jurisdiction)], ["Class", str(p.New_Class)], ["Recorded date", str(p.Date)]],
    source: `${str(p.Source) ?? "California LCI"}. Historical screening; verify current allowed uses with the jurisdiction.` });
  if (layerId.startsWith("footprints")) return footprintCard(p);
  if (layerId === "queue-fill") return queueCard(p);
  if (layerId.startsWith("plants")) return plantCard(p);
  if (layerId.startsWith("substations")) return substationCard(p);
  if (layerId.startsWith("transmission")) return lineCard(p);
  if (layerId.startsWith("utilities")) return utilityCard(p);
  if (layerId === "assets") return assetCard(p);
  return siteCard(p);
}
