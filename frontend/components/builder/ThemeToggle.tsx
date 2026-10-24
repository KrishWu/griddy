"use client";

import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
export const THEME_KEY = "griddy:theme";

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const sync = (event: StorageEvent) => {
    if (event.key === THEME_KEY) {
      document.documentElement.dataset.theme = event.newValue === "dark" ? "dark" : "light";
    }
  };
  window.addEventListener("storage", sync);
  return () => { observer.disconnect(); window.removeEventListener("storage", sync); };
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe,
    () => document.documentElement.dataset.theme === "dark" ? "dark" : "light",
    () => "light");
}

export function ThemeToggle() {
  const theme = useTheme();
  const select = (next: Theme) => {
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* Theme still works when storage is unavailable. */ }
  };
  return <div role="group" aria-label="Color theme" className="flex rounded-md border border-zinc-300 p-0.5 text-xs dark:border-zinc-700">
    {(["light", "dark"] as const).map(t => <button key={t} type="button" aria-pressed={theme === t}
      className={`rounded px-2 py-1 ${theme === t ? "bg-emerald-800 text-white dark:bg-cyan-300 dark:text-slate-950" : "text-zinc-600 dark:text-zinc-300"}`}
      onClick={() => select(t)}>{t === "light" ? "☀ Light" : "◐ Dark"}</button>)}
  </div>;
}
