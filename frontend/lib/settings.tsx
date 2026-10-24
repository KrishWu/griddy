"use client";
// Viewer settings: theme, map display, text size, jargon tooltips, motion and sidebar layout. One
// small external store (useSyncExternalStore), so any component can read it without a provider and
// every page (/, /report, /about) shares it; <SettingsProvider> in app/layout.tsx only
// keeps <html> in sync with the OS (prefers-color-scheme, prefers-reduced-motion) and other tabs.
// Persisted in localStorage "griddy:settings"; every storage access is wrapped, so a private window
// or blocked storage still renders with the defaults.  OWNER: workstream D (shell).
//
// The document carries the resolved values, so CSS can use them before React hydrates (the init
// script in app/layout.tsx sets the same attributes before first paint, so nothing flashes; keep
// it in step with readStored() + applyToDocument() below):
//   <html data-theme="light|dark|mixed" data-text-size="small|large" data-reduce-motion>
// Mixed = black chrome (header, sidebars, tabs, panels) with a light map. Mark any bar or panel
// that should go black in Mixed with the `data-chrome` attribute (see globals.css).
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";

export type ThemeSetting = "system" | "light" | "dark" | "mixed";
export type ResolvedTheme = "light" | "dark" | "mixed";
/** "theme": dark basemap in Dark, light in Light and Mixed. */
export type BasemapSetting = "theme" | "light" | "dark";
export type TextSize = "small" | "default" | "large";

export interface Settings {
  theme: ThemeSetting;
  basemap: BasemapSetting;
  /** Map canvas contrast and brightness, percent (MAP_FILTER_MIN..MAP_FILTER_MAX, 100 = unchanged). */
  mapContrast: number;
  mapBrightness: number;
  textSize: TextSize;
  /** "Explain jargon on hover": glossary tooltips on terms like LCOE (F2's <Term>). Off = plain text. */
  explainJargon: boolean;
  /** null = follow the OS (prefers-reduced-motion). */
  reduceMotion: boolean | null;
  /** Sidebars folded to a slim rail so the map gets the width. */
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

export const SETTINGS_KEY = "griddy:settings";
/** The pre-settings theme key; still written (light/dark/mixed) and read when no settings exist. */
export const LEGACY_THEME_KEY = "griddy:theme";
export const MAP_FILTER_MIN = 50;
export const MAP_FILTER_MAX = 150;

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  theme: "system",
  basemap: "theme",
  mapContrast: 100,
  mapBrightness: 100,
  textSize: "default",
  explainJargon: true,
  reduceMotion: null,
  leftCollapsed: false,
  rightCollapsed: false,
});

/** The map-display settings the Settings panel's "Reset map display" restores. */
export const MAP_DISPLAY_KEYS = ["basemap", "mapContrast", "mapBrightness"] as const satisfies readonly (keyof Settings)[];

const THEMES: readonly ThemeSetting[] = ["system", "light", "dark", "mixed"];
const BASEMAPS: readonly BasemapSetting[] = ["theme", "light", "dark"];
const TEXT_SIZES: readonly TextSize[] = ["small", "default", "large"];

const clampPct = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(MAP_FILTER_MAX, Math.max(MAP_FILTER_MIN, Math.round(v))) : fallback;
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

/** Anything read from storage (or passed in) as valid Settings: unknown keys dropped, bad values defaulted. */
function sanitize(raw: unknown): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  return {
    theme: oneOf(r.theme, THEMES, d.theme),
    basemap: oneOf(r.basemap, BASEMAPS, d.basemap),
    mapContrast: clampPct(r.mapContrast, d.mapContrast),
    mapBrightness: clampPct(r.mapBrightness, d.mapBrightness),
    textSize: oneOf(r.textSize, TEXT_SIZES, d.textSize),
    explainJargon: bool(r.explainJargon, d.explainJargon),
    reduceMotion: typeof r.reduceMotion === "boolean" ? r.reduceMotion : null,
    leftCollapsed: bool(r.leftCollapsed, d.leftCollapsed),
    rightCollapsed: bool(r.rightCollapsed, d.rightCollapsed),
  };
}

