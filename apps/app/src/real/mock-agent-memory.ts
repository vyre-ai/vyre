// The agent page's Memory pane answered from memory, for the sample build (EXPO_PUBLIC_VYRE_MOCK=1) only: what an Intake agent has written, and the corrections passed on from its chats. The shapes are core/memory's (memory.writes, memory.corrections).
const D = 86_400_000;
const at = (d: number) => Date.now() - d * D;
const write = (id: string, kind: string, text: string, d: number, from: any, projects: any[] = [{ project: "juniper", state: "live", at: at(d) }]) => ({ id, kind, text, subject: null, source_ref: null, from: { kind: "agent", name: "intake", provider: null, thread: null, seq: null, ...from }, untrusted: false, state: "live", at: at(d), projects });
let writes: any[] = [
  write("mw_1", "correction", "an agent reports the person corrected: the studio's front desk closes at 5 pm, not 6 pm", 1, { thread: "thr_intake_1", seq: 4 }),
  write("mw_2", "decision", "Use the long intake form for estate plans and the short one for everything else", 3, { thread: "thr_intake_2", seq: 9 }),
  write("mw_3", "fact", "Dana Reyes prefers email over calls", 6, { thread: "thr_intake_3", seq: 2 }),
  write("mw_4", "correction", "an agent reports the person corrected: sign every first reply with Dana's name, not the studio's", 9, { thread: "thr_intake_4", seq: 7 }),
];
export const mockAgentMemoryTools: Record<string, (i: any) => unknown> = {
  "memory.writes": () => ({ writes: writes.filter((x) => x.state === "live") }),
  "memory.corrections": () => ({ suggestions: [], heard: [{ thread: "thr_intake_5", seq: 3, at: at(12), by: "mcp:agent:intake", summary: "Marcus Hale moved to Reno", undo: { tool: "memory.uncorrect", input: { fix: 3 } } }] }),
  "memory.write.forget": (i) => { writes = writes.filter((x) => x.id !== i.id); return { id: i.id, state: "forgotten", changed: [], projects: [] }; },
  "memory.uncorrect": () => ({ ok: true }),
};
