"use client";
// The proposed generation project the GriddyGrade scores: technology and nameplate MW, plus the
// settings that change what is required (cooling, for thermal plants) or are shown alongside
// (co-located storage).  OWNER: workstream E (Site Intelligence).
// Only settings with an implemented effect are offered: solar configuration, turbines, hub height,
// annual generation and water demand would not change the score, so they are not shown.
import { useId } from "react";

import type { CoolingConfig, GenerationTechnology } from "./feasibilityPolicy";
import { POLICY_TECHNOLOGIES } from "./feasibilityPolicy";
import { DEFAULT_DRAFT, POLICY, setProjectDraft, type ProjectDraft } from "./useGriddyGrade";

const FIELD =
  "rounded-md border border-zinc-300 bg-white px-1.5 py-1 text-xs text-zinc-900 focus-visible:outline-2 focus-visible:outline-sky-500 aria-[invalid=true]:border-red-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

const COOLING_LABEL: Record<CoolingConfig, string> = { not_specified: "Not specified", wet: "Wet (recirculating)", dry: "Dry (air-cooled)" };

export function ProjectControls({ draft, errors, advanced = false }: { draft: ProjectDraft; errors: string[]; advanced?: boolean }) {
  const id = useId();
  const spec = POLICY.technologies[draft.technology];
  const isDefault = draft.technology === DEFAULT_DRAFT.technology && draft.capacityText === DEFAULT_DRAFT.capacityText;
  const capacityError = errors.find((e) => e.startsWith("Proposed nameplate capacity"));
  const storageError = errors.find((e) => e.startsWith("Co-located storage"));

  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">Proposed generation project</legend>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-[11px] text-zinc-500 dark:text-zinc-400" htmlFor={`${id}-tech`}>
          Technology
          <select id={`${id}-tech`} className={FIELD} value={draft.technology} onChange={(e) => setProjectDraft({ technology: e.target.value as GenerationTechnology })}>
            {POLICY_TECHNOLOGIES.map((t) => (
              <option key={t} value={t}>
                {POLICY.technologies[t].label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex w-28 flex-col gap-0.5 text-[11px] text-zinc-500 dark:text-zinc-400" htmlFor={`${id}-mw`}>
          Nameplate (MW)
          <input
            id={`${id}-mw`}
            className={`${FIELD} tabular-nums`}
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={draft.capacityText}
            aria-invalid={capacityError ? true : undefined}
            aria-describedby={capacityError ? `${id}-mw-error` : undefined}
            onChange={(e) => setProjectDraft({ capacityText: e.target.value })}
          />
        </label>
      </div>
      {isDefault && (
        <p className="mt-1 text-[10px] text-zinc-500 dark:text-zinc-400">
          Editable defaults ({POLICY.technologies[DEFAULT_DRAFT.technology].label}, {DEFAULT_DRAFT.capacityText} MW): product defaults, not typical plant characteristics.
        </p>
      )}
      {capacityError && (
        <p id={`${id}-mw-error`} role="alert" className="mt-1 text-[11px] text-red-700 dark:text-red-400">
          {capacityError}
        </p>
      )}
      {errors
        .filter((e) => e !== capacityError && e !== storageError)
        .map((e) => (
          <p key={e} role="alert" className="mt-1 text-[11px] text-red-700 dark:text-red-400">
            {e}
          </p>
        ))}

      {advanced && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          {spec.thermal && (
            <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-[11px] text-zinc-500 dark:text-zinc-400" htmlFor={`${id}-cooling`}>
              Cooling
              <select id={`${id}-cooling`} className={FIELD} value={draft.cooling} onChange={(e) => setProjectDraft({ cooling: e.target.value as CoolingConfig })}>
                {(Object.keys(COOLING_LABEL) as CoolingConfig[]).map((c) => (
                  <option key={c} value={c}>
                    {COOLING_LABEL[c]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex w-40 flex-col gap-0.5 text-[11px] text-zinc-500 dark:text-zinc-400" htmlFor={`${id}-storage`}>
            Co-located storage (MW)
            <input
              id={`${id}-storage`}
              className={`${FIELD} tabular-nums`}
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              placeholder="none"
              value={draft.storageText}
              aria-invalid={storageError ? true : undefined}
              aria-describedby={`${id}-storage-note`}
              onChange={(e) => setProjectDraft({ storageText: e.target.value })}
            />
          </label>
          <p id={`${id}-storage-note`} className="w-full text-[10px] text-zinc-500 dark:text-zinc-400">
            {spec.thermal && "Dry cooling removes the cooling-water prerequisite, not all project water demand. "}
            Storage is shown separately: it is not primary generation and is never scored. Battery-only projects aren&apos;t scored by this model.
          </p>
          {storageError && (
            <p role="alert" className="w-full text-[11px] text-red-700 dark:text-red-400">
              {storageError}
            </p>
          )}
        </div>
      )}
    </fieldset>
  );
}
