// Mission + "What Griddy does": the plain-language half of the About page.
import { Card, Section } from "./ui";

const FEATURES: { title: string; body: string }[] = [
  {
    title: "Explore the real grid",
    body: "A map of California's power plants (EIA-860), transmission lines of 69 kV and up (CEC), substations (OpenStreetMap), utility and county boundaries (the balancing authority is shown in the site summary), and the interconnection queue by county (LBNL). Click anywhere for the nearest substation and line, their voltage and distance.",
  },
  {
    title: "Plan and build a power supply",
    body: "Enter the demand to serve and let Griddy size a hybrid, solar + storage, wind + storage, combined-cycle or peaker plant, or build your own mix of generation, batteries and a grid connection. Data-center load profiles are an optional customer use case.",
  },
  {
    title: "Simulate every hour of a year",
    body: "8,784 hours of 2024: real weather at the site, real CAISO prices and grid carbon, and a battery that charges and discharges hour by hour. Demand is met, or the shortfall is counted.",
  },
  {
    title: "Count the cost",
    body: "Up-front and yearly costs, net present cost and cost per MWh over 20 years in real 2024 dollars, from the national lab cost baseline (ATB 2025) and utility interconnection cost guides, plus a bill of materials and land use.",
  },
  {
    title: "Count the carbon and the air",
    body: "Annual operational CO₂e from on-site combustion and hourly grid imports, separately from a partial estimate of construction carbon. Show cumulative modeled carbon and carbon-price sensitivity, with editable reference footprints. NOx and PM2.5 come from on-site gas; the 24/7 carbon-free energy score checks every hour.",
  },
  {
    title: "Stress-test it",
    body: "A heat wave, the loss of the biggest gas unit, a three-day renewable drought, a full grid outage, firm capacity at the peak, and flags for everything that needs a real utility interconnection study.",
  },
  {
    title: "Screen the site",
    body: "Google Earth Engine land screening (land cover, fallowed farmland, slope, protected land, water, sunshine), Sentinel-2 imagery, air quality and EPA nonattainment areas, and carbon-aware scheduling of flexible AI load with a Green Software Foundation SCI score per GPU-hour.",
  },
  {
    title: "Look ahead",
    body: "County-level demand to 2030, 2035 and 2040 under editable scenarios (population, electrification, efficiency, new data centers), and recommended places to build the new capacity that growth needs.",
  },
  {
    title: "Show the work",
    body: "Every number carries a source and a kind: observed (read from data), assumption (a stated choice), simulated (Griddy's model) or inferred (derived from observed values). The report collects them all.",
  },
];

export function Mission() {
  return (
    <Section id="mission" title="Mission">
      <div className="space-y-3 text-[0.95rem] leading-relaxed text-zinc-700 dark:text-zinc-300">
        <p>
          Growing communities, electrification and new industry need more grid infrastructure. Before anyone files an interconnection
          request, the first questions are simple to ask and slow to answer: <em>where could this go, what would power it, what would it
          cost, how much carbon would it emit, and what could go wrong?</em>
        </p>
        <p>
          Griddy helps plan power plants, energy storage and grid connections. Choose a site on a real map of the grid, design infrastructure to serve demand, run every hour
          of a real year, and read the cost, the carbon and the risks, with a source behind every number and the caveats said out loud.
          It is a <strong>screening tool</strong> for planners, communities, developers and students, built at the Stanford Cleantech
          Hackathon 2026.
        </p>
        <p>Data centers are one optional demand profile. The primary workflow plans electricity infrastructure for an area&apos;s needs; it does not replace a utility interconnection study or detailed power-system design.</p>
      </div>
    </Section>
  );
}

export function WhatItDoes() {
  return (
    <Section id="what" title="What Griddy does">
      <ul className="grid gap-3 sm:grid-cols-2">
        {FEATURES.map((f) => (
          <li key={f.title} className="min-w-0">
            <Card className="h-full">
              <h3 className="font-semibold">{f.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">{f.body}</p>
            </Card>
          </li>
        ))}
      </ul>
    </Section>
  );
}
