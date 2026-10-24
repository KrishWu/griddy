"use client";
// Light / Dark / Mixed theme switch. The theme itself lives in the viewer settings (lib/settings.tsx,
// which also writes the old "griddy:theme" key); this is a compact control for it, used by the
// Settings panel and any page header that wants one.
import { useSyncExternalStore } from "react";

import { updateSettings, LEGACY_THEME_KEY } from "@/lib/settings";

/** The theme on <html>: Mixed = black chrome with a light map. */
export type Theme = "light" | "dark" | "mixed";
/** @deprecated Use LEGACY_THEME_KEY / SETTINGS_KEY from lib/settings. */
export const THEME_KEY = LEGACY_THEME_KEY;

const asTheme = (v: string | undefined): Theme => (v === "dark" || v === "mixed" ? v : "light");

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** The resolved theme, as applied to <html> (system preference already applied). */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => asTheme(document.documentElement.dataset.theme), () => "light");
}

const OPTIONS: { value: Theme; label: string; icon: string; title: string }[] = [
  { value: "light", label: "Light", icon: "☀", title: "Light theme" },
  { value: "dark", label: "Dark", icon: "◐", title: "Dark theme" },
  { value: "mixed", label: "Mixed", icon: "◧", title: "Mixed: black panels, light map" },
];

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const theme = useTheme();
  return (
    <div role="group" aria-label="Color theme" className="flex rounded-md border border-zinc-300 p-0.5 text-xs dark:border-zinc-700">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={theme === o.value}
          title={o.title}
          aria-label={compact ? o.title : undefined}
          className={`rounded px-2 py-1 ${theme === o.value ? "bg-emerald-800 text-white dark:bg-cyan-300 dark:text-slate-950" : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white"}`}
          onClick={() => updateSettings({ theme: o.value })}
        >
          <span aria-hidden>{o.icon}</span>
          {!compact && <span className="ml-1">{o.label}</span>}
        </button>
      ))}
    </div>
  );
}
