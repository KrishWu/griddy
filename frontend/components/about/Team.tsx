// "Team": the five workstreams and who built them. Handle -> workstream comes ONLY from GitHub PR
// authorship (gh pr list --state all, 2026-10-24): each slice's own feature PR and its follow-ups.
// Update the PR numbers here if the history changes; never guess a mapping.
import { Card, Chip, Ext, Section } from "./ui";

type Stream = { letter: string; name: string; built: string; handle: string; prs: string };

const STREAMS: Stream[] = [
  {
    letter: "A",
    name: "Explore",
    built: "The California grid map: plants, transmission lines, substations and boundaries; the site summary (nearest substation and line); the interconnection queue by county and 2.5D asset footprints.",
    handle: "heruirayli",
    prs: "#5 ws/a-explore (queue + footprints first opened as #13, rebuilt on main as #15 by KrishWu)",
  },
  {
    letter: "B",
    name: "Simulate + Stress Test",
    built: "The 8,784-hour dispatch with real 2024 solar, wind, price and grid-carbon profiles, the battery logic, the stress tests and the dispatch charts.",
    handle: "JosephtheUnbelievable",
    prs: "#6 ws/b-simulate",
  },
  {
    letter: "C",
    name: "Evaluate",
    built: "The ATB 2025 cost catalog, CAPEX / OPEX / NPC / LCOE, emissions and air pollutants, the 24/7 CFE score and the bill of materials; later demand-led project planning, progressive zoning and map search.",
    handle: "10zingC",
    prs: "#4 ws/c-evaluate, #7 contract/gas-default, #23 feature/project-planning",
  },
  {
    letter: "D",
    name: "Build + Report + UI shell",
    built: "The scenario builder and presets, compare view, report export and the app shell; the shared foundation (contract, rename to Griddy, static export to Cloudflare Pages, Render backend).",
    handle: "KrishWu",
    prs: "#3 and #9–#12 ws/d-builder; foundation #1, #2, #14, #16, #17, #22, #24, #27, #29",
  },
  {
    letter: "E",
    name: "Site Intelligence + Pitch",
    built: "Earth Engine land screening, Sentinel-2 imagery, AirNow and nonattainment air-permit risk, carbon-aware flexible load with an SCI score, and the pitch.",
    handle: "shaleenb36",
    prs: "#8 ws/e-site-intel (GriddyGrade feasibility score open as #21; an ML-based version by JosephtheUnbelievable open as #30)",
  },
];

const PHASE2: { what: string; handle: string; prs: string }[] = [
  { what: "Phase 2 ML layout, model-artifact contract and API wiring; the demand forecast; the site-location model", handle: "heruirayli", prs: "#18, #19, #20" },
  { what: "The trained demand-forecast artifact (demand-20261024-104738)", handle: "KrishWu", prs: "#26" },
  { what: "The trained site-location model and its ranking on the forecast", handle: "10zingC", prs: "#25" },
];

function Handle({ handle }: { handle: string }) {
  return <Ext href={`https://github.com/${handle}`}>@{handle}</Ext>;
}

export function Team() {
  return (
    <Section
      id="team"
      title="Team"
      lead="Five people, five vertical slices, each with its own backend module, endpoint, panel, data and tests, merged into one app during the Stanford Cleantech Hackathon 2026."
    >
      <ul className="grid gap-3 sm:grid-cols-2">
        {STREAMS.map((s) => (
          <li key={s.letter} className="min-w-0">
            <Card className="h-full space-y-2">
              <div className="flex items-baseline gap-2">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-emerald-800 text-sm font-bold text-white dark:bg-cyan-300 dark:text-slate-950">
                  {s.letter}
                </span>
                <h3 className="font-semibold">{s.name}</h3>
              </div>
              <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">{s.built}</p>
              <p className="text-sm">
                <Handle handle={s.handle} />
              </p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">PRs: {s.prs}</p>
            </Card>
          </li>
        ))}
        <li className="min-w-0">
          <Card className="h-full space-y-2">
            <div className="flex items-baseline gap-2">
              <Chip>Phase 2</Chip>
              <h3 className="font-semibold">Forecast and where to build</h3>
            </div>
            <ul className="space-y-2 text-sm">
              {PHASE2.map((p) => (
                <li key={p.prs} className="leading-relaxed text-zinc-600 dark:text-zinc-300">
                  {p.what}: <Handle handle={p.handle} />{" "}
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">(PR {p.prs})</span>
                </li>
              ))}
            </ul>
          </Card>
        </li>
      </ul>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Who-built-what is taken from GitHub pull-request authorship only: each workstream&apos;s own feature branch and its follow-ups.
        Each person worked with their own coding agent under shared team rules.
      </p>
    </Section>
  );
}
