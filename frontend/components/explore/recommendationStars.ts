import type { Map as MLMap } from "maplibre-gl";
import { ASSET_FUEL, FUEL_COLOR, REC_SITE_RING } from "./palette";

export const STAR_POINTS: [number, number][] = Array.from({ length: 10 }, (_, i) => {
  const angle = -Math.PI / 2 + i * Math.PI / 5;
  const radius = i % 2 ? 10.5 : 24;
  return [32 + Math.cos(angle) * radius, 32 + Math.sin(angle) * radius];
});
export const STAR_ICON_PREFIX = "recommended-star-";

/** Local raster icons avoid a remote sprite or font dependency, including on the fallback map. */
export function installRecommendationStars(map: MLMap): void {
  const colors = { ...Object.fromEntries(Object.entries(ASSET_FUEL).map(([kind, fuel]) => [kind, FUEL_COLOR[fuel]])), other: FUEL_COLOR.other };
  for (const [kind, color] of Object.entries(colors)) {
    const id = STAR_ICON_PREFIX + kind;
    if (map.hasImage(id)) continue;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Star markers require a 2D canvas");
    context.beginPath();
    STAR_POINTS.forEach(([x, y], i) => i ? context.lineTo(x, y) : context.moveTo(x, y));
    context.closePath();
    context.lineJoin = "round";
    context.strokeStyle = REC_SITE_RING;
    context.lineWidth = 8;
    context.stroke();
    context.strokeStyle = "#FFFFFF";
    context.lineWidth = 4;
    context.stroke();
    context.fillStyle = color;
    context.fill();
    map.addImage(id, context.getImageData(0, 0, 64, 64), { pixelRatio: 2 });
  }
}
