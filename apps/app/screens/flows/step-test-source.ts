// "Test this step": one step of a Flow tried against a past run's recorded inputs (or sample values), changing and sending nothing (flows.step.test). Over an injected `call`.
export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;
export type StepTest = { ok: boolean; step?: string; input?: unknown; output?: unknown; effects?: { action?: string; resource?: string; outward?: boolean; would?: string }[]; asks?: unknown[]; tasks?: unknown[]; error?: { code?: string; message?: string } | string };

export const stepTestSource = (call: Call) => ({
  /** Try `step` of `flow` (a stored Flow's id, or an unsaved definition). `run` names the past run whose recorded inputs it reads; without one, `sample` stands in for the trigger. A refusal gives its own words. */
  async test(flow: string | Record<string, unknown>, step: string, o: { run?: string; sample?: Record<string, unknown> } = {}): Promise<{ result: StepTest } | { problem: string }> {
    const r = await call<StepTest>("flows.step.test", { flow, step, ...(o.run ? { run: o.run } : { sample: o.sample ?? {} }) });
    return r.error ? { problem: r.error.message } : { result: r.data ?? { ok: false } };
  },
});
