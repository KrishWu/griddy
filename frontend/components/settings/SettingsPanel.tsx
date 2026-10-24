"use client";
// The Settings controls: appearance, map display, layout. Everything writes through lib/settings.tsx
// (saved in this browser) and applies live, so the map behind the drawer previews contrast and
// brightness as the sliders move. The few words that need it explain themselves with <Term> (which
// the "Explain jargon on hover" switch here turns off).  OWNER: workstream D (shell).
import { useId, type ReactNode } from "react";

import { Term } from "@/components/glossary/Term";
import {
  DEFAULT_SETTINGS,
  MAP_DISPLAY_KEYS,
  MAP_FILTER_MAX,
  MAP_FILTER_MIN,
  useSettings,
  type BasemapSetting,
  type Settings,
  type TextSize,
  type ThemeSetting,
} from "@/lib/settings";

const FOCUS_WITHIN = "has-focus-visible:outline-2 has-focus-visible:outline-offset-1 has-focus-visible:outline-emerald-600 dark:has-focus-visible:outline-cyan-300";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4 border-t border-zinc-200 px-4 py-4 first:border-t-0 dark:border-zinc-800">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{title}</h3>
      {children}
    </section>
  );
}

/** A segmented control built from native radios (arrow keys, form semantics for free). */
function Segmented<T extends string>(props: {
  legend: ReactNode;
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  hint?: ReactNode;
}) {
  const { legend, value, options, onChange, hint } = props;
  const name = useId();
  const hintId = `${name}-hint`;
  return (
    <fieldset aria-describedby={hint ? hintId : undefined}>
      <legend className="mb-1.5 text-sm font-medium text-zinc-800 dark:text-zinc-100">{legend}</legend>
      <div className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-md border border-zinc-300 p-0.5 dark:border-zinc-700">
        {options.map((o) => (
          <label
            key={o.value}
            title={o.title}
            className={`flex cursor-pointer items-center justify-center gap-1 rounded px-1.5 py-1 text-center text-xs text-zinc-600 hover:text-zinc-900 has-checked:bg-emerald-800 has-checked:text-white dark:text-zinc-300 dark:hover:text-white dark:has-checked:bg-cyan-300 dark:has-checked:text-slate-950 ${FOCUS_WITHIN}`}
          >
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="sr-only" />
            {o.label}
          </label>
        ))}
      </div>
      {hint && (
        <p id={hintId} className="mt-1.5 text-xs leading-snug text-zinc-500 dark:text-zinc-400">
          {hint}
        </p>
      )}
    </fieldset>
  );
}

function Switch(props: { label: string; hint?: ReactNode; checked: boolean; onChange: (on: boolean) => void }) {
  const { label, hint, checked, onChange } = props;
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <label htmlFor={id} className="cursor-pointer text-sm font-medium text-zinc-800 dark:text-zinc-100">
          {label}
        </label>
        {hint && (
          <p id={`${id}-hint`} className="mt-0.5 text-xs leading-snug text-zinc-500 dark:text-zinc-400">
            {hint}
          </p>
        )}
      </div>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={checked}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(e) => onChange(e.target.checked)}
          className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
        />
        <span
          aria-hidden
          className="h-5 w-9 rounded-full bg-zinc-300 transition-colors peer-checked:bg-emerald-700 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-emerald-600 dark:bg-zinc-700 dark:peer-checked:bg-cyan-400 dark:peer-focus-visible:outline-cyan-300"
        />
        <span aria-hidden className="pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
      </span>
    </div>
  );
}

function Slider(props: { label: string; value: number; onChange: (v: number) => void }) {
  const { label, value, onChange } = props;
  const id = useId();
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <label htmlFor={id} className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
          {label}
        </label>
        <output htmlFor={id} className="text-xs tabular-nums text-zinc-600 dark:text-zinc-300">
          {value}%
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={MAP_FILTER_MIN}
        max={MAP_FILTER_MAX}
        step={5}
        value={value}
        aria-valuetext={`${value} percent${value === 100 ? " (unchanged)" : ""}`}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(100)}
        className="w-full cursor-pointer"
      />
      <div aria-hidden className="flex justify-between text-[10px] tabular-nums text-zinc-500 dark:text-zinc-400">
        <span>{MAP_FILTER_MIN}%</span>
        <span>100%</span>
        <span>{MAP_FILTER_MAX}%</span>
      </div>
    </div>
  );
}

