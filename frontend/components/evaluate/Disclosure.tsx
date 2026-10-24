"use client";
// Collapsible section built on native <details>/<summary> (keyboard + screen-reader
// support for free). OWNER: workstream C (Evaluate).
import type { ReactNode } from "react";

export function Disclosure({
  title,
  meta,
  defaultOpen = false,
  children,
}: {
  title: string;
  /** Short right-aligned summary, e.g. a count or a total. */
  meta?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={defaultOpen} className="group border-t border-zinc-100 pt-2 dark:border-zinc-800">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded text-xs font-semibold text-zinc-700 focus-visible:outline-2 focus-visible:outline-sky-500 dark:text-zinc-300 [&::-webkit-details-marker]:hidden">
        <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0 text-zinc-400 transition-transform group-open:rotate-90" aria-hidden>
          <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{title}</span>
        {meta && <span className="ml-auto text-[11px] font-normal tabular-nums text-zinc-500">{meta}</span>}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
