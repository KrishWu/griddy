"use client";
// Is the sidebar tab panel around this subtree showing? Sidebar.tsx provides it per panel; anything
// outside a sidebar (the map, Compare, the Forecast drawer) reads the default, true.  OWNER: D.
// Hidden panels stay mounted (display: none) to keep their state, but a Recharts ResponsiveContainer
// in one measures 0 x 0 and logs a width(0)/height(0) warning on every re-render (each new result).
// Charts read this and render only while their panel is shown; their sized wrapper stays, so
// nothing shifts when the tab opens again.
import { createContext, useContext } from "react";

export const PanelActiveContext = createContext(true);

export function usePanelActive(): boolean {
  return useContext(PanelActiveContext);
}
