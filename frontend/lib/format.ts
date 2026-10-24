// Number formatting shared by every panel. SHARED (foundation).
export const usd = (v: number) =>
  Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v).toLocaleString()}`;
export const mw = (v: number) => `${Math.round(v).toLocaleString()} MW`;
export const mwh = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)} TWh` : v >= 1e3 ? `${(v / 1e3).toFixed(1)} GWh` : `${Math.round(v)} MWh`);
export const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
export const tons = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)} Mt` : `${Math.round(v).toLocaleString()} t`);
