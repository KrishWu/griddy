// "How to use it": a sketch of the app's layout and a step-by-step walk through it. Describes the
// tabbed layout (left: Plan · Site · Layers · Build; right: Summary, or Simulate · Costs · Stress ·
// Report in Advanced), the header toggles, the Forecast drawer, Report and Settings.
import type { ReactNode } from "react";

import { Section } from "./ui";

/** A tab name as it appears in the app. */
function Tab({ children }: { children: ReactNode }) {
  return (
    <span className="whitespace-nowrap rounded border border-zinc-300 bg-white px-1.5 py-px text-[0.8em] font-semibold text-zinc-800 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100">
      {children}
    </span>
  );
}

/** A button label as it appears in the app. */
function Btn({ children }: { children: ReactNode }) {
  return <span className="whitespace-nowrap font-semibold text-emerald-800 dark:text-cyan-300">&ldquo;{children}&rdquo;</span>;
}

function Zone({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 rounded-md border border-zinc-300 p-2 dark:border-zinc-700 ${className}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{title}</p>
      <div className="mt-1 flex flex-wrap gap-1 text-xs">{children}</div>
    </div>
  );
}

function LayoutSketch() {
  return (
    <figure className="space-y-2">
      <div
        className="space-y-2 rounded-lg border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-950"
        role="img"
        aria-label="App layout: a header with mode toggles, Settings and About; a left sidebar with Plan, Site, Layers and Build tabs; the map in the middle with search, California, Site and Forecast buttons; and a right sidebar with Summary in Basic mode or Simulate, Costs, Stress and Report in Advanced mode."
      >
        <Zone title="Header">
          <Tab>Basic | Advanced</Tab>
          <Tab>Single | Compare</Tab>
          <Tab>Industrial | Community</Tab>
          <Tab>⚙ Settings</Tab>
          <Tab>About</Tab>
          <Tab>Report</Tab>
        </Zone>
        <div className="grid gap-2 md:grid-cols-[1fr_1.6fr_1fr]">
          <Zone title="Left sidebar">
            <Tab>Plan</Tab>
            <Tab>Site</Tab>
            <Tab>Layers</Tab>
            <Tab>Build</Tab>
            <span className="w-full text-[11px] text-zinc-500 dark:text-zinc-400">Build is in Advanced only</span>
          </Zone>
          <Zone title="Map" className="bg-emerald-50/60 dark:bg-emerald-950/20">
            <Tab>Search</Tab>
            <Tab>California</Tab>
            <Tab>Site</Tab>
            <Tab>Forecast</Tab>
            <Tab>Highlight area</Tab>
          </Zone>
          <Zone title="Right sidebar">
            <span className="w-full text-[11px] text-zinc-500 dark:text-zinc-400">Basic:</span>
            <Tab>Summary</Tab>
            <span className="w-full text-[11px] text-zinc-500 dark:text-zinc-400">Advanced:</span>
            <Tab>Simulate</Tab>
            <Tab>Costs</Tab>
            <Tab>Stress</Tab>
            <Tab>Report</Tab>
          </Zone>
        </div>
      </div>
      <figcaption className="text-xs text-zinc-500 dark:text-zinc-400">
        Either sidebar folds to a slim rail so the map can use the full width. On a phone, Plan/Site/Layers/Build sit above the map and
        the results below it.
      </figcaption>
    </figure>
  );
}

const STEPS: { title: string; body: ReactNode }[] = [
  {
    title: "Find a site",
    body: (
      <>
        Type a city, county, power plant, substation or lat, lon into the map&apos;s search box, or click the map.{" "}
        <Btn>California</Btn> zooms out to the whole state and <Btn>Site</Btn> flies back to yours. Clicking a site opens the{" "}
        <Tab>Site</Tab> tab on the left (on a phone, tap it above the map): the nearest substation and transmission line with their
        voltage and distance, plus the satellite and air-quality screening.
      </>
    ),
  },
  {
    title: "Plan the project",
    body: (
      <>
        In <Tab>Plan</Tab>, enter the facility peak demand and load factor, pick a plant type and press <Btn>Size plant for demand</Btn>
        . Check the proposal (projected peak, cost, carbon, unmet hours) and press <Btn>Use this design</Btn>. Want to know who lives
        nearby? <Btn>Highlight area</Btn> on the map lets you draw an area and see its people and household demand.
      </>
    ),
  },
  {
    title: "Choose what the map shows",
    body: (
      <>
        <Tab>Layers</Tab> turns plants, transmission lines, substations, boundaries, the interconnection queue and the other overlays on
        and off, and holds the legend.
      </>
    ),
  },
  {
    title: "Fine-tune the design (Advanced)",
    body: (
      <>
        Switch the header to <Tab>Advanced</Tab> and open <Tab>Build</Tab>: start from a preset, change each asset&apos;s size (and a
        battery&apos;s hours), the grid connection (import and export limits, length of the new line) and the assumptions (discount
        rate, gas price, carbon price, analysis period, import adder). Every change re-runs the whole year.
      </>
    ),
  },
  {
    title: "Read the results",
    body: (
      <>
        In Basic, the right sidebar&apos;s <Tab>Summary</Tab> has the headline numbers and the report link. In Advanced:{" "}
        <Tab>Simulate</Tab> is the hour-by-hour dispatch chart (pick any day), <Tab>Costs</Tab> has NPC, LCOE, the cost waterfall,
        emissions, the 24/7 CFE score, the bill of materials and the method notes, <Tab>Stress</Tab> lists every finding by severity
        (look for &ldquo;needs a utility study&rdquo;), and <Tab>Report</Tab> has the report link and CSV export. Hover any number
        with a source icon to see where it came from; dotted-underlined jargon explains itself.
      </>
    ),
  },
  {
    title: "Compare designs",
    body: (
      <>
        <Tab>Single | Compare</Tab> in the header puts the presets side by side: cost, carbon, clean-energy hours and air pollutants.{" "}
        <Tab>Industrial | Community</Tab> switches between an AI campus and a community microgrid.
      </>
    ),
  },
  {
    title: "Look ahead",
    body: (
      <>
        <Btn>Forecast</Btn> on the map opens the forecast drawer: pick the low, mid or high scenario and a target year, adjust
        population, electrification, efficiency and new data centers, and see peak demand by region and county. Its Sites panel places
        the new capacity on the map; <Btn>Use this site</Btn> moves your project there.
      </>
    ),
  },
  {
    title: "Share it",
    body: (
      <>
        <Tab>Report</Tab> in the header opens a printable report with every assumption and source: <Btn>Download CSV</Btn> or{" "}
        <Btn>Print / Save as PDF</Btn>.
      </>
    ),
  },
  {
    title: "Make it comfortable",
    body: (
      <>
        The <Tab>⚙ Settings</Tab> gear (on this page too) sets the theme (Auto follows your device; Light; Dark; or Mixed: black panels
        with a light map), text size, jargon tooltips, reduced motion, the basemap, map contrast and brightness, and which sidebars are
        folded.
      </>
    ),
  },
];

export function HowToUse() {
  return (
    <Section id="how" title="How to use it" lead="Nine steps from an empty map to a report you can hand to someone.">
      <LayoutSketch />
      <ol className="space-y-3">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flex gap-3">
            <span
              aria-hidden
              className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-800 text-xs font-bold text-white dark:bg-cyan-300 dark:text-slate-950"
            >
              {i + 1}
            </span>
            <div className="min-w-0 space-y-0.5">
              <h3 className="font-semibold">{s.title}</h3>
              <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}
