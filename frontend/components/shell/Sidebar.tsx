"use client";
// A tabbed sidebar that folds to a slim rail, so the map can take the width.  OWNER: workstream D.
// - Tabs follow the WAI-ARIA tabs pattern: arrow keys / Home / End move and select, the selected tab
//   is the only one in the Tab order, each panel is labelled by its tab.
// - A tab's panel mounts on first visit and then stays mounted (hidden), so switching tabs or folding
//   the sidebar keeps panel state (B's selected day, a loaded table) and doesn't refetch.
//   A tab points aria-controls at its panel only once that panel exists. Each panel tells its charts
//   whether it is showing (panelActive.ts), so hidden charts don't measure 0 x 0.
// - lg+ (side by side with the map): collapsed = a 52 px rail of icon buttons that reopen a tab.
//   Below lg (stacked): collapsed = just the tab strip; picking a tab opens it again.
// - Folding swaps controls (strip <-> rail), so the button that was pressed can disappear: focus
//   then moves to the control in its place (the other fold button, or the reopened tab), never to
//   <body> (WCAG 2.4.3).
// - data-chrome: black in the Mixed theme (globals.css).
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";

import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon } from "./icons";
import { PanelActiveContext } from "./panelActive";

export interface SidebarTab {
  id: string;
  label: string;
  /** Shown on the collapsed rail (the tab strip is text-only, so four tabs fit a 300 px sidebar). */
  icon: ReactNode;
  /** Longer description for the rail button's tooltip. */
  hint?: string;
  content: ReactNode;
}

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-emerald-600 dark:focus-visible:outline-cyan-300";
const shown = (el: HTMLElement | null | undefined): el is HTMLElement => !!el && el.getClientRects().length > 0;

