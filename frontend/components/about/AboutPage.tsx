// The /about page: mission, what Griddy does, how to use it, the math (every equation as the code
// runs it), data sources, team and limitations. Pure server components, so the whole page, MathML
// included, is static HTML in the Cloudflare Pages export.
//
// Theme: dark: utilities follow <html data-theme>. The page root carries `data-chrome`, so in the
// Mixed theme (black panels, light map) the whole page, which has no map, uses the black chrome
// palette defined in globals.css. The header's gear is the shell's SettingsButton, the only client
// component here.
import Link from "next/link";

// The shell's gear + Settings drawer (a client island; the rest of the page stays server-rendered).
import { SettingsButton } from "@/components/settings/SettingsButton";

import { DataSources } from "./DataSources";
import { HowToUse } from "./HowToUse";
import { Mission, WhatItDoes } from "./Intro";
import { Limitations } from "./Limitations";
import { MathSection } from "./MathSection";
import { Team } from "./Team";

const TOC: { id: string; label: string; children?: { id: string; label: string }[] }[] = [
  { id: "mission", label: "Mission" },
  { id: "what", label: "What Griddy does" },
  { id: "how", label: "How to use it" },
  {
    id: "math",
    label: "The math",
    children: [
      { id: "math-simulate", label: "Simulating the year" },
      { id: "math-costs", label: "Costs" },
      { id: "math-carbon", label: "Carbon and air" },
      { id: "math-forecast", label: "Forecast and siting" },
    ],
  },
  { id: "data", label: "Data sources" },
  { id: "team", label: "Team" },
  { id: "limits", label: "Limitations" },
];

function Header() {
  return (
    <header
      data-chrome
      className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-200 bg-white/90 px-4 py-2 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90"
    >
      <Link href="/" className="text-lg font-bold">
        Griddy
      </Link>
      <span className="text-sm text-zinc-500 dark:text-zinc-400">About</span>
      <span className="ml-auto" />
      <SettingsButton />
      <Link
        href="/"
        className="rounded bg-emerald-800 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700 dark:bg-cyan-300 dark:text-slate-950 dark:hover:bg-cyan-200"
      >
        ← Back to the app
      </Link>
    </header>
  );
}

function Contents() {
  const link = "block rounded px-2 py-1 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-900 dark:hover:text-zinc-100";
  return (
    <nav aria-label="On this page" className="text-sm text-zinc-600 lg:sticky lg:top-16 dark:text-zinc-300">
      <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">On this page</p>
      <ul className="flex flex-wrap gap-x-1 gap-y-0.5 lg:block lg:space-y-0.5">
        {TOC.map((t) => (
          <li key={t.id}>
            <a href={`#${t.id}`} className={link}>
              {t.label}
            </a>
            {t.children && (
              <ul className="hidden border-l border-zinc-200 pl-2 text-xs lg:ml-2 lg:block dark:border-zinc-800">
                {t.children.map((c) => (
                  <li key={c.id}>
                    <a href={`#${c.id}`} className={link}>
                      {c.label}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function AboutPage() {
  return (
    <div data-chrome className="flex min-h-screen flex-1 flex-col bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-100">
      <Header />
      <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-8 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10">
        <aside className="min-w-0">
          <Contents />
        </aside>
        <main className="min-w-0 max-w-3xl space-y-12">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800 dark:text-cyan-300">About Griddy</p>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Plan the power for a gigawatt, hour by hour, with the receipts.</h1>
            <p className="text-[0.95rem] leading-relaxed text-zinc-600 dark:text-zinc-300">
              Griddy puts a new AI campus or community on a real map of California&apos;s grid, designs its power supply, simulates every
              hour of 2024, and shows the cost, carbon and risks with a source behind every number.
            </p>
          </div>
          <Mission />
          <WhatItDoes />
          <HowToUse />
          <MathSection />
          <DataSources />
          <Team />
          <Limitations />
          <footer className="border-t border-zinc-200 pt-4 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            Griddy · Stanford Cleantech Hackathon 2026 · Screening estimates only; not engineering, financial or legal advice.{" "}
            <Link href="/" className="underline underline-offset-2">
              Back to the app
            </Link>
          </footer>
        </main>
      </div>
    </div>
  );
}