function readStored(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return sanitize(JSON.parse(raw));
    // First visit since settings existed: keep the theme chosen with the old Light/Dark toggle.
    const legacy = localStorage.getItem(LEGACY_THEME_KEY);
    return { ...DEFAULT_SETTINGS, theme: oneOf(legacy, THEMES, DEFAULT_SETTINGS.theme) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function persist(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    // Older code (and other open tabs on an older build) only knows this key.
    if (s.theme === "system") localStorage.removeItem(LEGACY_THEME_KEY);
    else localStorage.setItem(LEGACY_THEME_KEY, s.theme);
  } catch {
    /* Settings still apply for this page view when storage is unavailable. */
  }
}

const media = (q: string): boolean => {
  try {
    return typeof window !== "undefined" && window.matchMedia(q).matches;
  } catch {
    return false;
  }
};
const DARK_QUERY = "(prefers-color-scheme: dark)";
const MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function resolveTheme(s: Pick<Settings, "theme">): ResolvedTheme {
  return s.theme === "system" ? (media(DARK_QUERY) ? "dark" : "light") : s.theme;
}

/** The basemap the map should load: Mixed keeps the map light. */
export function resolveBasemap(s: Pick<Settings, "theme" | "basemap">): "light" | "dark" {
  if (s.basemap !== "theme") return s.basemap;
  return resolveTheme(s) === "dark" ? "dark" : "light";
}

export function resolveReducedMotion(s: Pick<Settings, "reduceMotion">): boolean {
  return s.reduceMotion ?? media(MOTION_QUERY);
}

/** Write the resolved settings onto <html> (same attributes as the init script in app/layout.tsx). */
function applyToDocument(s: Settings): void {
  if (typeof document === "undefined") return;
  const d = document.documentElement;
  const theme = resolveTheme(s);
  if (d.dataset.theme !== theme) d.dataset.theme = theme;
  if (s.textSize === "default") delete d.dataset.textSize;
  else d.dataset.textSize = s.textSize;
  if (resolveReducedMotion(s)) d.dataset.reduceMotion = "";
  else delete d.dataset.reduceMotion;
}

// ---- store ----
let current: Settings | null = null; // loaded lazily on the client
const listeners = new Set<() => void>();

function snapshot(): Settings {
  if (!current) current = readStored();
  return current;
}

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Current settings outside React (event handlers registered once, e.g. map camera moves). */
export function getSettings(): Settings {
  return typeof window === "undefined" ? DEFAULT_SETTINGS : snapshot();
}

/** Merge a change (or a function of the current settings), save it and apply it. */
export function updateSettings(change: Partial<Settings> | ((s: Settings) => Partial<Settings>)): void {
  const prev = snapshot();
  const patch = typeof change === "function" ? change(prev) : change;
  const next = sanitize({ ...prev, ...patch });
  if ((Object.keys(next) as (keyof Settings)[]).every((k) => next[k] === prev[k])) return;
  current = next;
  persist(next);
  applyToDocument(next);
  emit();
}

/** Back to defaults: every setting, or only `keys`. */
export function resetSettings(keys?: readonly (keyof Settings)[]): void {
  const d = DEFAULT_SETTINGS;
  updateSettings(keys ? Object.fromEntries(keys.map((k) => [k, d[k]])) : { ...d });
}

/** Reduced motion right now (settings or OS); for animation calls outside React. */
export function prefersReducedMotion(): boolean {
  return resolveReducedMotion(getSettings());
}

export interface SettingsApi {
  settings: Settings;
  /** Resolved values (system preference applied). */
  theme: ResolvedTheme;
  basemap: "light" | "dark";
  reducedMotion: boolean;
  explainJargon: boolean;
  update: typeof updateSettings;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  reset: typeof resetSettings;
}

// System preferences, as a store too, so "system" theme / motion re-render when the OS flips.
function subscribeSystem(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const qs = [window.matchMedia(DARK_QUERY), window.matchMedia(MOTION_QUERY)];
  for (const q of qs) q.addEventListener("change", onChange);
  return () => {
    for (const q of qs) q.removeEventListener("change", onChange);
  };
}
const systemKey = () => `${media(DARK_QUERY) ? 1 : 0}${media(MOTION_QUERY) ? 1 : 0}`;

/** Settings, resolved values and setters. Server render / first hydration pass sees the defaults. */
export function useSettings(): SettingsApi {
  const settings = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_SETTINGS);
  const system = useSyncExternalStore(subscribeSystem, systemKey, () => "00");
  return useMemo(() => {
    // Resolve against the OS snapshot (not a live media query), so the hydration pass matches the server.
    const theme: ResolvedTheme = settings.theme === "system" ? (system[0] === "1" ? "dark" : "light") : settings.theme;
    return {
      settings,
      theme,
      basemap: settings.basemap !== "theme" ? settings.basemap : theme === "dark" ? "dark" : "light",
      reducedMotion: settings.reduceMotion ?? system[1] === "1",
      explainJargon: settings.explainJargon,
      update: updateSettings,
      set: (key, value) => updateSettings({ [key]: value } as Partial<Settings>),
      reset: resetSettings,
    };
  }, [settings, system]);
}

/** One setting (re-renders on any settings change; settings change rarely). */
export function useSetting<K extends keyof Settings>(key: K): Settings[K] {
  return useSettings().settings[key];
}

/** For F2's <Term>: false = render jargon as plain text, no tooltip. */
export function useExplainJargon(): boolean {
  return useSettings().settings.explainJargon;
}

/** Keeps <html> in sync with the settings, the OS preferences and other tabs. Mount once (app/layout.tsx). */
export function SettingsProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    applyToDocument(snapshot());
    const reapply = () => applyToDocument(snapshot());
    const unsubSystem = subscribeSystem(reapply);
    // Another tab changed the settings: adopt them here too.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SETTINGS_KEY && e.key !== LEGACY_THEME_KEY && e.key !== null) return;
      current = readStored();
      applyToDocument(current);
      emit();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      unsubSystem();
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return <>{children}</>;
}
