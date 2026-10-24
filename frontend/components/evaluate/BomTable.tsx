"use client";
// Bill of materials grouped by the backend's item-name prefix ("Generation: ",
// "Land: ", "Interconnection: ", "Electrical: "); every row shows its basis (the
// formula and numbers behind the count). Unprefixed items (older backends) go under
// "Other". OWNER: workstream C (Evaluate).
import { Term } from "@/components/glossary/Term";
import type { BomItem } from "@/lib/contract";

import { finite, qty } from "./fmt";

const GROUPS = ["Generation", "Land", "Interconnection", "Electrical"] as const;

export function groupBom(bom: BomItem[]): { group: string; items: (BomItem & { name: string })[] }[] {
  const out = new Map<string, (BomItem & { name: string })[]>();
  for (const g of [...GROUPS, "Other"]) out.set(g, []);
  for (const b of bom) {
    const g = GROUPS.find((p) => b.item.startsWith(`${p}: `));
    out.get(g ?? "Other")?.push({ ...b, name: g ? b.item.slice(g.length + 2) : b.item });
  }
  return [...out.entries()].filter(([, items]) => items.length > 0).map(([group, items]) => ({ group, items }));
}

export function BomTable({ bom }: { bom: BomItem[] }) {
  const groups = groupBom(bom);
  if (!groups.length) return <p className="text-xs text-zinc-500">No bill of materials reported.</p>;
  return (
    <div className="space-y-3">
      {groups.map(({ group, items }) => (
        <table key={group} className="w-full text-[11px]">
          <caption className="pb-0.5 text-left text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            {group === "Interconnection" ? <Term k="interconnection">{group}</Term> : group}{" "}
            <span className="font-normal normal-case tracking-normal">· {items.length}</span>
          </caption>
          <tbody>
            {items.map((b, i) => {
              const q = finite(b.quantity);
              return (
                <tr key={i} className="border-t border-zinc-100 align-top dark:border-zinc-800">
                  <td className="py-1 pr-2">
                    <div className="text-zinc-800 dark:text-zinc-200">{b.name}</div>
                    {b.basis && <div className="mt-0.5 break-words text-[10px] leading-snug text-zinc-500">{b.basis}</div>}
                  </td>
                  <td className="whitespace-nowrap py-1 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                    {q !== undefined ? qty(q) : "—"} <span className="text-zinc-500">{b.unit}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ))}
    </div>
  );
}
