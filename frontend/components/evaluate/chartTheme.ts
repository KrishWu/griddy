// Chart colors for the Evaluate panel as CSS variables, so Recharts' SVG fills switch
// with the app's prefers-color-scheme dark mode. Put CHART_VARS on a wrapper element and
// reference colors as fill="var(--ev-...)".
// Categorical slots (capital / operating / credit) are the dataviz reference palette's
// first three hues, validated all-pairs for CVD separation against the panel surfaces
// (#ffffff light, #09090b dark). The aqua credit hue sits below 3:1 on white, so every
// waterfall bar carries a visible value label and the cost table repeats the numbers.
// OWNER: workstream C (Evaluate).

export const CHART_VARS = [
  // series
  "[--ev-capital:#2a78d6] dark:[--ev-capital:#3987e5]",
  "[--ev-operating:#eb6834] dark:[--ev-operating:#d95926]",
  "[--ev-credit:#1baf7a] dark:[--ev-credit:#199e70]",
  "[--ev-total:#3f3f46] dark:[--ev-total:#d4d4d8]",
  // single-series accents
  "[--ev-accent:#2a78d6] dark:[--ev-accent:#3987e5]",
  "[--ev-clean:#008300] dark:[--ev-clean:#008300]",
  "[--ev-context:#a1a1aa] dark:[--ev-context:#52525b]",
  // chrome
  "[--ev-grid:#e4e4e7] dark:[--ev-grid:#27272a]",
  "[--ev-axis:#d4d4d8] dark:[--ev-axis:#3f3f46]",
  "[--ev-muted:#71717a] dark:[--ev-muted:#a1a1aa]",
  "[--ev-label:#3f3f46] dark:[--ev-label:#d4d4d8]",
  "[--ev-cursor:#f4f4f5] dark:[--ev-cursor:#18181b]",
].join(" ");

/** Shared Recharts tick style. */
export const TICK = { fill: "var(--ev-muted)", fontSize: 10 } as const;

/** Tooltip card classes shared by every chart's custom tooltip content. */
export const TOOLTIP_CARD =
  "rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-[11px] leading-snug text-zinc-700 shadow-md dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200";
