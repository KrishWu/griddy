// "The math": the defaults every run starts from, then the equations in the order a run uses them
// (simulate -> costs -> carbon -> forecast/sites). Each value below is the code's default; most are
// editable in the app (Plan / Build / Assumptions, the Forecast drawer).
import { MathCarbon } from "./MathCarbon";
import { MathCosts } from "./MathCosts";
import { MathForecast } from "./MathForecast";
import { MathSimulate } from "./MathSimulate";
import { Card, Section } from "./ui";

const DEFAULTS: [label: string, value: string, source: string][] = [
  ["Discount rate", "7% / yr, real", "Griddy default, editable"],
  ["Analysis horizon", "20 years", "Griddy default, editable"],
  ["Dollars", "real 2024 USD", "BLS CPI-U: ×1.029494 from 2023$, ×0.974362 from 2025$"],
  ["Weather and prices", "2024, 8,784 hours", "Open-Meteo; CAISO OASIS day-ahead LMP"],
  ["Gas price", "$3.65 / MMBtu", "EIA 2024 California citygate (N3050CA3)"],
  ["Import delivery adder", "$20 / MWh", "assumption (transmission access + delivery)"],
  ["Carbon price", "$0 / t (on-site combustion only)", "editable; CA allowance $32.48/t (Aug 2026 auction) shown as a hint"],
  ["Gas CO₂ factor", "53.06 kg CO₂ / MMBtu", "EPA 40 CFR 98, Table C-1"],
  ["CARB unspecified imports", "0.428 t CO₂e / MWh × 1.02", "17 CCR 95111(b)(1)"],
  ["Heat rate, CC / CT", "6.087 / 9.717 MMBtu / MWh", "NLR ATB 2025, full load"],
  ["Battery", "85% round trip, 4 h default", "NLR ATB 2025"],
  ["Lifetimes", "PV, wind, gas 30 yr · battery 15 · grid tie 47", "ATB 2025 Definitions; PG&E 2027 GRC depreciation study"],
  ["NOx / PM2.5", "0.099 / 0.0066 lb / MMBtu", "EPA AP-42 §3.1 (no SCR; total PM as PM2.5)"],
  ["Upstream methane (off)", "12.47 kg CO₂e / MMBtu", "Alvarez et al. 2018 (2.3% leak); IPCC AR6 GWP100 29.8"],
  ["Unserved energy (dispatch only)", "$1,000 / MWh", "assumption; used only to choose the battery policy"],
];

export function MathSection() {
  return (
    <Section
      id="math"
      title="The math"
      lead={
        <>
          Every equation below is the one the code runs, with its symbols, units, where the result appears in the app, and the file it
          comes from. Nothing is fitted to make a design look good. Defaults first:
        </>
      }
    >
      <Card>
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {DEFAULTS.map(([label, value, source]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
              <dd className="font-semibold tabular-nums">{value}</dd>
              <dd className="text-xs text-zinc-500 dark:text-zinc-400">{source}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <MathSimulate />
      <MathCosts />
      <MathCarbon />
      <MathForecast />
    </Section>
  );
}
