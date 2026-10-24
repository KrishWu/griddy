import type { Scenario, ScenarioResult } from "@/lib/contract";
import { request } from "@/lib/api";

export interface RunProgress { percent: number | null; message: string; }

/** Percent advances only on completed backend stages. A legacy backend remains usable. */
export async function runWithProgress(scenario: Scenario, onProgress: (progress: RunProgress) => void, signal: AbortSignal): Promise<ScenarioResult> {
  const response = await fetch("/api/projects/run-stream", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(scenario), signal,
  });
  if (response.status === 404 || response.status === 405) {
    onProgress({ percent: null, message: "Running simulation" });
    const result = await request<ScenarioResult>("/run", { method: "POST", body: JSON.stringify(scenario), signal });
    onProgress({ percent: 100, message: "Results ready" });
    return result;
  }
  if (!response.ok || !response.body) throw new Error("Could not start the simulation. Please retry.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let result: ScenarioResult | undefined;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "error") throw new Error(event.message || "Simulation failed.");
    if (event.type === "progress" && typeof event.percent === "number" && Number.isFinite(event.percent)) {
      onProgress({ percent: Math.max(0, Math.min(99, event.percent)), message: event.message });
    } else if (event.type === "result") {
      result = event.result as ScenarioResult;
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) consume(line);
      if (done) break;
    }
    consume(pending);
    if (!result) throw new Error("Simulation connection ended before results arrived. Please retry.");
    onProgress({ percent: 100, message: "Results ready" });
    return result;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
