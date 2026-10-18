// A Flow's chat: each run is a thread (work.flow.threads). Over an injected `call`; until the tool exists on a box the list is empty and the run list is shown instead.
export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;
export type FlowThread = { id: string; kind: "run" | "made"; flow: string; state: "live" | "idle" | "needs_you" };

export const threadsSource = (call: Call) => ({
  /** The Flow's run threads, newest first as the box sends them; none when the box does not have the tool yet. */
  list: async (flow: string): Promise<FlowThread[]> => {
    const r = await call<{ threads?: FlowThread[] }>("work.flow.threads", { flow });
    return r.error ? [] : (r.data?.threads ?? []).filter((t) => t && typeof t.id === "string");
  },
});
