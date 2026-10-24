// Always-visible titles for named places on the map, e.g. where the website starts.
// OWNER: workstream A (Explore). DOM markers rather than map layers, so they survive basemap
// swaps and theme changes; they ignore the pointer, so clicking near one still selects a site.

export interface Landmark {
  name: string;
  lon: number;
  lat: number;
}

/** Stanford University: the website's start site (backend DEFAULT_SITE). */
export const LANDMARKS: Landmark[] = [{ name: "Stanford University", lon: -122.1697, lat: 37.4275 }];

export function landmarkElement(name: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "pointer-events-none flex select-none flex-col items-center";
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", name);
  const label = document.createElement("div");
  label.className = "whitespace-nowrap rounded-md bg-[#8c1515] px-3 py-1 text-sm font-bold tracking-tight text-white shadow-lg ring-2 ring-white";
  label.textContent = name;
  const tip = document.createElement("div");
  tip.className = "-mt-px h-0 w-0 border-x-[7px] border-t-[8px] border-x-transparent border-t-[#8c1515]";
  el.append(label, tip);
  return el;
}
