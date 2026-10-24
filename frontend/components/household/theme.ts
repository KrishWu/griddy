// Griddy Home chart colors and labels. Series hues are the dataviz reference palette's categorical
// slots (the same steps chartTheme.ts and simulate/DispatchChart.tsx use), as CSS variables with
// light and dark steps so the SVG fills follow the theme (and Mixed's black chrome). Put HH_VARS
// next to CHART_VARS on a chart wrapper. Resources keep one color everywhere (provider mix and
// CAISO mix alike): color follows the entity. The resource stack order was checked with the
// dataviz validator (adjacent-pair CVD separation >= 8.4 in both modes); "imports & other" is a
// deliberate neutral, and every bar carries a value label or a table twin.
// OWNER: household (frontend).

export const HH_VARS = [
  "[--hh-summer:#eb6834] dark:[--hh-summer:#d95926]",
  "[--hh-winter:#2a78d6] dark:[--hh-winter:#3987e5]",
  "[--hh-band:#a1a1aa] dark:[--hh-band:#71717a]",
  "[--hh-ink:#18181b] dark:[--hh-ink:#f4f4f5]",
  "[--hh-surface:#ffffff] dark:[--hh-surface:#09090b]",
  "[--hh-solar:#eda100] dark:[--hh-solar:#c98500]",
  "[--hh-wind:#1baf7a] dark:[--hh-wind:#199e70]",
  "[--hh-hydro:#2a78d6] dark:[--hh-hydro:#3987e5]",
  "[--hh-nuclear:#e87ba4] dark:[--hh-nuclear:#d55181]",
  "[--hh-renew:#008300] dark:[--hh-renew:#008300]",
  "[--hh-battery:#6250d6] dark:[--hh-battery:#9085e9]",
  "[--hh-gas:#eb6834] dark:[--hh-gas:#d95926]",
  "[--hh-other:#a1a1aa] dark:[--hh-other:#71717a]",
  "[--hh-clean:#008300] dark:[--hh-clean:#1baf7a]",
  "[--hh-dirty:#eb6834] dark:[--hh-dirty:#d95926]",
  "[--hh-actions:#1baf7a] dark:[--hh-actions:#199e70]",
].join(" ");

/** Resource groups for both mixes, in stack order (bottom to top). */
export const RESOURCE_GROUPS = [
  { key: "nuclear", label: "Nuclear", color: "var(--hh-nuclear)", clean: true },
  { key: "renew", label: "Geothermal & bio", color: "var(--hh-renew)", clean: true },
  { key: "hydro", label: "Hydro", color: "var(--hh-hydro)", clean: true },
  { key: "wind", label: "Wind", color: "var(--hh-wind)", clean: true },
  { key: "solar", label: "Solar", color: "var(--hh-solar)", clean: true },
  { key: "battery", label: "Batteries", color: "var(--hh-battery)", clean: false },
  { key: "gas", label: "Natural gas", color: "var(--hh-gas)", clean: false },
  { key: "other", label: "Imports & other", color: "var(--hh-other)", clean: false },
] as const;
export type ResourceGroup = (typeof RESOURCE_GROUPS)[number]["key"];

/** Map any backend resource key (PCL or CAISO column names) onto a group. */
export function resourceGroup(key: string): ResourceGroup {
  const k = key.toLowerCase().replace(/_mw$/, "");
  if (k.includes("solar")) return "solar";
  if (k.includes("wind")) return "wind";
  if (k.includes("hydro")) return "hydro";
  if (k.includes("nuclear")) return "nuclear";
  if (k.includes("geo") || k.includes("bio")) return "renew";
  if (k.includes("batter") || k.includes("storage")) return "battery";
  if (k.includes("gas")) return "gas";
  return "other";
}

const RESOURCE_LABELS: Record<string, string> = {
  solar: "Solar",
  wind: "Wind",
  geothermal: "Geothermal",
  biomass: "Biomass",
  biogas: "Biogas",
  biomass_biowaste: "Biomass & waste",
  biomass_biogas: "Biomass & biogas",
  coal_petroleum: "Coal & oil",
  emerging_technologies: "Emerging tech",
  eligible_hydro: "Small hydro",
  small_hydro: "Small hydro",
  large_hydro: "Large hydro",
  nuclear: "Nuclear",
  natural_gas: "Natural gas",
  coal: "Coal",
  batteries: "Batteries",
  imports: "Imports",
  unspecified: "Unspecified power",
  other: "Other",
};
export const resourceLabel = (k: string) => RESOURCE_LABELS[k] ?? k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

const PERIOD_LABELS: Record<string, string> = {
  peak: "Peak",
  part_peak: "Part-peak",
  off_peak: "Off-peak",
  super_off_peak: "Super off-peak",
};
export const periodLabel = (p: string) => PERIOD_LABELS[p] ?? p.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
/** Band strength for the TOU wash behind load charts (0 = no band). */
export const periodBand = (p: string) => (p === "peak" ? 0.22 : p === "part_peak" ? 0.1 : 0);

const END_USE_LABELS: Record<string, string> = {
  base: "Everything else",
  ev: "EV charging",
  cooling: "Air conditioning",
  heating: "Electric heating",
  laundry: "Laundry",
  dishwasher: "Dishwasher",
};
export const endUseLabel = (k: string) => END_USE_LABELS[k] ?? k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** "E-TOU-C: Time-of-Use (peak 4–9 p.m.)" -> "E-TOU-C"; the description after the colon, if any. */
export const shortPlan = (label: string) => label.split(":")[0].trim();
export const planBlurb = (label: string) => (label.includes(":") ? label.slice(label.indexOf(":") + 1).trim() : "");

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
