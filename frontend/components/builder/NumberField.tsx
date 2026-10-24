"use client";

export function NumberField({ label, value, onChange, min = 0, max = 1000000, step = 1, unit = "" }: {
  label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; unit?: string;
}) {
  return <label className="block text-xs text-zinc-600 dark:text-zinc-400">
    {label}{unit && ` (${unit})`}
    <input type="number" min={min} max={max} step={step} value={Number(value.toFixed(6))}
      className="mt-1 w-full rounded border border-zinc-300 bg-transparent px-2 py-1.5 text-sm tabular-nums dark:border-zinc-700"
      onChange={(e) => { const n = e.target.valueAsNumber; if (Number.isFinite(n) && n >= min && n <= max) onChange(n); }} />
  </label>;
}
