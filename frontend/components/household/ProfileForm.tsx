"use client";
// Griddy Home onboarding: a short Basic form (place, provider, usage, rate plan, solar/battery) and an
// Advanced expander for the end uses that shape the load curve. Every edit updates the plan (the view
// debounces the request). OWNER: household (frontend).
import { useId, useState } from "react";

import { Term } from "@/components/glossary/Term";

import { errorText, householdApi } from "./api";
import { hourLabel, kwh } from "./fmt";
import { MONTHS, planBlurb, shortPlan } from "./theme";
import type { HouseholdOptions, HouseholdRequest, HouseholdWhatIf, RatePlanId, UsageParseResult, UtilityId } from "./types";
import { Field, FOCUS, INPUT, NumberBox, Segmented, SelectBox, YesNo } from "./ui";

export type Tri = "unsure" | "yes" | "no";
export type UsageMode = "monthly" | "twelve" | "csv" | "none";

export interface ProfileDraft {
  place: string;
  utility: UtilityId;
  rate_plan: RatePlanId;
  custom_rate: number | null;
  usageMode: UsageMode;
  monthly: number | null;
  months: (number | null)[];
  csv: { name: string; parsed: UsageParseResult } | null;
  has_solar: boolean;
  existing_solar_kw: number | null;
  has_battery: boolean;
  existing_battery_kwh: number | null;
  occupants: number | null;
  has_ev: boolean;
  ev_miles: number | null;
  ev_start: number | null;
  ac: Tri;
  setpoint: number | null;
  electric_heating: Tri;
  laundry_hour: number | null;
  dishwasher_hour: number | null;
  home_daytime: Tri;
  tenure: "unsure" | "own" | "rent";
  roof_kw_max: number | null;
}

export const DEFAULT_DRAFT: ProfileDraft = {
  place: "",
  utility: "pge",
  rate_plan: "E-TOU-C",
  custom_rate: null,
  usageMode: "monthly",
  monthly: 550,
  months: Array.from({ length: 12 }, () => null),
  csv: null,
  has_solar: false,
  existing_solar_kw: null,
  has_battery: false,
  existing_battery_kwh: null,
  occupants: null,
  has_ev: false,
  ev_miles: 30,
  ev_start: null,
  ac: "unsure",
  setpoint: null,
  electric_heating: "unsure",
  laundry_hour: null,
  dishwasher_hour: null,
  home_daytime: "unsure",
  tenure: "unsure",
  roof_kw_max: null,
};

/** Defaults the backend uses for times nobody entered (spec: EV 6 pm, laundry 7 pm, dishwasher 8 pm). */
export const DEFAULT_HOURS = { ev: 18, laundry: 19, dishwasher: 20 } as const;

const FALLBACK_UTILITIES: HouseholdOptions["utilities"] = [
  { id: "pge", label: "PG&E (bundled)", supported: true },
  { id: "pge_svce", label: "PG&E + Silicon Valley Clean Energy", supported: true },
  { id: "sce", label: "Southern California Edison", supported: false },
  { id: "sdge", label: "San Diego Gas & Electric", supported: false },
  { id: "municipal", label: "Municipal utility", supported: false },
  { id: "other", label: "Other", supported: false },
];
const FALLBACK_PLANS: HouseholdOptions["plans"] = [
  { id: "E-TOU-C", label: "E-TOU-C", utility: "pge", summary: "Peak 4–9 pm every day", eligibility: "" },
  { id: "E-TOU-D", label: "E-TOU-D", utility: "pge", summary: "Peak 5–8 pm weekdays", eligibility: "" },
  { id: "EV2-A", label: "EV2-A", utility: "pge", summary: "Cheapest overnight", eligibility: "EV or battery" },
  { id: "E-ELEC", label: "E-ELEC", utility: "pge", summary: "For electrified homes", eligibility: "Heat pump, EV or battery" },
];

export const isPge = (u: UtilityId) => u === "pge" || u === "pge_svce";
const tri = (t: Tri): boolean | null => (t === "unsure" ? null : t === "yes");

