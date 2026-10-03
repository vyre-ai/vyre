// A mock session stream, so the chat screen works with no server and the perf script has something
// to measure. It speaks the 0.3 frame (docs/work/chat.md): { v, id, cur, session, turn, type, time,
// corr, data } with gapless cursors, and plays one realistic turn: text deltas at about 40 tokens a
// second, a Bash tool with ANSI terminal output, an Edit with a diff, a record found, a queued user
// message picked up at the next safe point, a task that needs approval (the script waits for the
// answer), then a cited answer, a draft and a Flow change. Erasable types only (Node strips them).
// Same plug as the real client: `connect({ from, onFrame })` replays what the log holds after `from`,
// then goes live, so the screen cannot tell it from core/stream.

export type Frame = {
  v: 1; id: string; cur: number; session: string; turn: string; type: string; time: number; corr: string;
  /** performance.now() at emit; the perf script reads it. Not part of the wire frame. */
  t?: number; data: any;
};
export type StreamState = "connecting" | "live" | "offline";
export type StreamConnection = { close(): void };
export type ConnectOptions = { from: number; open?: boolean; onFrame: (f: Frame) => void; onState?: (s: StreamState) => void };
export type StreamSource = {
  connect(o: ConnectOptions): StreamConnection;
  /** Send a message. While the session is working it is queued, then picked up at the next safe point. */
  send(text: string): void;
  answer(ask: string, decision: "approve" | "deny"): void;
  stop(): void;
};

export type Step = { at: number; type: string; data: any };
export type Segment = { gate: string | null; steps: Step[] };

/** Tokens are about four characters. @param text @param tps */
export function tokens(text: string): string[] {
  return text.match(/[\s\S]{1,4}/g) ?? [];
}

class Clock {
  t = 0;
  steps: Step[] = [];
  at(ms: number) { this.t = Math.max(this.t, ms); return this; }
  push(type: string, data: any, wait = 0) { this.t += wait; this.steps.push({ at: Math.round(this.t), type, data }); return this; }
  /** Streaming text at `tps` tokens a second. */
  say(message: string, text: string, tps: number, gapBefore = 120) {
    this.t += gapBefore;
    const every = 1000 / tps;
    let i = 0;
    for (const tok of tokens(text)) { this.push("text-delta", { message, index: i++, text: tok }); this.t += every; }
    this.push("text-done", { message });
    return this;
  }
}

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

export const DIFF_DATE = [
  "@@ -12,9 +12,9 @@ export function validDay(y: number, m: number, d: number) {",
  "   if (m < 1 || m > 12) return false;",
  "-  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];",
  "-  return d >= 1 && d <= days[m - 1];",
  "+  const last = new Date(y, m, 0).getDate();",
  "+  return d >= 1 && d <= last;",
  " }",
].join("\n");

export const FILES_TREE = [
  { path: "CHANGELOG.md", op: "edit", add: 3, del: 0 },
  { path: "src/intake/date.ts", op: "edit", add: 2, del: 2 },
  { path: "src/intake/date.test.ts", op: "edit", add: 14, del: 1 },
  { path: "src/intake/form.tsx", op: "edit", add: 5, del: 4 },
  { path: "src/intake/errors.ts", op: "create", add: 22, del: 0 },
];

