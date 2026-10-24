// Renders Finding[] from any module. SHARED (foundation).
import type { Finding } from "@/lib/contract";

const COLOR: Record<Finding["severity"], string> = {
  pass: "bg-emerald-500",
  info: "bg-sky-500",
  warn: "bg-amber-500",
  fail: "bg-red-500",
};

export function FindingsList({ findings }: { findings: Finding[] }) {
  if (!findings.length) return <p className="text-sm text-zinc-500">No findings.</p>;
  return (
    <ul className="space-y-2">
      {findings.map((f) => (
        <li key={`${f.module}-${f.id}`} className="flex gap-2 text-sm">
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${COLOR[f.severity]}`} />
          <div>
            <div className="font-medium">
              {f.title}
              {f.needs_utility_study && <span className="ml-2 text-[10px] uppercase text-amber-600">needs utility study</span>}
            </div>
            <div className="text-zinc-500">{f.detail}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}
