"use client";
// Slider + number input that never writes a half-typed value into the scenario.
// While you type, the box shows your draft; only finite, in-range numbers are
// committed. On blur it snaps back to the committed value.  OWNER: workstream D.
import { useId, useState } from "react";

interface Props {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  /** Slider max; the number box accepts up to `inputMax`. */
  max: number;
  inputMax?: number;
  step?: number;
  unit?: string;
  /** Multiply for display (e.g. 100 to edit a 0.07 fraction as 7 %). */
  displayScale?: number;
  hint?: string;
  slider?: boolean;
  /** Fixed display decimals, for derived values that needn't show every digit (e.g. IT load). */
  decimals?: number;
}

/** Show the committed value as it was run: the step's decimals, plus up to two more if
 *  the value has them (e.g. 4.25 with a 0.1 step), without trailing zeros. */
function fmt(v: number, step: number): string {
  const decimals = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  return String(Number(v.toFixed(decimals + 2)));
}

export function SliderField({ label, value, onChange, min, max, inputMax, step = 1, unit, displayScale = 1, hint, slider = true, decimals }: Props) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = value * displayScale;
  const hardMax = (inputMax ?? Number.POSITIVE_INFINITY) * displayScale;
  const parsed = draft === null ? shown : Number(draft);
  const invalid = draft !== null && (draft.trim() === "" || !Number.isFinite(parsed) || parsed < min * displayScale || parsed > hardMax);

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs text-zinc-600 dark:text-zinc-400">
          {label}
        </label>
        <span className="flex items-baseline gap-1">
          <input
            id={id}
            inputMode="decimal"
            className={`w-20 rounded border bg-transparent px-1 py-0.5 text-right text-sm tabular-nums ${
              invalid ? "border-red-500" : "border-zinc-300 dark:border-zinc-700"
            }`}
            value={draft ?? (decimals === undefined ? fmt(shown, step * displayScale) : shown.toFixed(decimals))}
            onChange={(e) => {
              setDraft(e.target.value);
              const n = Number(e.target.value);
              if (e.target.value.trim() !== "" && Number.isFinite(n) && n >= min * displayScale && n <= hardMax) onChange(n / displayScale);
            }}
            onBlur={() => setDraft(null)}
          />
          {unit && <span className="w-10 text-[11px] text-zinc-500">{unit}</span>}
        </span>
      </div>
      {slider && (
        <input
          type="range"
          aria-label={label}
          className="w-full accent-emerald-600"
          // Start the range on the step grid so a drag lands on round values (10, 20, ... not 1, 11, ...).
          min={Math.ceil(min / step) * step}
          max={Math.max(max, value)}
          step={step}
          value={value}
          onChange={(e) => {
            setDraft(null);
            onChange(Number(e.target.value));
          }}
        />
      )}
      {hint && <p className="text-[11px] text-zinc-500">{hint}</p>}
    </div>
  );
}
