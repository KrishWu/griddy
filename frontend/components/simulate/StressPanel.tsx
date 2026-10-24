"use client";
// Feasibility findings from every module, grouped by severity.  OWNER: workstream B (Simulate + Stress Test).
// Order fail > warn > info > pass, with a count per group; passing checks start collapsed.
// A card's metric/threshold line shows only numbers its own text doesn't already state.
import { Panel } from "@/components/shell/Panel";
import type { Finding, Severity } from "@/lib/contract";
import { useGridForge } from "@/lib/store";

const ORDER: Severity[] = ["fail", "warn", "info", "pass"];

// Same dot colors as the shared FindingsList.
const DOT: Record<Severity, string> = {
  pass: "bg-emerald-500",
  info: "bg-sky-500",
  warn: "bg-amber-500",
  fail: "bg-red-500",
};

const LABEL: Record<Severity, string> = { fail: "Fail", warn: "Warning", info: "Info", pass: "Pass" };

/** Compact, locale-independent number for metric/threshold values of unknown unit. */
function num(v: number): string {
  if (Math.abs(v) >= 100) return (Math.round(v) || 0).toLocaleString("en-US");
  return String(Number(v.toPrecision(3)));
}

const finiteOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Quantities written in a card's text ("1,032 MW", "+14.6%"). Clock times aren't quantities. */
function writtenNumbers(text: string): { value: number; decimals: number; percent: boolean }[] {
  const out: { value: number; decimals: number; percent: boolean }[] = [];
  for (const m of text.replace(/\d{1,2}:\d{2}/g, " ").matchAll(/(\d[\d,]*)(?:\.(\d+))?(\s*%)?/g)) {
    out.push({ value: Number(`${m[1].replace(/,/g, "")}.${m[2] ?? "0"}`), decimals: m[2]?.length ?? 0, percent: !!m[3] });
  }
  return out;
}

/** True when the text states v at its written precision: as itself, or a fraction as a percent. */
function statesValue(text: string, v: number): boolean {
  const a = Math.abs(v);
  const same = (x: number, w: { value: number; decimals: number }) => Number(x.toFixed(w.decimals)) === w.value;
  return writtenNumbers(text).some((w) => same(a, w) || (w.percent && same(a * 100, w)));
}

/** The metric line, or null when it would only repeat (bare, without units) what the card
 *  says. A stated metric next to an internal threshold read as a second, contradictory
 *  verdict ("0.146 vs threshold 0.15" under "+15% margin"; "6,520 vs threshold 26,004" on
 *  a check that passed), so the card's own words win. */
function metricText(f: Finding): string | null {
  const m = finiteOrNull(f.metric);
  const t = finiteOrNull(f.threshold);
  const text = `${f.title} ${f.detail}`;
  if (m !== null && statesValue(text, m)) return null;
  if (m === null && t !== null && statesValue(text, t)) return null;
  if (m === 0 && f.severity === "pass") return null; // the title's "none", restated as 0
  if (m !== null && t !== null) return `${num(m)} vs threshold ${num(t)}`;
  if (m !== null) return `metric ${num(m)}`;
  if (t !== null) return `threshold ${num(t)}`;
  return null;
}

export function StressPanel() {
  const { result } = useGridForge();
  if (!result) return null;
  const findings = result.findings;
  const study = findings.filter((f) => f.needs_utility_study).length;
  return (
    <Panel title="Stress test" owner="B · Stress">
      {!findings.length ? (
        <p className="text-sm text-zinc-500">No findings.</p>
      ) : (
        <div className="space-y-2">
          {study > 0 && (
            <p className="text-[11px] text-amber-700 dark:text-amber-500">
              {study} finding{study === 1 ? "" : "s"} need{study === 1 ? "s" : ""} a utility interconnection study.
            </p>
          )}
          {ORDER.map((sev) => {
            const group = findings.filter((f) => f.severity === sev);
            if (!group.length) return null;
            return (
              <details key={sev} open={sev !== "pass"} className="group">
                <summary className="flex cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden gap-2 select-none text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                  <span className="w-2 text-[10px] text-zinc-400 transition-transform group-open:rotate-90">›</span>
                  <span className={`h-2 w-2 rounded-full ${DOT[sev]}`} />
                  {LABEL[sev]}
                  <span className="rounded-full bg-zinc-100 px-1.5 text-[10px] font-medium tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                    {group.length}
                  </span>
                </summary>
                <ul className="mt-1.5 mb-1 space-y-2 pl-4">
                  {group.map((f, i) => (
                    <FindingItem key={`${f.module}-${f.id}-${i}`} f={f} />
                  ))}
                </ul>
              </details>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function FindingItem({ f }: { f: Finding }) {
  const metric = metricText(f);
  return (
    <li className="flex gap-2 text-sm">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[f.severity]}`} />
      <div className="min-w-0">
        <div className="font-medium">
          {f.title}
          <span className="ml-2 inline-block rounded border border-zinc-200 px-1 align-middle whitespace-nowrap text-[10px] font-normal uppercase text-zinc-500 dark:border-zinc-700">
            {f.module}
          </span>
          {f.needs_utility_study && (
            <span className="ml-1.5 inline-block rounded bg-amber-100 px-1 align-middle whitespace-nowrap text-[10px] font-medium uppercase text-amber-800 dark:bg-amber-950 dark:text-amber-400">
              needs utility study
            </span>
          )}
        </div>
        <div className="text-zinc-500">{f.detail}</div>
        {metric && <div className="mt-0.5 text-[11px] tabular-nums text-zinc-400">{metric}</div>}
      </div>
    </li>
  );
}