/** The request the backend sees for this draft and these what-if controls. */
export function toRequest(d: ProfileDraft, whatif: HouseholdWhatIf): HouseholdRequest {
  const place = d.place.trim();
  const zip = /^\d{5}$/.test(place) ? place : null;
  const city = !zip && place.length >= 3 && !/\d/.test(place) ? place : null;
  let monthly: number | number[] | null = null;
  if (d.usageMode === "monthly") monthly = d.monthly;
  else if (d.usageMode === "twelve") {
    const filled = d.months.filter((v): v is number => v !== null);
    if (filled.length === 12) monthly = filled;
    else if (filled.length) monthly = filled.reduce((a, b) => a + b, 0) / filled.length;
  }
  const supported = isPge(d.utility);
  return {
    zip,
    city,
    utility: d.utility,
    rate_plan: supported ? d.rate_plan : "unknown",
    custom_rate_usd_per_kwh: supported ? null : d.custom_rate,
    monthly_kwh: d.usageMode === "csv" ? null : monthly,
    interval_matrix_kwh: d.usageMode === "csv" ? (d.csv?.parsed.matrix_kwh ?? null) : null,
    has_solar: d.has_solar,
    existing_solar_kw: d.has_solar ? d.existing_solar_kw : null,
    has_battery: d.has_battery,
    existing_battery_kwh: d.has_battery ? d.existing_battery_kwh : null,
    occupants: d.occupants,
    ev: d.has_ev ? { has_ev: true, miles_per_day: d.ev_miles, charge_start_hour: d.ev_start } : { has_ev: false },
    cooling: d.ac === "unsure" ? null : { has_ac: d.ac === "yes", setpoint_f: d.ac === "yes" ? d.setpoint : null },
    electric_heating: tri(d.electric_heating),
    laundry_hour: d.laundry_hour,
    dishwasher_hour: d.dishwasher_hour,
    home_daytime: tri(d.home_daytime),
    owns_home: d.tenure === "unsure" ? null : d.tenure === "own",
    roof_kw_max: d.roof_kw_max,
    whatif,
  };
}

const HOUR_OPTIONS = [{ value: "", label: "Not sure (default)" }, ...Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: hourLabel(h) }))];

function HourSelect({ id, value, onChange, fallback }: { id: string; value: number | null; onChange: (v: number | null) => void; fallback: number }) {
  return (
    <select id={id} value={value === null ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} className={INPUT}>
      {HOUR_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.value === "" ? `Not sure (${hourLabel(fallback)})` : o.label}
        </option>
      ))}
    </select>
  );
}

function TriChoice({ value, onChange, label }: { value: Tri; onChange: (v: Tri) => void; label: string }) {
  return (
    <Segmented<Tri>
      label={label}
      size="xs"
      value={value}
      onChange={onChange}
      options={[
        { value: "unsure", label: "Not sure" },
        { value: "no", label: "No" },
        { value: "yes", label: "Yes" },
      ]}
    />
  );
}

