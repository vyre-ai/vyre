// Flow chats: one chat per Flow, each wake (one agent step run) a thread inside it, shown in one scroll oldest to newest with a divider per wake. Pure: the screens only draw what this returns.
// The thread's origin names are read in ONE place (markerOf) so the names agent-wake settles on change one function.
import { threadStatus } from "../../../../lib/thread-status.js";

export type Marker = { flow: string; run: string; step: string; task?: string; record?: string; flowName?: string; stepName?: string; runNo?: string; recordName?: string; approver?: string };
export type WakeState = "running" | "waiting" | "done" | "failed" | "paused";
export type Section = {
  thread: string; run: string; step: string; at: number; state: WakeState; needsYou: boolean; marker: Marker;
  /** "Run 42 · Refund for Jane Doe · Step 2, refunds agent · 10:14 · Done" */
  divider: string;
  collapsed: boolean;
};
export type FlowChat = { id: string; title: string; flowName: string; sections: Section[]; runs: number; last: number; lastState: WakeState; needsYou: number };

const s = (v: unknown): string => (typeof v === "string" ? v : "");
const STATE: Record<WakeState, string> = { running: "Running", waiting: "Waiting on you", done: "Done", failed: "Failed", paused: "Paused" };

/** The Flow origin of a thread row, or null when the thread was not started by a Flow step. */
export function markerOf(row: any): Marker | null {
  const o = row && typeof row.origin === "object" && row.origin ? row.origin : row && typeof row.wake === "object" ? row.wake : null;
  if (!o || !s(o.flow) || !s(o.run)) return null;
  return { flow: s(o.flow), run: s(o.run), step: s(o.step), ...(s(o.task) ? { task: s(o.task) } : {}), ...(s(o.record) ? { record: s(o.record) } : {}),
    ...(s(o.flow_name) ? { flowName: s(o.flow_name) } : {}), ...(s(o.step_name) ? { stepName: s(o.step_name) } : {}), ...(s(o.run_no) ? { runNo: s(o.run_no) } : {}), ...(s(o.record_name) ? { recordName: s(o.record_name) } : {}), ...(s(o.approver) ? { approver: s(o.approver) } : {}) };
}

export function stateOf(row: any): WakeState {
  const canon = s(row?.canonical_status) || threadStatus(s(row?.status) || "idle", s(row?.stopped_reason) || null);
  if ((typeof row?.asks === "number" && row.asks > 0) || canon === "asking") return "waiting";
  return canon === "failed" ? "failed" : canon === "starting" || canon === "working" ? "running" : canon === "paused" || canon === "stopped" ? "paused" : "done";
}

const clock = (at: number, zone?: string) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, ...(zone ? { timeZone: zone } : {}) });
/** A short run label: its number when the box gives one, else the id's tail. */
const runLabel = (m: Marker) => `Run ${m.runNo || m.run.replace(/^run[_-]?/, "").slice(-6)}`;

export function dividerOf(m: Marker, state: WakeState, at: number, zone?: string): string {
  return [runLabel(m), m.recordName, m.step ? `Step ${m.stepName ? `${m.step}, ${m.stepName}` : m.step}` : "", clock(at, zone), STATE[state]].filter(Boolean).join(" · ");
}

/** What the thread screen says above a wake: where it came from, whose access it runs with, and the run to open. */
export function wakeHeader(m: Marker): { where: string; access: string | null; openRun: string } {
  return { where: `Flow ${m.flowName || m.flow}, ${runLabel(m).toLowerCase()}, step ${m.stepName || m.step}`, access: m.approver ? `Runs with ${m.approver}'s access` : null, openRun: `/u/flows/${encodeURIComponent(m.flow)}/runs/${encodeURIComponent(m.run)}` };
}

/** Flow chats from threads.list rows: wakes grouped by Flow, oldest to newest, older runs collapsed (the newest wake and any waiting on you stay open). */
export function flowChats(list: unknown, o: { zone?: string; open?: ReadonlySet<string>; shut?: ReadonlySet<string> } = {}): FlowChat[] {
  if (!Array.isArray(list)) return [];
  const by = new Map<string, { m: Marker; row: any }[]>();
  for (const row of list) {
    const m = markerOf(row);
    if (!m || !s(row.id) || row.archived) continue;
    by.set(m.flow, [...(by.get(m.flow) ?? []), { m, row }]);
  }
  const out: FlowChat[] = [];
  for (const [flow, ws] of by) {
    ws.sort((a, b) => (a.row.started ?? a.row.last ?? 0) - (b.row.started ?? b.row.last ?? 0));
    const newest = ws[ws.length - 1];
    const sections: Section[] = ws.map(({ m, row }) => {
      const state = stateOf(row), at = Number(row.started ?? row.last ?? 0);
      const id = s(row.id);
      const def = !(row === newest.row || state === "waiting" || state === "running");
      return { thread: id, run: m.run, step: m.step, at, state, needsYou: state === "waiting", marker: m, divider: dividerOf(m, state, at, o.zone), collapsed: o.open?.has(id) ? false : o.shut?.has(id) ? true : def };
    });
    const flowName = ws.map((w) => w.m.flowName).filter(Boolean).pop() || flow;
    const named = [...ws].reverse().map((w) => s(w.row.name)).find((n) => n.startsWith("Flow:"));
    out.push({ id: flow, flowName, title: named || `Flow: ${newest.m.stepName || newest.m.step || "step"} - ${flowName}`, sections, runs: new Set(ws.map((w) => w.m.run)).size, last: Math.max(...ws.map((w) => Number(w.row.last ?? 0))), lastState: sections[sections.length - 1].state, needsYou: sections.filter((x) => x.needsYou).length });
  }
  return out.sort((a, b) => b.last - a.last);
}

/** The line under a Flow chat's title in the list. */
export function flowChatSub(c: FlowChat, now: number): string {
  const ago = (() => { const m = Math.max(0, Math.round((now - c.last) / 60000)); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; })();
  return [`${c.runs} ${c.runs === 1 ? "run" : "runs"}`, `Last: ${STATE[c.lastState].toLowerCase()}`, ago].join(" · ");
}

/** The reply composer's target: the agent in general, or one run when "Reply to this run" was pressed on its divider. */
export function replyTarget(chat: FlowChat, section: Section | null): { thread: string | null; label: string } {
  return section ? { thread: section.thread, label: `Replying to ${section.divider.split(" · ").slice(0, 2).join(" · ")}` } : { thread: null, label: `Message the agent in ${chat.flowName}` };
}

/** The main Chat list keeps a thread only when it is not a Flow wake, or when the wake waits on you. Everything else lives under the Flows filter. */
export function inMainList(row: any): boolean {
  return !markerOf(row) || stateOf(row) === "waiting";
}

/** The agent page's Work: the Flow chats this agent works in. */
export function flowChatsOf(list: unknown, agent: string, o = {}): FlowChat[] {
  return flowChats(Array.isArray(list) ? list.filter((r: any) => r && r.agent === agent) : [], o);
}
