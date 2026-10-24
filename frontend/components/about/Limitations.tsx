// "Limitations & honesty notes": what Griddy is not, said plainly. Each point traces to a caveat in
// the code or a data README, so it stays true when numbers move.
import { Card, Section } from "./ui";

const GROUPS: { title: string; points: string[] }[] = [
  {
    title: "It is a screening tool",
    points: [
      "Griddy shows whether a design is worth a closer look, not that it can be built. Every real project needs a utility interconnection study (CAISO cluster study, or the utility's Rule 21 / WDAT process for small ties), site studies and permits.",
      "Public maps show where lines and substations are, not how much spare capacity they have. That is why every site and every connection carries a “needs a utility study” flag.",
      "Interconnection cost assumes flat rural terrain and excludes right of way, permitting, mitigation and network upgrades. Real gen-tie routes are longer than the straight-line distances used here.",
      "The bill of materials is a count from nameplate and typical unit sizes, not an engineered design.",
    ],
  },
  {
    title: "The simulated year",
    points: [
      "One weather and price year (2024). A different year, or a drier, hotter one, would change the answers; the stress tests probe some of that.",
      "Dispatch is a transparent rule set, not an optimizer. Battery grid charging uses perfect 24-hour foresight of prices, demand and solar, which is an upper bound on what it can earn.",
      "Gas runs at its full-load heat rate at every output (no part-load penalty), which understates fuel and CO₂ for units that idle.",
      "Grid carbon is CAISO's average hourly intensity, not the marginal plant's. CARB's import factor is shown as the more conservative alternative.",
      "Firm-capacity credits are screening proxies, not an ELCC or resource-adequacy study.",
    ],
  },
  {
    title: "Costs and emissions",
    points: [
      "No tax credits or incentives (no IRA credits), so clean options look more expensive than many real deals. Exports earn nothing by default.",
      "NOx uses lean-premix turbines without SCR (conservative); PM2.5 counts all particulate matter as PM2.5 (an upper bound). Upstream methane is reported but off by default and never priced.",
      "Land is project area: wind's 85 acres per MW is mostly farmable spacing; its direct footprint is 2.47 acres per MW.",
      "Jobs and offtake contract numbers are illustrative assumptions, not an economic-impact model.",
    ],
  },
  {
    title: "Forecast and siting",
    points: [
      "The trained forecast model predicts the hourly shape of demand, not its long-term level: growth comes from scenario assumptions. On test data its P10–P90 band held about half of the hours, not 80%, so P90 is a hot-weather planning case rather than a calibrated probability. Without a trained artifact the API falls back to observed 2024 demand (mode scenario_on_observed, where P50 = P90) and says so.",
      "County demand is regional load split by population, so industrial counties read low. Long-term growth is a scenario, not a prediction, and today's load shape is reused for 2040.",
      "“Suitability” means “looks like where plants of this type were built”, not a feasibility study. Land ownership, zoning, habitat and grid capacity are not modeled. The trained classifier scores the sites; the documented screening blend (heuristic-v1) is its fallback, and the API's mode field says which one answered.",
      "Substations are volunteer-mapped in OpenStreetMap: about half have no voltage tag and some may be missing. Queue MW is requested capacity; only about 13% of capacity requested in 2000–2020 was ever built.",
    ],
  },
];

export function Limitations() {
  return (
    <Section
      id="limits"
      title="Limitations and honesty notes"
      lead="Judges and planners should know where the numbers stop. Every estimate in the app is labeled as one."
    >
      <div className="grid gap-3 md:grid-cols-2">
        {GROUPS.map((g) => (
          <Card key={g.title}>
            <h3 className="font-semibold">{g.title}</h3>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-zinc-700 marker:text-zinc-400 dark:text-zinc-300">
              {g.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </Section>
  );
}