export function ProfileForm({
  draft,
  onChange,
  options,
  located,
  pinned = false,
}: {
  draft: ProfileDraft;
  onChange: (patch: Partial<ProfileDraft>) => void;
  options: HouseholdOptions | null;
  /** A house pin is on the map: it sets the location and the place field is only a fallback. */
  pinned?: boolean;
  /** What the last plan matched the place to (from the result), shown under the field. */
  located?: string | null;
}) {
  const uid = useId();
  const id = (s: string) => `${uid}-${s}`;
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvError, setCsvError] = useState<string | null>(null);
  const utilities = options?.utilities?.length ? options.utilities : FALLBACK_UTILITIES;
  const plans = (options?.plans?.length ? options.plans : FALLBACK_PLANS).filter((p) => p.utility === "pge" || p.utility === draft.utility);
  const supported = isPge(draft.utility);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setCsvError(null);
    if (file.size > 20 * 1024 * 1024) {
      setCsvError("That file is over 20 MB; download one year of hourly or 15-minute data.");
      return;
    }
    setCsvBusy(true);
    try {
      const text = await file.text();
      const parsed = await householdApi.parseUsage(text);
      onChange({ csv: { name: file.name, parsed }, usageMode: "csv" });
    } catch (e) {
      setCsvError(errorText(e));
    } finally {
      setCsvBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Your home</h2>
        <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">A few answers are enough; everything updates as you type.</p>
      </div>

      <Field
        label={pinned ? "ZIP code or city (used only without a pin)" : "ZIP code or city"}
        htmlFor={id("place")}
        hint={located ?? "Picks the nearest solar profile. PG&E territory is modelled best."}
      >
        <input
          id={id("place")}
          className={INPUT}
          value={draft.place}
          placeholder="e.g. 94086 or Sunnyvale"
          autoComplete="postal-code"
          onChange={(e) => onChange({ place: e.target.value.slice(0, 60) })}
        />
      </Field>

      <Field label="Electricity provider" htmlFor={id("utility")}>
        <SelectBox<UtilityId>
          id={id("utility")}
          value={draft.utility}
          onChange={(v) => onChange({ utility: v })}
          options={utilities.map((u) => ({ value: u.id as UtilityId, label: u.supported ? u.label : `${u.label} (custom rate)` }))}
        />
        {draft.utility === "pge_svce" && (
          <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
            SVCE is a <Term k="cca">CCA</Term>: it buys your power, PG&E delivers it and bills you. Griddy prices SVCE generation plus PG&E delivery and the{" "}
            <Term k="pcia">PCIA</Term>.
          </p>
        )}
      </Field>

      {supported ? (
        <Field
          label={
            <>
              Rate plan (<Term k="tou">time-of-use</Term>)
            </>
          }
          htmlFor={id("plan")}
          hint={(() => {
            const p = plans.find((x) => x.id === draft.rate_plan);
            if (!p) return draft.rate_plan === "unknown" ? "We'll use E-TOU-C, PG&E's default residential plan." : undefined;
            return [planBlurb(p.label), p.summary].filter(Boolean).join(". ");
          })()}
        >
          <SelectBox<RatePlanId>
            id={id("plan")}
            value={draft.rate_plan}
            onChange={(v) => onChange({ rate_plan: v })}
            options={[...plans.map((p) => ({ value: p.id as RatePlanId, label: shortPlan(p.label) })), { value: "unknown", label: "I don't know" }]}
          />
        </Field>
      ) : (
        <Field label="Your price per kWh" htmlFor={id("rate")} hint="Rates for this utility aren't loaded yet, so Griddy uses the flat $/kWh you enter (total bill ÷ kWh works); until then, a California average.">
          <NumberBox id={id("rate")} value={draft.custom_rate} onChange={(v) => onChange({ custom_rate: v })} min={0.01} max={2} step={0.01} placeholder="0.35" unit="$/kWh" />
        </Field>
      )}

      <Field label={<>Your usage</>}>
        <Segmented<UsageMode>
          label="Usage input"
          size="xs"
          value={draft.usageMode}
          onChange={(v) =>
            // Twelve empty boxes would drop to the benchmark: start them at the typical month instead.
            onChange(v === "twelve" && draft.monthly !== null && draft.months.every((m) => m === null) ? { usageMode: v, months: draft.months.map(() => draft.monthly) } : { usageMode: v })
          }
          options={[
            { value: "monthly", label: "Typical month" },
            { value: "twelve", label: "12 months" },
            { value: "csv", label: "Meter file" },
            { value: "none", label: "Not sure" },
          ]}
        />
        {draft.usageMode === "monthly" && (
          <NumberBox ariaLabel="Typical monthly kWh" value={draft.monthly} onChange={(v) => onChange({ monthly: v })} min={10} max={10000} step={10} placeholder="550" unit="kWh / month" />
        )}
        {draft.usageMode === "twelve" && (
          <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 lg:grid-cols-3">
            {MONTHS.map((m, i) => (
              <label key={m} className="text-[10px] text-zinc-500 dark:text-zinc-400">
                {m}
                <NumberBox
                  ariaLabel={`${m} kWh`}
                  value={draft.months[i]}
                  onChange={(v) => onChange({ months: draft.months.map((x, j) => (j === i ? v : x)) })}
                  min={0}
                  max={20000}
                  step={10}
                />
              </label>
            ))}
            <p className="col-span-full text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
              kWh per month from your bills. Until all 12 are filled, Griddy uses their average as a typical month.
            </p>
          </div>
        )}
        {draft.usageMode === "csv" && (
          <div className="space-y-1">
            <label className={`flex cursor-pointer items-center justify-center rounded-md border border-dashed border-zinc-300 px-2 py-2 text-xs text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300 ${FOCUS}`}>
              <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} />
              {csvBusy ? "Reading your file..." : draft.csv ? `Replace ${draft.csv.name}` : "Upload a Green Button CSV"}
            </label>
            {draft.csv && (
              <p className="text-[11px] leading-snug text-zinc-600 dark:text-zinc-300">
                {draft.csv.parsed.days} days of {draft.csv.parsed.interval_minutes}-minute <Term k="interval_data">interval data</Term>, about{" "}
                {kwh(draft.csv.parsed.annual_kwh_estimate)} a year.
              </p>
            )}
            {draft.csv?.parsed.warnings.map((w, i) => (
              <p key={i} className="text-[11px] leading-snug text-amber-800 dark:text-amber-300">
                {w}
              </p>
            ))}
            {csvError && <p className="text-[11px] leading-snug text-red-700 dark:text-red-300">{csvError}</p>}
            <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
              PG&E: Energy Usage Details → Green Button → Download my data (CSV). Griddy&apos;s backend averages it by month, day type and hour.
            </p>
          </div>
        )}
        {draft.usageMode === "none" && (
          <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">Griddy will use a California benchmark home for your household size.</p>
        )}
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Rooftop solar?">
          <YesNo label="Rooftop solar" value={draft.has_solar} onChange={(v) => onChange({ has_solar: v })} />
          {draft.has_solar && <NumberBox ariaLabel="Existing solar kW" value={draft.existing_solar_kw} onChange={(v) => onChange({ existing_solar_kw: v })} min={0.5} max={30} step={0.5} placeholder="5" unit="kW" />}
        </Field>
        <Field label="Home battery?">
          <YesNo label="Home battery" value={draft.has_battery} onChange={(v) => onChange({ has_battery: v })} />
          {draft.has_battery && <NumberBox ariaLabel="Existing battery kWh" value={draft.existing_battery_kwh} onChange={(v) => onChange({ existing_battery_kwh: v })} min={1} max={60} step={0.5} placeholder="13.5" unit="kWh" />}
        </Field>
      </div>

      <details className="group rounded-md border border-zinc-200 dark:border-zinc-800">
        <summary className={`flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold text-zinc-700 dark:text-zinc-300 [&::-webkit-details-marker]:hidden ${FOCUS}`}>
          <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0 text-zinc-400 transition-transform group-open:rotate-90" aria-hidden>
            <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Advanced: shape your <Term k="load_curve">load curve</Term>
        </summary>
        <div className="space-y-3 px-2 pb-3 pt-1">
          <Field label="People at home" htmlFor={id("occ")}>
            <NumberBox id={id("occ")} value={draft.occupants} onChange={(v) => onChange({ occupants: v === null ? null : Math.round(v) })} min={1} max={12} step={1} placeholder="Not sure (3)" />
          </Field>

          <Field label="Electric vehicle?">
            <YesNo label="Electric vehicle" value={draft.has_ev} onChange={(v) => onChange({ has_ev: v })} />
            {draft.has_ev && (
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[10px] text-zinc-500 dark:text-zinc-400">
                  Miles a day
                  <NumberBox ariaLabel="EV miles per day" value={draft.ev_miles} onChange={(v) => onChange({ ev_miles: v })} min={1} max={300} step={1} placeholder="30" />
                </label>
                <label className="text-[10px] text-zinc-500 dark:text-zinc-400" htmlFor={id("evh")}>
                  Starts charging
                  <HourSelect id={id("evh")} value={draft.ev_start} onChange={(v) => onChange({ ev_start: v })} fallback={DEFAULT_HOURS.ev} />
                </label>
              </div>
            )}
          </Field>

          <Field label="Air conditioning?">
            <TriChoice label="Air conditioning" value={draft.ac} onChange={(v) => onChange({ ac: v })} />
            {draft.ac === "yes" && (
              <NumberBox ariaLabel="Cooling setpoint °F" value={draft.setpoint} onChange={(v) => onChange({ setpoint: v })} min={60} max={90} step={1} placeholder="Setpoint (76)" unit="°F" />
            )}
          </Field>

          <Field label="Electric heating (heat pump or resistance)?">
            <TriChoice label="Electric heating" value={draft.electric_heating} onChange={(v) => onChange({ electric_heating: v })} />
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Laundry usually at" htmlFor={id("laundry")}>
              <HourSelect id={id("laundry")} value={draft.laundry_hour} onChange={(v) => onChange({ laundry_hour: v })} fallback={DEFAULT_HOURS.laundry} />
            </Field>
            <Field label="Dishwasher usually at" htmlFor={id("dish")}>
              <HourSelect id={id("dish")} value={draft.dishwasher_hour} onChange={(v) => onChange({ dishwasher_hour: v })} fallback={DEFAULT_HOURS.dishwasher} />
            </Field>
          </div>

          <Field label="Someone home during the day?">
            <TriChoice label="Home during the day" value={draft.home_daytime} onChange={(v) => onChange({ home_daytime: v })} />
          </Field>

          <Field label="Own or rent?">
            <Segmented<ProfileDraft["tenure"]>
              label="Own or rent"
              size="xs"
              value={draft.tenure}
              onChange={(v) => onChange({ tenure: v })}
              options={[
                { value: "unsure", label: "Not sure" },
                { value: "own", label: "Own" },
                { value: "rent", label: "Rent" },
              ]}
            />
          </Field>

          <Field label="Roof room for solar" htmlFor={id("roof")} hint="Most homes fit 4–8 kW. Leave empty if unsure.">
            <NumberBox id={id("roof")} value={draft.roof_kw_max} onChange={(v) => onChange({ roof_kw_max: v })} min={1} max={30} step={0.5} placeholder="Not sure" unit="kW max" />
          </Field>
        </div>
      </details>
    </div>
  );
}
