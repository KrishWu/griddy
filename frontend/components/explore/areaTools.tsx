"use client";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

const AreaToolsContext = createContext<{ host: HTMLDivElement | null; setHost: (host: HTMLDivElement | null) => void } | null>(null);

/** The map owns drawing and layers; the area panel owns where its controls appear. */
export function AreaToolsProvider({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => ({ host, setHost }), [host]);
  return <AreaToolsContext.Provider value={value}>{children}</AreaToolsContext.Provider>;
}

export function useAreaTools() {
  const value = useContext(AreaToolsContext);
  if (!value) throw new Error("Area controls require AreaToolsProvider");
  return value;
}
