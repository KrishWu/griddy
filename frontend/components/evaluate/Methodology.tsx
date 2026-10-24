"use client";
// Methodology footnotes from extras.methodology, in the spec's topic order. The
// contract's financial boundary is always shown under the panel, so it isn't repeated
// here unless the backend wrote its own "boundary" note. OWNER: workstream C (Evaluate).
import { METHODOLOGY_TOPICS } from "./extras";

export function Methodology({ methodology }: { methodology: Record<string, string> }) {
  const known = new Set(METHODOLOGY_TOPICS.map((t) => t.key));
  const notes = [
    ...METHODOLOGY_TOPICS.filter((t) => methodology[t.key]).map((t) => ({ key: t.key, title: t.title, text: methodology[t.key] })),
    ...Object.keys(methodology)
      .filter((k) => !known.has(k))
      .map((k) => ({ key: k, title: k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()), text: methodology[k] })),
  ];

  return (
    <ol className="list-decimal space-y-1.5 pl-4 text-[11px] leading-snug text-zinc-600 marker:text-zinc-400 dark:text-zinc-400">
      {notes.map((n) => (
        <li key={n.key}>
          <span className="font-medium text-zinc-800 dark:text-zinc-200">{n.title}.</span> <span className="whitespace-pre-line">{n.text}</span>
        </li>
      ))}
      {notes.length === 0 && (
        <li className="list-none text-zinc-500">
          Methodology notes (horizon, discounting, dollar year, fuel, imports, emissions, CFE, BOM) appear here once the evaluation backend
          reports them.
        </li>
      )}
    </ol>
  );
}
