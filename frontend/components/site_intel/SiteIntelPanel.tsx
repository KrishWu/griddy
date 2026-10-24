"use client";
// Satellite + environmental screening, then carbon-aware load.  OWNER: workstream E (Site Intelligence).
import { FindingsList } from "@/components/shell/FindingsList";
import { Panel, Stat } from "@/components/shell/Panel";
import type { Provenance, SiteIntel } from "@/lib/contract";
import { pct } from "@/lib/format";
import { useGridForge } from "@/lib/store";

// ESA WorldCover's own legend colors, so the bar matches the dataset's maps.
const LAND_COLOR: Record<string, string> = {
  "Tree cover": "#006400",
  Shrubland: "#ffbb22",
  Grassland: "#ffff4c",
  Cropland: "#f096ff",
  "Built-up": "#fa0000",
  "Bare / sparse vegetation": "#b4b4b4",
  "Snow and ice": "#f0f0f0",
  "Permanent water bodies": "#0064c8",
  "Herbaceous wetland": "#0096a0",
  Mangroves: "#00cf75",
  "Moss and lichen": "#fae6a0",
};

// EPA AQI category colors.
const AQI_COLOR: Record<string, string> = {
  Good: "#00e400",
  Moderate: "#ffff00",
  "Unhealthy for Sensitive Groups": "#ff7e00",
  Unhealthy: "#ff0000",
  "Very Unhealthy": "#8f3f97",
  Hazardous: "#7e0023",
};

const TIER_LABEL: Record<string, string> = {
  offline_area: "precomputed demo-area grid",
  cache: "cached Earth Engine result",
  earth_engine: "live Earth Engine",
  unavailable: "unavailable",
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

// The app's clock is fixed UTC-8 (PST) all year, like every hourly array.
function pst(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const fmt = { timeZone: "Etc/GMT+8", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false } as const;
  return `${d.toLocaleString("en-US", fmt)} PST`;
}

function LandCoverBar({ landCover }: { landCover: Record<string, number> }) {
  const parts = Object.entries(landCover)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!parts.length) return null;
  return (
    <div className="mb-3">
      <div className="mb-1 text-[11px] text-zinc-500">Land cover (2 km buffer)</div>
      <div className="flex h-3 w-full overflow-hidden rounded">
        {parts.map(([k, v]) => (
          <div key={k} title={`${k} ${pct(v)}`} style={{ width: `${v * 100}%`, background: LAND_COLOR[k] ?? "#a1a1aa" }} />
        ))}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-zinc-600 dark:text-zinc-400">
        {parts
          .filter(([, v]) => v >= 0.02)
          .map(([k, v]) => (
            <span key={k} className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ background: LAND_COLOR[k] ?? "#a1a1aa" }} />
              {k} {pct(v)}
            </span>
          ))}
      </div>
    </div>
  );
}

function Chips({ intel }: { intel: SiteIntel }) {
  const x = intel.extras ?? {};
  const cdl = num(x.cdl_year);
  const chips: [string, number | null][] = [
    [`Fallow cropland${cdl ? ` (CDL ${cdl})` : ""}`, num(x.fallow_share)],
    ["Active cropland", num(x.active_crop_share)],
    ["Protected", num(x.protected_share)],
    ["Surface water", num(x.water_share)],
  ];
  const shown = chips.filter((c): c is [string, number] => c[1] !== null);
  if (!shown.length) return null;
  return (
    <div className="mb-3 flex flex-wrap gap-1.5">
      {shown.map(([label, v]) => (
        <span key={label} className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
          {label} <span className="font-semibold tabular-nums">{pct(v)}</span>
        </span>
      ))}
    </div>
  );
}

function Nonattainment({ intel }: { intel: SiteIntel }) {
  const areas = Array.isArray(intel.extras?.nonattainment) ? (intel.extras.nonattainment as Record<string, unknown>[]) : [];
  if (!areas.length) return null;
  return (
    <div className="mb-3 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      <span className="font-semibold">EPA nonattainment:</span>{" "}
      {areas
        .map((a) => [str(a.naaqs) ?? str(a.pollutant), str(a.classification)].filter(Boolean).join(" · "))
        .filter(Boolean)
        .join("; ")}
      {str(areas[0].area) && <span className="text-amber-700 dark:text-amber-400"> ({str(areas[0].area)})</span>}
    </div>
  );
}

function Sources({ provenance }: { provenance: Provenance[] }) {
  if (!provenance.length) return null;
  // Several numbers can share one source; list each source once.
  const unique = provenance.filter((p, i) => provenance.findIndex((q) => q.source === p.source && q.note === p.note) === i);
  return (
    <details className="mt-3 text-[11px] text-zinc-500">
      <summary className="cursor-pointer">Sources ({unique.length})</summary>
      <ul className="mt-1 space-y-1">
        {unique.map((p) => (
          <li key={`${p.source}-${p.note ?? ""}`}>
            <span className="uppercase text-zinc-400">{p.kind}</span>{" "}
            {p.url ? (
              <a href={p.url} target="_blank" rel="noreferrer" className="underline">
                {p.source}
              </a>
            ) : (
              p.source
            )}
            {p.note && <span className="text-zinc-400"> · {p.note}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Screening({ intel }: { intel: SiteIntel }) {
  const aq = intel.air_quality;
  const aqi = num(aq?.aqi);
  const category = str(aq?.category);
  const tier = str(intel.extras?.land_tier);
  const observed = str(aq?.observed_at);
  const aqSource = str(aq?.source) === "airnow_live" ? "live" : observed ? `snapshot ${pst(observed)}` : null;
  return (
    <>
      <div className="mb-3 grid grid-cols-3 gap-3">
        <Stat label="Mean slope" value={intel.mean_slope_deg != null ? `${intel.mean_slope_deg.toFixed(1)}°` : "–"} />
        <Stat label="Solar (GHI)" value={intel.solar_ghi_kwh_m2_day != null ? `${intel.solar_ghi_kwh_m2_day.toFixed(1)} kWh/m²/d` : "–"} />
        <div>
          <div className="text-[11px] text-zinc-500">AQI{str(aq?.pollutant) ? ` · ${str(aq?.pollutant)}` : ""}</div>
          <div className="flex items-center gap-1.5 text-lg font-semibold tabular-nums">
            {aqi ?? "–"}
            {category && <span className="h-2.5 w-2.5 rounded-full border border-zinc-300" style={{ background: AQI_COLOR[category] ?? "#a1a1aa" }} title={category} />}
          </div>
        </div>
      </div>
      <LandCoverBar landCover={intel.land_cover} />
      <Chips intel={intel} />
      <Nonattainment intel={intel} />
      <FindingsList findings={intel.findings} />
      <p className="mt-2 text-[11px] text-zinc-400">
        Land: {TIER_LABEL[tier ?? "unavailable"] ?? tier}
        {aqSource && ` · AQI: ${aqSource}${str(aq?.reporting_area) ? `, ${str(aq?.reporting_area)}` : ""}`}
      </p>
      <Sources provenance={intel.provenance} />
    </>
  );
}

export function SiteIntelPanel() {
  const { siteIntel } = useGridForge();
  return (
    <Panel title="Site intelligence" owner="E · Site intel">
      {siteIntel ? (
        <Screening intel={siteIntel} />
      ) : (
        <p className="text-sm text-zinc-500">Select a site on the map to screen its land, imagery and air quality.</p>
      )}
    </Panel>
  );
}
