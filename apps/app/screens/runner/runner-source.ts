// The runner's calls (session-transfer's contract, R031-95), over an injected `call` so a test uses a fake box. A box without the runner answers no_such_tool: every read says null then and the
// screens show nothing, never an error. Nothing here carries a value or a key: placements, settings and what runs.
import { DEFAULT_SETTINGS, pickHere, pickSettings, pickPlacement, type MacSettings, type Placement } from "./runner-model.js";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;

export function runnerSource(call: Call) {
  const maybe = async <T,>(tool: string, input: Record<string, unknown> = {}): Promise<T | null> => { const r = await call<T>(tool, input); return r.error ? null : (r.data as T); };
  const ask = async <T,>(tool: string, input: Record<string, unknown> = {}): Promise<T> => { const r = await call<T>(tool, input); if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r.data as T; };
  return {
    /** Where one session runs; null when the box has no runner. */
    async placement(thread: string): Promise<Placement | null> {
      const d = await maybe<any>("runner.placement", { thread });
      return pickPlacement(d);
    },
    async move(thread: string, to: "mac" | "server"): Promise<Placement | null> { return pickPlacement(await ask<any>("runner.move", { thread, to })); },
    /** Why a session did not run here: one reason code, or null. */
    async whyNot(thread: string): Promise<string | null> { const d = await maybe<any>("runner.whyNot", { thread }); return d && typeof d.reason === "string" ? d.reason : null; },
    async settings(): Promise<MacSettings | null> { const d = await maybe<any>("runner.settings"); return d ? pickSettings(d) : null; },
    async setSettings(s: MacSettings): Promise<MacSettings> { return pickSettings(await ask("runner.settings.set", { enabled: s.enabled, pluggedInOnly: s.pluggedInOnly, cpuPercent: s.cpuPercent, memoryMb: s.memoryMb })); },
    async here() { return pickHere(await maybe("runner.here")); },
    pauseAll: () => ask("runner.pauseAll"),
    resumeAll: () => ask("runner.resumeAll"),
    defaults: DEFAULT_SETTINGS,
  };
}
