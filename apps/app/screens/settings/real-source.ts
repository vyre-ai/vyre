// Settings' calls on the real box (update.*, push.*), over an injected `call` (the app's box connection, or a fake box in a test).
import type { PushDevice, PushSettings, UpdateStatus } from "./real-model";
import type { Agent, Provider, Usage } from "./agents-model";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;

export function settingsSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    updateStatus: () => ask<UpdateStatus>("update.status"),
    updateCheck: () => ask<UpdateStatus>("update.check"),
    updateApply: () => ask<{ requested?: boolean; reason?: string }>("update.apply"),
    pushSettings: () => ask<PushSettings>("push.settings"),
    /** Change only what is given: kinds merge, quiet is replaced (null for none). */
    pushSet: (patch: { quiet?: PushSettings["quiet"]; kinds?: Record<string, boolean> }) => ask<PushSettings>("push.settings", patch as Record<string, unknown>),
    agentsList: async () => { const r = await ask<Agent[]>("agents.list"); return Array.isArray(r) ? r : []; },
    agentsUsage: async () => { const r = await ask<Usage[]>("agents.usage"); return Array.isArray(r) ? r : []; },
    /** Pause: stop every running thread (its record and notes stay). Resume: start its latest thread again. */
    agentStop: (agent: string) => ask<{ stopped: string[] }>("agents.stop", { agent }),
    agentResume: (agent: string) => ask<{ running?: boolean }>("agents.resume", { agent }),
    providers: async () => { const r = await ask<Provider[]>("providers.list"); return Array.isArray(r) ? r : []; },
    pushDevices: async () => { const r = await ask<PushDevice[]>("push.devices"); return Array.isArray(r) ? r : []; },
  };
}