/** The turn, as timed steps in segments. A segment with a gate starts when that ask is answered. */
export function script(o: { tps?: number } = {}): Segment[] {
  const tps = o.tps ?? 40;
  const c = new Clock();
  c.push("status", { state: "working", turn: "turn-1" });
  c.push("user-message", { message: "m1", text: "Fix the failing date check in the intake form, then update the Northwind Bakery matter.", state: "sent" }, 40);
  c.say("a1", "I'll run the intake tests first to see exactly what fails.", tps, 200);
  c.push("tool-started", { tool_id: "tl1", tool: "Bash", kind: "terminal", summary: "npm test -- intake" }, 150);
  const lines = [
    dim("> intake@1.4.0 test"), dim("> node --test src/intake"),
    green("  ok  ") + "1 - rejects a month of 13", green("  ok  ") + "2 - accepts 30 April",
    red("  not ok  ") + "3 - accepts 29 February 2028", red("      expected true, got false  ") + dim("(date.test.ts:41)"),
    green("  ok  ") + "4 - rejects 31 June", red("fail 1") + "  pass 13  total 14",
  ];
  for (const l of lines) c.push("tool-progress", { tool_id: "tl1", text: l + "\n" }, 110);
  c.push("tool-finished", { tool_id: "tl1", ok: false, result: { block: "terminal", command: "npm test -- intake", output: lines.join("\n") + "\n", exit: 1 } }, 120);
  c.say("a2", "The check compares the day against a fixed month table, so it rejects 29 February. I'll use the real month length instead.", tps);
  c.push("tool-started", { tool_id: "tl2", tool: "Edit", kind: "file", summary: "src/intake/date.ts" }, 150);
  c.push("user-message", { message: "m2", text: "Also add a line to the changelog.", state: "queued", queued_at: 0 }, 160);
  c.push("tool-finished", { tool_id: "tl2", ok: true, result: { block: "diff", files: [{ path: "src/intake/date.ts", op: "edit", diff: DIFF_DATE }] } }, 380);
  c.push("user-message", { message: "m2", text: "Also add a line to the changelog.", state: "picked-up" }, 20);
  c.say("a3", "Adding the changelog line, then I'll run the tests again.", tps, 160);
  c.push("tool-started", { tool_id: "tl3", tool: "Edit", kind: "file", summary: "5 files" }, 150);
  c.push("tool-finished", { tool_id: "tl3", ok: true, result: { block: "files", files: FILES_TREE } }, 420);
  c.push("tool-started", { tool_id: "tl4", tool: "Bash", kind: "terminal", summary: "npm test -- intake" }, 150);
  const ok = [dim("> node --test src/intake"), green("  ok  ") + "3 - accepts 29 February 2028", green("pass 14") + "  fail 0  total 14"];
  for (const l of ok) c.push("tool-progress", { tool_id: "tl4", text: l + "\n" }, 120);
  c.push("tool-finished", { tool_id: "tl4", ok: true, result: { block: "terminal", command: "npm test -- intake", output: ok.join("\n") + "\n", exit: 0 } }, 100);
  c.push("tool-started", { tool_id: "tl5", tool: "records.find", kind: "record", summary: "Northwind Bakery" }, 200);
  c.push("tool-finished", {
    tool_id: "tl5", ok: true,
    result: {
      block: "record", urn: "urn:vyre:harlow:matter:nb-0042", type: "Matter", title: "Northwind Bakery, lease dispute",
      fields: [
        { label: "Stage", kind: "stage", value: "Demand sent" },
        { label: "Lead", kind: "text", value: "Alex Rivera" },
        { label: "Next date", kind: "date", value: "14 Oct 2026" },
        { label: "Tax ID", kind: "sealed", value: { sealed: "tax-id", present: true, valid_format: true } },
      ],
    },
  }, 300);
  c.say("a4", "I found the matter. A short status note to the client needs your approval before it goes out.", tps);
  c.push("ask", {
    ask_id: "k1", kind: "approval", title: "Send the status note to Northwind Bakery",
    task: { block: "task", id: "tk1", title: "Send the status note to Northwind Bakery", doer: "juno", state: "needs-approval", why: "It goes to an outside person, so it waits for you.", approve: { label: "Send with Face ID", face: true }, tags: ["Matter nb-0042", "Email"] },
  }, 150);
  c.push("status", { state: "asking", turn: "turn-1" }, 20);
  const first = c.steps;

  const d = new Clock();
  d.push("ask-answered", { ask_id: "k1", decision: "approve" });
  d.push("status", { state: "working", turn: "turn-1" }, 30);
  d.push("tool-started", { tool_id: "tl6", tool: "memory.search", kind: "answer", summary: "Northwind Bakery, last contact" }, 150);
  d.push("tool-finished", { tool_id: "tl6", ok: true, result: { block: "answer", text: "The last contact was a call with the owner on 2 October. She asked for a written timeline.", sources: [{ title: "Call note, 2 Oct", url: "urn:vyre:harlow:note:2210" }, { title: "Lease, section 4", url: "urn:vyre:harlow:file:lease" }] } }, 300);
  d.push("tool-started", { tool_id: "tl7", tool: "draft.email", kind: "draft", summary: "Status note" }, 150);
  d.push("tool-finished", { tool_id: "tl7", ok: true, result: { block: "draft", kind: "email", to: "owner@northwind.example", subject: "Where your lease matter stands", body: "Hello,\n\nThe demand letter went out on 2 October. The landlord has until 14 October to reply. I will write again that day either way." } }, 300);
  d.push("tool-started", { tool_id: "tl8", tool: "flow.propose", kind: "flow", summary: "Follow-up on 14 Oct" }, 150);
  d.push("tool-finished", { tool_id: "tl8", ok: true, result: { block: "flow-change", title: "Follow-up on the landlord's reply", steps: [{ op: "add", label: "Wait for 14 October" }, { op: "add", label: "Task: check for a reply, then call" }, { op: "change", label: "Stage: Demand sent to Response due" }] } }, 300);
  d.say("a5", "Sent. I added a follow-up for 14 October so the reply does not slip.", tps);
  d.push("status", { state: "waiting", turn: "turn-1" }, 60);
  return [{ gate: null, steps: first }, { gate: "k1", steps: d.steps }];
}

export type MockOptions = {
  session?: string;
  tps?: number;
  /** Fast-forward this many ms of the first segment at connect (shots). */
  startAt?: number;
  /** After the fast-forward, stay still (a frozen mid-turn view for shots). */
  hold?: boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  /** Frames the log holds before the script (a preloaded thread). */
  history?: Frame[];
};

