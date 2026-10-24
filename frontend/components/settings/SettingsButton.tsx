"use client";
// Header gear button + the Settings drawer it opens.  OWNER: workstream D (shell).
// The drawer is a modal dialog on the right: focus moves into it, Tab / Shift+Tab stay inside, Esc
// or the close button or a click outside closes it, and focus returns to the gear. No dimming scrim,
// so the map stays visible at its true colors while the contrast and brightness sliders move.
// Usable from any page header (/, /about, /report): the drawer is portaled to <body>, so a sticky or
// blurred header (which would trap position: fixed) can't clip it.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { CloseIcon, GearIcon } from "@/components/shell/icons";

import { SettingsPanel } from "./SettingsPanel";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function SettingsButton({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const gear = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={gear}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Settings"
        title="Settings: theme, map display, text size"
        className={`rounded-md border border-zinc-300 p-1 text-zinc-600 hover:border-zinc-400 hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-emerald-600 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-500 dark:hover:text-white dark:focus-visible:outline-cyan-300 ${className}`}
      >
        <GearIcon className="h-4 w-4" />
      </button>
      {open && (
        <SettingsDrawer
          onClose={() => {
            setOpen(false);
            gear.current?.focus(); // focus back where it was
          }}
        />
      )}
    </>
  );
}

function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    close.current?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation(); // don't also close the map's forecast drawer
      onClose();
      return;
    }
    if (e.key !== "Tab" || !dialog.current) return;
    // Focus trap: wrap from the last control to the first and back.
    const items = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <>
      {/* Click outside closes; transparent so the map's colors aren't altered while adjusting them. */}
      <div aria-hidden className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={dialog}
        data-chrome
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="fixed inset-y-0 right-0 z-50 flex w-[min(23rem,100vw)] flex-col border-l border-zinc-200 bg-white text-zinc-900 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
      >
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 id={titleId} className="text-base font-semibold">
            Settings
          </h2>
          <button
            ref={close}
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            title="Close (Esc)"
            className="rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-emerald-600 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 dark:focus-visible:outline-cyan-300"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <SettingsPanel />
        </div>
      </div>
    </>,
    document.body,
  );
}
