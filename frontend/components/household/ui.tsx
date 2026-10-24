"use client";
// Small building blocks for Griddy Home: cards, stat tiles, segmented choices and inputs that keep a
// draft while you type (only finite, in-range values reach the request). OWNER: household (frontend).
import { useId, useState, type ReactNode } from "react";

import { ProvenanceTip } from "@/components/evaluate/ProvenanceTip";

import type { Prov } from "./types";

export const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-emerald-600 dark:focus-visible:outline-cyan-300";
export const INPUT =
  "w-full min-w-0 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm tabular-nums text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500 " +
  FOCUS;

export function Card({ title, aside, children, className }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-lg border border-zinc-200 bg-white p-3 sm:p-4 dark:border-zinc-800 dark:bg-zinc-950 ${className ?? ""}`}>
      {(title || aside) && (
        <header className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          {title && <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{title}</h3>}
          {aside && <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function StatTile({
  label,
  value,
  sub,
  provenance,
  tipLabel,
  compact,
}: {
  label: ReactNode;
  value: string;
  sub?: ReactNode;
  provenance?: Prov | Prov[] | null;
  tipLabel?: string;
  /** Secondary numbers: smaller type and padding, so the headline above stays the focus. */
  compact?: boolean;
}) {
  return (
    <div className={`min-w-0 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 ${compact ? "px-2.5 py-1.5" : "px-3 py-2"}`}>
      <div className="flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span className="truncate">{label}</span>
        {provenance !== undefined && <ProvenanceTip label={tipLabel ?? (typeof label === "string" ? label : "this number")} provenance={provenance} />}
      </div>
      <div className={`font-semibold tabular-nums text-zinc-900 dark:text-zinc-50 ${compact ? "text-base" : "text-lg sm:text-xl"}`}>{value}</div>
      {sub && <div className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{sub}</div>}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label, size = "sm" }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string; size?: "xs" | "sm" }) {
  return (
    <div role="group" aria-label={label} className="inline-flex max-w-full flex-wrap rounded-md border border-zinc-300 p-0.5 dark:border-zinc-700">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded px-2 py-0.5 ${size === "xs" ? "text-[11px]" : "text-xs"} ${FOCUS} ${
            value === o.value ? "bg-emerald-800 text-white dark:bg-cyan-300 dark:text-slate-950" : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function YesNo({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <Segmented<"yes" | "no">
      label={label}
      size="xs"
      value={value ? "yes" : "no"}
      onChange={(v) => onChange(v === "yes")}
      options={[
        { value: "no", label: "No" },
        { value: "yes", label: "Yes" },
      ]}
    />
  );
}

/** Label + control row. `htmlFor` ties a text label to its input. */
export function Field({ label, htmlFor, hint, children }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
          {label}
        </label>
      ) : (
        <div className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{label}</div>
      )}
      {children}
      {hint && <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{hint}</p>}
    </div>
  );
}

/** Number box that only commits finite values in [min, max]; empty commits null when `nullable`. */
export function NumberBox({
  id,
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
  unit,
  nullable = true,
  ariaLabel,
}: {
  id?: string;
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  min: number;
  max: number;
  step?: number;
  placeholder?: string;
  unit?: string;
  nullable?: boolean;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === null || value === undefined ? "" : String(value));
  const parsed = Number(shown);
  const invalid = draft !== null && (shown.trim() === "" ? !nullable : !Number.isFinite(parsed) || parsed < min || parsed > max);
  return (
    <div className="flex items-center gap-1.5">
      <input
        id={id}
        type="number"
        inputMode="decimal"
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        min={min}
        max={max}
        step={step ?? "any"}
        placeholder={placeholder}
        value={shown}
        onChange={(e) => {
          const t = e.target.value;
          setDraft(t);
          if (t.trim() === "") {
            if (nullable) onChange(null);
            return;
          }
          const v = Number(t);
          if (Number.isFinite(v) && v >= min && v <= max) onChange(v);
        }}
        onBlur={() => setDraft(null)}
        className={`${INPUT} ${invalid ? "border-red-500 dark:border-red-500" : ""}`}
      />
      {unit && <span className="shrink-0 text-[11px] text-zinc-500 dark:text-zinc-400">{unit}</span>}
    </div>
  );
}

export function SelectBox<T extends string>({ id, value, onChange, options, ariaLabel }: { id?: string; value: T; onChange: (v: T) => void; options: { value: T; label: string; disabled?: boolean }[]; ariaLabel?: string }) {
  return (
    <select id={id} aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value as T)} className={INPUT}>
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Range slider with its value shown; `format` renders the current value. */
export function Slider({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  format,
  hint,
  changed,
  onReset,
}: {
  label: ReactNode;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  format: (v: number) => string;
  hint?: ReactNode;
  /** Differs from the household's current behaviour: show a reset link. */
  changed?: boolean;
  onReset?: () => void;
}) {
  const id = useId();
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
          {label}
        </label>
        <span className="flex items-baseline gap-2">
          {changed && onReset && (
            <button type="button" onClick={onReset} className={`rounded text-[11px] text-zinc-500 underline hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100 ${FOCUS}`}>
              reset
            </button>
          )}
          <span className={`text-xs font-semibold tabular-nums ${changed ? "text-emerald-800 dark:text-cyan-300" : "text-zinc-800 dark:text-zinc-200"}`}>{format(value)}</span>
        </span>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className={`mt-1 w-full ${FOCUS}`} />
      {hint && <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{hint}</p>}
    </div>
  );
}

export function Badge({ tone = "info", children, title }: { tone?: "info" | "warn" | "ok"; children: ReactNode; title?: string }) {
  const cls =
    tone === "warn"
      ? "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300"
      : tone === "ok"
        ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
        : "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-300";
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>
      {children}
    </span>
  );
}

export function Notes({ items }: { items: (string | null | undefined)[] }) {
  const list = items.filter((s): s is string => !!s && s.trim() !== "");
  if (!list.length) return null;
  return (
    <ul className="mt-2 space-y-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
      {list.map((s, i) => (
        <li key={i}>• {s}</li>
      ))}
    </ul>
  );
}

/** Legend key: a square swatch (areas, bars) or a short line (line series). */
export function Swatch({ color, line, dashed }: { color: string; line?: boolean; dashed?: boolean }) {
  if (line) return <span className={`inline-block w-3 border-t-2 ${dashed ? "border-dashed" : ""}`} style={{ borderColor: color }} />;
  return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: color }} />;
}

export function LegendRow({ items }: { items: { label: ReactNode; color: string; line?: boolean; dashed?: boolean; key?: string }[] }) {
  return (
    <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
      {items.map((it, i) => (
        <li key={it.key ?? i} className="flex items-center gap-1">
          <Swatch color={it.color} line={it.line} dashed={it.dashed} />
          <span>{it.label}</span>
        </li>
      ))}
    </ul>
  );
}
