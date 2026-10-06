// Setup's calls, over whatever `call` it is given (the app's box connection, or a fake box in a test).
import { endingOf, type Ending, type Setup, type Status } from "./model.ts";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;

export function onboardSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    /** The box's own record of setup, and its ten-step list when it has one (a box without onboard.setup answers null there). */
    async read(): Promise<{ status: Status; setup: Setup }> {
      const status = await ask<Status>("onboard.status");
      const s = await call<Setup>("onboard.setup");
      return { status, setup: s.error ? null : s.data ?? null };
    },
    /** Step 8: the person's name, and the assistant's. */
    you: (name: string, assistant?: string) => ask<unknown>("onboard.you", { name, ...(assistant ? { assistant } : {}) }),
    /** Skip the computers or history step. onboard.setup records it when the box has it, onboard.skip otherwise. */
    async skip(step: "computers" | "history", hasSetup: boolean): Promise<void> {
      if (hasSetup) await ask("onboard.setup", { skip: step });
      else await ask("onboard.skip", { step: step === "computers" ? "devices" : step });
    },
    /** Step 10: ask for the history scan, then pass the step. */
    async history(hasSetup: boolean): Promise<void> {
      await call("onboard.history", { action: "start" });
      if (hasSetup) await call("onboard.setup", { pass: "history" });
    },
    /** The ending: onboard.finish makes the assistant and says hello in its first thread. */
    async finish(): Promise<Ending> { return endingOf(await ask<unknown>("onboard.finish")); },
    /** Try the assistant again after it failed to start. */
    async retry(): Promise<Ending> {
      const r = await call<unknown>("onboard.assistant", { retry: true });
      if (!r.error) return endingOf(r.data);
      return endingOf(await ask<unknown>("onboard.finish"));
    },
  };
}