/** Tiny preview of a theme: header bar + panel + map tile. */
function ThemeSwatch({ theme }: { theme: Exclude<ThemeSetting, "system"> }) {
  const chrome = theme === "light" ? "#ffffff" : theme === "dark" ? "#0c182a" : "#000000";
  const map = theme === "dark" ? "#24364e" : "#e4eee9";
  return (
    <span aria-hidden className="inline-flex h-3.5 w-5 shrink-0 overflow-hidden rounded-sm ring-1 ring-black/20 dark:ring-white/30">
      <span className="h-full w-2" style={{ background: chrome }} />
      <span className="h-full flex-1" style={{ background: map }} />
    </span>
  );
}

export function SettingsPanel() {
  const { settings: s, update, reset, reducedMotion } = useSettings();
  const set = <K extends keyof Settings>(k: K) => (v: Settings[K]) => update({ [k]: v } as Partial<Settings>);
  const mapChanged = MAP_DISPLAY_KEYS.some((k) => s[k] !== DEFAULT_SETTINGS[k]);

  return (
    <div>
      <Section title="Appearance">
        <Segmented<ThemeSetting>
          legend="Theme"
          value={s.theme}
          onChange={set("theme")}
          options={[
            { value: "system", label: "Auto", title: "Follow your device's light or dark setting" },
            { value: "light", label: <><ThemeSwatch theme="light" />Light</> },
            { value: "dark", label: <><ThemeSwatch theme="dark" />Dark</> },
            { value: "mixed", label: <><ThemeSwatch theme="mixed" />Mixed</>, title: "Black panels, light map" },
          ]}
          hint={s.theme === "mixed" ? "Mixed: black header and panels with white text; the map stays light." : s.theme === "system" ? "Auto follows your device's light or dark setting." : undefined}
        />
        <Segmented<TextSize>
          legend="Text size"
          value={s.textSize}
          onChange={set("textSize")}
          options={[
            { value: "small", label: <span className="text-[11px]">Small</span> },
            { value: "default", label: "Default" },
            { value: "large", label: <span className="text-sm">Large</span> },
          ]}
        />
        <Switch
          label="Explain jargon on hover"
          hint={
            <>
              Underlined terms like <Term k="lcoe">LCOE</Term> or <Term k="mwh">MWh</Term> show a plain-language definition on hover, focus or tap.
            </>
          }
          checked={s.explainJargon}
          onChange={set("explainJargon")}
        />
        <Switch
          label="Reduce motion"
          hint={
            <>
              Map moves jump instead of flying, and panels don&rsquo;t animate.{" "}
              {s.reduceMotion === null ? (
                `Following your device setting (${reducedMotion ? "on" : "off"}).`
              ) : (
                <button type="button" className="underline hover:text-zinc-800 dark:hover:text-zinc-200" onClick={() => update({ reduceMotion: null })}>
                  Follow device setting
                </button>
              )}
            </>
          }
          checked={reducedMotion}
          onChange={set("reduceMotion")}
        />
      </Section>

      <Section title="Map display">
        <Segmented<BasemapSetting>
          legend={<Term k="basemap">Basemap</Term>}
          value={s.basemap}
          onChange={set("basemap")}
          options={[
            { value: "theme", label: "Follow theme", title: "Dark in the Dark theme; light in Light and Mixed" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
        <Slider label="Map contrast" value={s.mapContrast} onChange={set("mapContrast")} />
        <Slider label="Map brightness" value={s.mapBrightness} onChange={set("mapBrightness")} />
        <button
          type="button"
          disabled={!mapChanged}
          onClick={() => reset(MAP_DISPLAY_KEYS)}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:border-zinc-400 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-200 dark:hover:border-zinc-500"
        >
          Reset map display
        </button>
      </Section>

      <Section title="Layout">
        <Switch label="Collapse the left sidebar" hint="Plan, Site, Layers and Build fold to a slim rail." checked={s.leftCollapsed} onChange={set("leftCollapsed")} />
        <Switch label="Collapse the right sidebar" hint="Results fold to a slim rail, so the map gets the width." checked={s.rightCollapsed} onChange={set("rightCollapsed")} />
      </Section>

      <div className="flex items-center justify-between gap-3 border-t border-zinc-200 px-4 py-4 dark:border-zinc-800">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">Saved in this browser.</p>
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-200 dark:hover:border-zinc-500"
        >
          Reset all settings
        </button>
      </div>
    </div>
  );
}
