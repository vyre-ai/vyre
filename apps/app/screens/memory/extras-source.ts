// Memory's other calls on the real vyred, over an injected `call` (the app's box connection, or a fake box in a test):
// memory.ask (a question, with its sources or an honest abstain), memory.graph (the floor plan), memory.pin and memory.mute (a node, everywhere),
// memory.corrections and memory.uncorrect (what the person corrected, with Undo).
import type { CorrectionRow, GraphOut, Asked } from "./extras-model";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;

export function memoryExtras(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    askReal: (question: string) => ask<Asked>("memory.ask", { question }),
    graphReal: (limit = 150) => ask<GraphOut>("memory.graph", { limit }),
    /** Pin or mute a node everywhere; off undoes it. */
    async steerReal(mode: "pin" | "mute", node: string, off: boolean): Promise<void> {
      await ask(mode === "pin" ? "memory.pin" : "memory.mute", { node, scope: "*", off });
    },
    async correctionsReal(): Promise<CorrectionRow[]> {
      const r = await ask<CorrectionRow[]>("memory.corrections", {});
      return Array.isArray(r) ? r : [];
    },
    async uncorrectReal(id: number): Promise<void> { await ask("memory.uncorrect", { id }); },
  };
}
