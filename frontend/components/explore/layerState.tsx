"use client";
// Map layer visibility, shared by the map (MapView applies it) and the sidebar's Layers tab
// (LayerControl toggles it). AppShell provides it; without a provider each consumer falls back to
// its own copy, so MapView still works on its own.  OWNER: workstream A (Explore), lifted by D's shell.
import { createContext, useCallback, useContext, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

import { DEFAULT_VISIBLE, EXCLUSIVE_GROUPS, type LayerGroup } from "./mapStyle";

/** Per group: a count once loaded, "error" if its fetch failed, "unavailable" if the backend has no
 *  data for it (the toggle is disabled), undefined while loading. */
export type LayerStatus = Partial<Record<LayerGroup, number | "error" | "unavailable">>;

export type LayerVisibility = Record<LayerGroup, boolean>;

export interface LayerState {
  visible: LayerVisibility;
  setVisible: Dispatch<SetStateAction<LayerVisibility>>;
  /** Flip one group; turning a county choropleth on turns the other one off (they'd hide each other). */
  toggleGroup: (g: LayerGroup) => void;
  /** Overlays from other modules (e.g. E's satellite imagery) the viewer switched off, by id. */
  hiddenOverlays: ReadonlySet<string>;
  toggleOverlay: (id: string) => void;
  /** Per-group load status and counts, published by MapView for the Layers tab. */
  status: LayerStatus;
  setStatus: Dispatch<SetStateAction<LayerStatus>>;
}

const Ctx = createContext<LayerState | null>(null);

function useLayerStateValue(): LayerState {
  const [visible, setVisible] = useState<LayerVisibility>(DEFAULT_VISIBLE);
  const [hiddenOverlays, setHiddenOverlays] = useState<ReadonlySet<string>>(() => new Set());
  const [status, setStatus] = useState<LayerStatus>({});
  const toggleGroup = useCallback((g: LayerGroup) => {
    setVisible((v) => {
      const on = !v[g];
      const other = EXCLUSIVE_GROUPS[g];
      return { ...v, [g]: on, ...(on && other ? { [other]: false } : {}) };
    });
  }, []);
  const toggleOverlay = useCallback(
    (id: string) =>
      setHiddenOverlays((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  return useMemo(
    () => ({ visible, setVisible, toggleGroup, hiddenOverlays, toggleOverlay, status, setStatus }),
    [visible, toggleGroup, hiddenOverlays, toggleOverlay, status],
  );
}

export function LayerStateProvider({ children }: { children: ReactNode }) {
  const value = useLayerStateValue();
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLayerState(): LayerState {
  const shared = useContext(Ctx);
  const local = useLayerStateValue(); // always called (hook order); used only without a provider
  return shared ?? local;
}
