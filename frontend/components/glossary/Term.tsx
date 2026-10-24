"use client";
// <Term k="lcoe">LCOE</Term>: jargon that explains itself. The word gets a dotted underline and a
// plain-language card (lib/glossary.ts) on mouse hover, on keyboard focus (Tab) and on tap; click/tap
// pins it, Escape or a press elsewhere closes it. Settings > "Explain jargon on hover" off (the
// `explainJargon` key of the shared settings store, lib/settings.tsx) renders the children as plain
// text on every page at once, and so does an unknown key (with a dev-only console warning).
//
// The card is portaled to <body> and position: fixed, so no scroll container, overflow:hidden or
// containing block (a transform, a filter, or the layout containment of an @container) can clip or
// shift it. Because it leaves its subtree, it copies the two theme hooks the stylesheet keys on
// (a subtree data-theme, and Mixed's data-chrome; see app/globals.css) so it matches the panel the
// word sits in. The trigger is a focusable span, not a button, so it may sit inside a <label>,
// <summary>, <th> or <p>; aria-describedby points at the card, which stays in the DOM (hidden) so
// screen readers hear the definition on focus. Inline only: no extra line height, nothing reflows.
// Use it on the first or most prominent occurrence per panel (headings, stat labels, table
// headers), never inside a <button>, <a> or <option>.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { glossaryEntry, type GlossaryEntry, type GlossaryKey } from "@/lib/glossary";
import { useExplainJargon } from "@/lib/settings";

const CARD_W = 264;
const GAP = 6; // between the word and the card
const EDGE = 8; // minimum distance from the viewport edge
const OPEN_DELAY_MS = 120; // a pointer passing over a sentence shouldn't flash cards
const CLOSE_DELAY_MS = 150; // time to move the pointer from the word onto the card

const warned = new Set<string>();

export function Term({ k, children, className }: { k: GlossaryKey; children?: ReactNode; className?: string }) {
  const explain = useExplainJargon();
  const entry = glossaryEntry(k);
  if (!entry) {
    if (process.env.NODE_ENV !== "production" && !warned.has(k)) {
      warned.add(k);
      console.warn(`<Term>: no glossary entry for "${k}" (lib/glossary.ts); rendering plain text.`);
    }
    return <>{children}</>;
  }
  if (!explain) return <>{children ?? entry.term}</>;
  return (
    <TermTip entry={entry} className={className}>
      {children ?? entry.term}
    </TermTip>
  );
}

const noSubscribe = () => () => {};
/** False during the server render and hydration, true after: portals need document.body. */
const useClient = () => useSyncExternalStore(noSubscribe, () => true, () => false);

