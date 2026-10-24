"use client";
// Small "i" marker that reveals where a number comes from: kind badge, source, note
// and link. Opens on hover AND on keyboard focus; click/Enter pins it open (touch);
// Escape or clicking elsewhere closes it. The card is position:fixed so the
// right-hand column's overflow can't clip it, and it stays in DOM order right after
// the button, so Tab moves from the marker into the source link. Built from spans
// only, so it can sit inside <p>, <td> or <summary> without invalid nesting.
// OWNER: workstream C (Evaluate).
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { Provenance, ProvenanceKind } from "@/lib/contract";

import { isPlaceholder } from "./extras";

const KIND_STYLE: Record<ProvenanceKind, string> = {
  observed: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
  simulated: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-300",
  inferred: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-300",
  assumption: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
};

export function KindBadge({ kind }: { kind: ProvenanceKind }) {
  return (
    <span
      className={`shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide ${KIND_STYLE[kind] ?? KIND_STYLE.assumption}`}
    >
      {kind}
    </span>
  );
}

/** Only http(s) links are rendered: provenance arrives as untrusted backend data. */
const safeUrl = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : null);
const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

const CARD_W = 300;
const GAP = 6;

interface Pos {
  left: number;
  top: number;
  above: boolean;
  width: number;
}

export function ProvenanceTip({
  label,
  provenance,
  children,
}: {
  /** What the number is, e.g. "CAPEX" (used for the button's accessible name). */
  label: string;
  provenance: Provenance | Provenance[] | null | undefined;
  /** Optional extra lines shown under the sources (e.g. a formula or cross-check). */
  children?: ReactNode;
}) {
  const items = (Array.isArray(provenance) ? provenance : provenance ? [provenance] : []).filter(Boolean);
  const id = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const open = !dismissed && (hover || focus || pinned) && pos !== null;

  const place = useCallback(() => {
    const b = btnRef.current;
    if (!b) return;
    const r = b.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(CARD_W, vw - 16);
    const left = Math.min(Math.max(8, r.left + r.width / 2 - width / 2), vw - width - 8);
    const above = r.bottom > vh * 0.6;
    setPos({ left, top: above ? r.top - GAP : r.bottom + GAP, above, width });
  }, []);

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };

  // While open, follow the marker when any scroll container or the window moves.
  useEffect(() => {
    if (!open) return;
    const onMove = () => place();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, place]);

  // A pinned card closes on a pointer press anywhere outside it.
  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setPinned(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [pinned]);

  useEffect(() => cancelClose, []);

  const placeholder = items.some(isPlaceholder);

  return (
    <span
      ref={wrapRef}
      className="relative inline-flex align-middle"
      onMouseEnter={() => {
        cancelClose();
        setDismissed(false);
        place();
        setHover(true);
      }}
      onMouseLeave={() => {
        cancelClose();
        closeTimer.current = setTimeout(() => setHover(false), 150);
      }}
      onFocus={() => {
        setDismissed(false);
        place();
        setFocus(true);
      }}
      onBlur={(e) => {
        if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) setFocus(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setPinned(false);
          setDismissed(true);
          btnRef.current?.focus();
        }
      }}
    >
      <button
        ref={btnRef}
        type="button"
        aria-label={`Source for ${label}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-describedby={open ? id : undefined}
        onClick={() => {
          setDismissed(false);
          place();
          setPinned((p) => !p);
        }}
        className={`relative inline-flex h-3.5 w-3.5 shrink-0 cursor-help items-center justify-center rounded-full border text-[9px] font-semibold normal-case leading-none tracking-normal before:absolute before:-inset-1.5 before:content-[''] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-500 ${
          placeholder
            ? "border-amber-500 text-amber-600 dark:text-amber-400"
            : "border-zinc-300 text-zinc-500 hover:border-zinc-500 hover:text-zinc-800 dark:border-zinc-600 dark:text-zinc-400 dark:hover:border-zinc-400 dark:hover:text-zinc-100"
        }`}
      >
        i
      </button>
      {open && pos && (
        <span
          id={id}
          role="tooltip"
          style={{ position: "fixed", left: pos.left, top: pos.top, width: pos.width, transform: pos.above ? "translateY(-100%)" : undefined }}
          className="z-50 block max-h-[60vh] overflow-y-auto rounded-md border border-zinc-200 bg-white p-2.5 text-left text-[11px] font-normal normal-case leading-snug tracking-normal text-zinc-700 shadow-lg dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
        >
          <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{label} · source</span>
          {items.length === 0 && <span className="block text-zinc-500">No provenance reported for this value.</span>}
          {items.map((p, i) => {
            const url = safeUrl(p.url);
            return (
              <span key={i} className={`block ${i > 0 ? "mt-2 border-t border-zinc-100 pt-2 dark:border-zinc-800" : ""}`}>
                <span className="flex items-start gap-1.5">
                  <KindBadge kind={p.kind} />
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{p.source}</span>
                </span>
                {p.note && <span className="mt-1 block whitespace-pre-line text-zinc-600 dark:text-zinc-400">{p.note}</span>}
                {url && (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-block break-all text-sky-700 underline decoration-sky-300 underline-offset-2 hover:decoration-sky-700 focus-visible:outline-2 focus-visible:outline-sky-500 dark:text-sky-400 dark:decoration-sky-700"
                  >
                    {host(url)} ↗
                  </a>
                )}
              </span>
            );
          })}
          {placeholder && (
            <span className="mt-2 block rounded bg-amber-50 px-1.5 py-1 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              Placeholder value: not yet traced to a primary source.
            </span>
          )}
          {children && (
            <span className="mt-2 block border-t border-zinc-100 pt-2 text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">{children}</span>
          )}
        </span>
      )}
    </span>
  );
}