export function Sidebar(props: {
  side: "left" | "right";
  /** Accessible name of the sidebar and its tab list, e.g. "Plan and explore". */
  label: string;
  tabs: SidebarTab[];
  active: string;
  onSelect: (id: string) => void;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const { side, label, tabs, active, onSelect, collapsed, onCollapsedChange } = props;
  const base = useId();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const stripFold = useRef<HTMLButtonElement>(null);
  const railFold = useRef<HTMLButtonElement>(null);
  /** Set by a fold / unfold the viewer pressed here: what to focus once the swap has rendered
   *  ("fold" = whichever copy of the fold button is showing). */
  const focusAfter = useRef<"fold" | { tab: string } | null>(null);
  const current = tabs.some((t) => t.id === active) ? active : tabs[0]?.id;
  // Panels mount on first visit, then stay (hidden). Derived during render, React's documented pattern.
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set(current ? [current] : []));
  if (current && !visited.has(current)) setVisited(new Set(visited).add(current));

  const tabId = (id: string) => `${base}-tab-${id}`;
  const panelId = (id: string) => `${base}-panel-${id}`;
  const open = (id: string) => {
    onSelect(id);
    if (!collapsed) return;
    focusAfter.current = { tab: id }; // a rail button vanishes with the rail: focus the reopened tab
    onCollapsedChange(false);
  };
  const toggleFold = () => {
    focusAfter.current = "fold";
    onCollapsedChange(!collapsed);
  };
  // After a fold the viewer triggered (not one from Settings), focus the control that replaced the
  // pressed one. Layout effect: the new classes are in the DOM, so visibility can be measured.
  useLayoutEffect(() => {
    const want = focusAfter.current;
    focusAfter.current = null;
    if (!want) return;
    const target = want === "fold" ? [railFold.current, stripFold.current].find(shown) : tabRefs.current[want.tab];
    if (shown(target) && target !== document.activeElement) target.focus();
  }, [collapsed]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === current);
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % tabs.length
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + tabs.length) % tabs.length
      : e.key === "Home" ? 0
      : e.key === "End" ? tabs.length - 1
      : -1;
    if (next < 0 || !tabs[next]) return;
    e.preventDefault();
    open(tabs[next].id);
    tabRefs.current[tabs[next].id]?.focus();
  };

  const left = side === "left";
  // lg: the chevron points to the edge it folds toward; stacked: up = fold, down = unfold.
  const FoldIcon = collapsed ? (left ? ChevronRightIcon : ChevronLeftIcon) : left ? ChevronLeftIcon : ChevronRightIcon;
  const foldLabel = `${collapsed ? "Expand" : "Collapse"} the ${label} sidebar`;
  const foldButton = (ref: Ref<HTMLButtonElement>) => (
    <button
      ref={ref}
      type="button"
      onClick={toggleFold}
      aria-expanded={!collapsed}
      aria-label={foldLabel}
      title={collapsed ? "Expand" : "Collapse to give the map more room"}
      className={`shrink-0 rounded-md p-1.5 text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 ${FOCUS}`}
    >
      <FoldIcon className="hidden h-4 w-4 lg:block" />
      {collapsed ? <ChevronDownIcon className="h-4 w-4 lg:hidden" /> : <ChevronUpIcon className="h-4 w-4 lg:hidden" />}
    </button>
  );

  return (
    <aside
      data-chrome
      aria-label={label}
      className={`flex min-w-0 flex-col border-zinc-200 bg-zinc-50 lg:min-h-0 dark:border-zinc-800 dark:bg-black ${left ? "lg:border-r" : "border-t lg:border-l lg:border-t-0"}`}
    >
      {/* Tab strip: always when expanded; when collapsed only below lg (lg shows the rail instead). */}
      <div className={`items-center gap-1 border-b border-zinc-200 px-2 pt-1.5 dark:border-zinc-800 ${collapsed ? "flex lg:hidden" : "flex"} ${left ? "" : "flex-row-reverse"}`}>
        <div role="tablist" aria-label={`${label} tabs`} aria-orientation="horizontal" onKeyDown={onKeyDown} className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto">
          {tabs.map((t) => {
            const selected = t.id === current;
            return (
              <button
                key={t.id}
                ref={(node) => {
                  tabRefs.current[t.id] = node;
                }}
                type="button"
                role="tab"
                id={tabId(t.id)}
                aria-selected={selected}
                aria-controls={visited.has(t.id) ? panelId(t.id) : undefined}
                tabIndex={selected ? 0 : -1}
                onClick={() => open(t.id)}
                className={`-mb-px shrink-0 rounded-t-md border-b-2 px-2.5 py-1.5 text-sm font-medium ${FOCUS} ${
                  selected
                    ? "border-emerald-700 text-zinc-900 dark:border-cyan-300 dark:text-white"
                    : "border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-800 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-100"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        {foldButton(stripFold)}
      </div>

      {/* lg rail: icon buttons that reopen a tab. Not a tablist: the panels are folded away. */}
      {collapsed && (
        <nav aria-label={`${label} (collapsed)`} className="hidden flex-col items-center gap-1 py-2 lg:flex">
          {foldButton(railFold)}
          <div className="my-1 h-px w-7 bg-zinc-200 dark:bg-zinc-800" />
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => open(t.id)}
              title={t.hint ?? t.label}
              aria-label={`Open ${t.label}`}
              className={`flex w-11 flex-col items-center gap-0.5 rounded-md py-1.5 text-[10px] font-medium leading-none ${FOCUS} ${
                t.id === current
                  ? "bg-emerald-50 text-emerald-800 dark:bg-zinc-900 dark:text-cyan-300"
                  : "text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              }`}
            >
              {t.icon}
              <span className="max-w-full truncate">{t.label}</span>
            </button>
          ))}
        </nav>
      )}

      {tabs.map((t) => {
        if (!visited.has(t.id)) return null;
        const hidden = collapsed || t.id !== current;
        return (
          <div
            key={t.id}
            role="tabpanel"
            id={panelId(t.id)}
            aria-labelledby={tabId(t.id)}
            tabIndex={0}
            hidden={hidden}
            className={`min-h-0 flex-1 space-y-3 p-3 lg:overflow-y-auto ${FOCUS}`}
          >
            <PanelActiveContext value={!hidden}>{t.content}</PanelActiveContext>
          </div>
        );
      })}
    </aside>
  );
}