function TermTip({ entry, className, children }: { entry: GlossaryEntry; className?: string; children: ReactNode }) {
  const id = useId();
  const client = useClient();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = !dismissed && (hover || focus || pinned);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clearTimer, []);

  const pointerIn = (pointerType: string) => {
    if (pointerType === "touch") return; // taps go through onClick (pin), not hover
    clearTimer();
    if (hover) return;
    timer.current = setTimeout(() => {
      setDismissed(false);
      setHover(true);
    }, OPEN_DELAY_MS);
  };
  const pointerOut = (pointerType: string) => {
    if (pointerType === "touch") return;
    clearTimer();
    timer.current = setTimeout(() => setHover(false), CLOSE_DELAY_MS);
  };

  const place = useCallback(() => {
    const t = triggerRef.current;
    const card = cardRef.current;
    if (!t || !card) return;
    // Match the panel the word sits in: a dark subtree, or Mixed's black chrome.
    const themed = t.closest<HTMLElement>("[data-theme]");
    if (themed && themed !== document.documentElement) card.dataset.theme = themed.dataset.theme;
    else delete card.dataset.theme;
    if (t.closest("[data-chrome]")) card.dataset.chrome = "";
    else delete card.dataset.chrome;

    // A term wrapped over two lines anchors to its first line.
    const r = t.getClientRects()[0] ?? t.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(CARD_W, vw - 2 * EDGE);
    card.style.width = `${width}px`;
    card.style.left = "0px";
    card.style.top = "0px";
    // Where (0, 0) really lands: normally the viewport corner, but measuring keeps the card right
    // even if a future ancestor of <body> becomes the containing block for fixed elements.
    const origin = card.getBoundingClientRect();
    const h = origin.height;
    const left = Math.min(Math.max(EDGE, r.left + r.width / 2 - width / 2), vw - width - EDGE);
    const roomAbove = r.top - GAP - EDGE;
    const roomBelow = vh - r.bottom - GAP - EDGE;
    const above = h <= roomAbove || roomAbove > roomBelow;
    const top = Math.max(EDGE, Math.min(above ? r.top - GAP - h : r.bottom + GAP, vh - h - EDGE));
    card.style.left = `${left - origin.left}px`;
    card.style.top = `${top - origin.top}px`;
    // A focused or pinned word scrolled out of its sidebar (or covered by a drawer) leaves nothing to
    // point at: hide the card until the word is visible again.
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    card.style.visibility = !hit || (!t.contains(hit) && !card.contains(hit)) ? "hidden" : "";
  }, []);

  // While open: position before paint, follow the word through any scroll or resize, and let
  // Escape close it from anywhere (WCAG 1.4.13: dismissible without moving pointer or focus).
  // That Escape closes only the card: the listener runs first (window, capture phase) and stops the
  // event, so the Forecast drawer (a window listener) or the Settings dialog (a React handler)
  // around the word stays open; the next Escape reaches them.
  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onMove = () => place();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setPinned(false);
      setDismissed(true);
    };
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, place]);

  // A pinned card closes on a press anywhere outside the word and the card.
  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!triggerRef.current?.contains(target) && !cardRef.current?.contains(target)) setPinned(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [pinned]);

  const card = (
    <span
      ref={cardRef}
      id={id}
      role="tooltip"
      hidden={!open}
      onPointerEnter={(e) => pointerIn(e.pointerType)}
      onPointerLeave={(e) => pointerOut(e.pointerType)}
      // React bubbles portal events to the word's ancestors; a press on the card is not a click on them.
      onClick={(e) => e.stopPropagation()}
      className={
        open
          ? "fixed left-0 top-0 z-[70] block max-h-[60vh] overflow-y-auto rounded-md border border-zinc-200 bg-white p-2.5 text-left text-[11px] font-normal normal-case leading-snug tracking-normal whitespace-normal text-zinc-700 shadow-lg dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
          : undefined
      }
    >
      <span className="block text-[11px] font-semibold text-zinc-900 dark:text-zinc-50">
        {entry.term}
        {entry.long && <span className="font-normal text-zinc-500 dark:text-zinc-400"> · {entry.long}</span>}
      </span>
      <span className="mt-1 block">{entry.def}</span>
      {entry.why && (
        <span className="mt-1.5 block text-zinc-600 dark:text-zinc-400">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Why it matters: </span>
          {entry.why}
        </span>
      )}
      {entry.unit && (
        <span className="mt-1.5 block text-[10px] text-zinc-500 dark:text-zinc-400">
          <span className="uppercase tracking-wide">Unit</span> {entry.unit}
        </span>
      )}
    </span>
  );

  return (
    <>
      <span
        ref={triggerRef}
        tabIndex={0}
        aria-describedby={id}
        onPointerEnter={(e) => pointerIn(e.pointerType)}
        onPointerLeave={(e) => pointerOut(e.pointerType)}
        onFocus={(e) => {
          // Keyboard focus opens it; the focus a tap or click leaves behind does not (onClick pins instead).
          let visible = true;
          try {
            visible = e.currentTarget.matches(":focus-visible");
          } catch {
            /* very old browser: treat every focus as keyboard focus */
          }
          if (!visible) return;
          setDismissed(false);
          setFocus(true);
        }}
        onBlur={() => setFocus(false)}
        onClick={(e) => {
          // Inside a <label> or <summary> a tap on the word explains it instead of focusing the
          // input or toggling the section.
          e.preventDefault();
          setDismissed(false);
          setPinned((p) => !p);
        }}
        // Focus shows as an outline plus a tint: inside a truncating label (overflow: hidden) the outline's
        // sides are clipped, the tint never is.
        className={`cursor-help rounded-[2px] underline decoration-zinc-400 decoration-dotted decoration-1 underline-offset-2 hover:decoration-zinc-600 focus-visible:bg-sky-500/15 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-500 dark:decoration-zinc-500 dark:hover:decoration-zinc-300 print:no-underline ${className ?? ""}`}
      >
        {children}
      </span>
      {client && createPortal(card, document.body)}
    </>
  );
}