export function createMockStream(opts: MockOptions = {}): StreamSource & { log: Frame[]; state(): string } {
  const session = opts.session ?? "demo";
  const now = opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const segments = script({ tps: opts.tps });
  const log: Frame[] = [...(opts.history ?? [])];
  let cur = log.length ? log[log.length - 1].cur : 0;
  const listeners = new Set<(f: Frame) => void>();
  let timers: unknown[] = [];
  let state = "starting";
  let turn = "turn-1";
  let started = false;
  let stopped = false;
  const queued: { message: string; text: string }[] = [];
  let nextMsg = 100;

  function emit(type: string, data: any) {
    const f: Frame = { v: 1, id: `${session}-${cur + 1}`, cur: ++cur, session, turn, type: `session.${type}`, time: Date.now(), corr: turn, t: now(), data };
    if (type === "status") state = data.state;
    log.push(f);
    for (const l of [...listeners]) l(f);
    // A safe point: a tool just finished. Queued messages are picked up here, never mid-tool.
    if (type === "tool-finished") flush();
    return f;
  }
  function flush() {
    while (queued.length) {
      const q = queued.shift()!;
      if (q.message === "m2") continue; // the script's own picked-up step says it
      emit("user-message", { message: q.message, text: q.text, state: "picked-up" });
    }
  }
  function schedule(steps: Step[], from: number, done?: () => void) {
    for (const s of steps) {
      if (s.at <= from) continue;
      timers.push(setTimer(() => { if (!stopped) run(s); }, s.at - from));
    }
    const end = steps.length ? steps[steps.length - 1].at : 0;
    if (done) timers.push(setTimer(done, Math.max(0, end - from) + 1));
  }
  function run(s: Step) {
    if (s.type === "user-message" && s.data.state === "queued") queued.push({ message: s.data.message, text: s.data.text });
    emit(s.type, s.data);
  }
  function begin() {
    if (started) return;
    started = true;
    const ff = opts.startAt ?? 0;
    const first = segments[0].steps;
    for (const s of first) if (s.at <= ff) run(s);
    if (!opts.hold) schedule(first, ff);
  }
  return {
    log,
    state: () => state,
    connect({ from, onFrame, onState }) {
      for (const f of log) if (f.cur > from) onFrame(f);
      listeners.add(onFrame);
      onState?.("live");
      begin();
      return { close() { listeners.delete(onFrame); } };
    },
    send(text) {
      const message = `m${nextMsg++}`;
      if (state === "working" || state === "asking" || state === "starting") {
        queued.push({ message, text });
        emit("user-message", { message, text, state: "queued", queued_at: Date.now() });
        return;
      }
      emit("user-message", { message, text, state: "sent" });
      turn = `turn-${nextMsg}`;
      emit("status", { state: "working", turn });
      const reply = `Noted: ${text.slice(0, 60)}. This is the mock session, so nothing else happens.`;
      const c = new Clock();
      c.say(`a${nextMsg}`, reply, opts.tps ?? 40, 150);
      c.push("status", { state: "waiting", turn }, 60);
      schedule(c.steps, 0);
    },
    answer(ask, decision) {
      const next = segments.find((s) => s.gate === ask);
      if (!next || state !== "asking") return;
      const steps = decision === "approve" ? next.steps : [{ at: 0, type: "ask-answered", data: { ask_id: ask, decision: "deny" } }, { at: 40, type: "status", data: { state: "waiting", turn } }];
      for (const s of steps) if (s.at <= 0) run(s);
      schedule(steps, 0);
    },
    stop() {
      stopped = true;
      for (const h of timers) clearTimer(h);
      timers = [];
      emit("status", { state: "stopped", turn, stopping: false });
    },
  };
}

/** A thread of `n` messages (user, reply and tool results mixed) as frames, for the 10,000-message mode. */
export function historyFrames(n: number, session = "demo"): Frame[] {
  const out: Frame[] = [];
  let cur = 0;
  const f = (type: string, data: any): Frame => ({ v: 1, id: `${session}-h${cur + 1}`, cur: ++cur, session, turn: "turn-h", type: `session.${type}`, time: 0, corr: "turn-h", data });
  let msg = 0;
  while (msg < n) {
    const k = msg % 8;
    const id = `h${msg}`;
    if (k === 0) out.push(f("user-message", { message: id, text: `Message ${msg}: look at the intake form for Harlow Legal and tell me what is left.`, state: "sent" }));
    else if (k === 3) {
      out.push(f("tool-started", { tool_id: id, tool: "Bash", kind: "terminal", summary: "npm test" }));
      out.push(f("tool-finished", { tool_id: id, ok: true, result: { block: "terminal", command: "npm test", output: `${green("pass")} 14  fail 0\n`, exit: 0 } }));
    } else if (k === 6) {
      out.push(f("tool-started", { tool_id: id, tool: "Edit", kind: "file", summary: "src/intake/date.ts" }));
      out.push(f("tool-finished", { tool_id: id, ok: true, result: { block: "diff", files: [{ path: "src/intake/date.ts", op: "edit", diff: DIFF_DATE }] } }));
    } else {
      out.push(f("text-delta", { message: id, index: 0, text: `Reply ${msg}: the form checks the dates and the list of parties. Two fields still need a rule, and the rest are done and covered by tests.` }));
      out.push(f("text-done", { message: id }));
    }
    msg++;
  }
  out.push(f("status", { state: "waiting", turn: "turn-h" }));
  return out;
}
