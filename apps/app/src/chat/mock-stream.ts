// A mock session stream, so the chat screen works with no server and the perf script has something
// to measure. It speaks the 0.3 frame (team/archive/work-journals/chat.md): { v, id, cur, session, turn, type, time,
// corr, data } with gapless cursors, and plays one realistic turn: text deltas at about 40 tokens a
// second, a Bash tool with ANSI terminal output, an Edit with a diff, a record found, a queued user
// message picked up at the next safe point, a task that needs approval (the script waits for the
// answer), then a cited answer, a draft and a Flow change. Erasable types only (Node strips them).
// Same plug as the real client: `connect({ from, onFrame })` replays what the log holds after `from`,
// then goes live, so the screen cannot tell it from core/stream.

import { typeOf } from "./frame-type.js";

export type Frame = {
  v: 1; id: string; cur: number; session: string; turn: string; type: string; time: number; corr: string;
  /** performance.now() at emit; the perf script reads it. Not part of the wire frame. */
  t?: number; data: any;
  /** Group chats (task H): who wrote it, for whom, and which message. See group.js. */
  author?: string; acts_for?: string; message?: string;
  /** "assistant" when the person's assistant did it for them. */
  via?: string;
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
  /** Group chats: send to chosen assistants (two or more make a fan-out), keep a fan-out answer, react, pin, mark read. */
  sendGroup?(text: string, o: { to: string[]; fanout: boolean; parent?: string; replyTo?: string }): void;
  /** The log's head when the box last opened the stream: frames up to it are history, shown at once. */
  head?(): number;
  /** Who the box says is looking ("person:owner"), once it has said. */
  viewer?(): string | undefined;
  keep?(group: string, message: string): void;
  react?(message: string, emoji: string, remove?: boolean): void;
  pin?(message: string, pinned: boolean): void;
  markRead?(upto: number): void;
};

export type Step = { at: number; type: string; data: any; top?: Record<string, any> };
export type Segment = { gate: string | null; steps: Step[] };

/** Tokens are about four characters. @param text @param tps */
export function tokens(text: string): string[] {
  return text.match(/[\s\S]{1,4}/g) ?? [];
}

class Clock {
  t = 0;
  steps: Step[] = [];
  at(ms: number) { this.t = Math.max(this.t, ms); return this; }
  push(type: string, data: any, wait = 0, top?: Record<string, any>) { this.t += wait; this.steps.push({ at: Math.round(this.t), type, data, ...(top ? { top } : {}) }); return this; }
  /** Streaming text at `tps` tokens a second. `top` is the frame's author, acts_for and message (group chats). */
  say(message: string, text: string, tps: number, gapBefore = 120, top?: Record<string, any>, extra?: Record<string, any>) {
    this.t += gapBefore;
    const every = 1000 / tps;
    let i = 0;
    for (const tok of tokens(text)) { this.push("text-delta", { message, index: i++, text: tok, ...extra }, 0, top); this.t += every; }
    this.push("text-done", { message }, 0, top);
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
      block: "record", urn: "urn:vyre:juniper:matter:nb-0042", type: "Matter", title: "Northwind Bakery, lease dispute",
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
  d.push("tool-finished", { tool_id: "tl6", ok: true, result: { block: "answer", text: "The last contact was a call with the owner on 2 October. She asked for a written timeline.", sources: [{ title: "Call note, 2 Oct", url: "urn:vyre:juniper:note:2210" }, { title: "Lease, section 4", url: "urn:vyre:juniper:file:lease" }] } }, 300);
  d.push("tool-started", { tool_id: "tl7", tool: "draft.email", kind: "draft", summary: "Status note" }, 150);
  d.push("tool-finished", { tool_id: "tl7", ok: true, result: { block: "draft", kind: "email", to: "owner@northwind.example", subject: "Where your lease matter stands", body: "Hello,\n\nThe demand letter went out on 2 October. The landlord has until 14 October to reply. I will write again that day either way." } }, 300);
  d.push("tool-started", { tool_id: "tl8", tool: "flow.propose", kind: "flow", summary: "Follow-up on 14 Oct" }, 150);
  d.push("tool-finished", { tool_id: "tl8", ok: true, result: { block: "flow-change", title: "Follow-up on the landlord's reply", steps: [{ op: "add", label: "Wait for 14 October" }, { op: "add", label: "Task: check for a reply, then call" }, { op: "change", label: "Stage: Demand sent to Response due" }] } }, 300);
  d.say("a5", "Sent. I added a follow-up for 14 October so the reply does not slip.", tps);
  d.push("status", { state: "waiting", turn: "turn-1" }, 60);
  return [{ gate: null, steps: first }, { gate: "k1", steps: d.steps }];
}

const VIEWER = "person:alex";

/**
 * The group scenario (/chat-demo?scenario=group): alex (the viewer) and chris in a chat with two
 * assistants, kit (asked by chris) and juno (asked by alex), who stream at the same moment; an
 * approval that is chris's, not alex's; a reaction, a pin and a thread reply; then alex asks three
 * models at once and the answers arrive as a set, one of them cut short. The viewer's read marker
 * sits after chris's first message, so what follows is "New".
 */
export function groupScript(o: { tps?: number } = {}): Segment[] {
  const tps = o.tps ?? 30;
  const kit = { author: "assistant:kit", acts_for: "person:chris" };
  const juno = { author: "assistant:juno", acts_for: VIEWER };
  const chris = { author: "person:chris" };
  const alex = { author: VIEWER };

  const a = new Clock();
  a.push("status", { state: "working", turn: "turn-g" });
  for (const [who, name, role] of [[VIEWER, "alex", "You"], ["person:chris", "chris", "Associate"], ["assistant:kit", "kit", "Engineer"], ["assistant:juno", "juno", "Your assistant"]]) a.push("participant-joined", { who, name, role }, 5);
  a.push("user-message", { message: "m1", text: "@alex can you look at the Northwind lease before the 3 pm call? @kit run the intake tests, @juno draft the note to the owner.", state: "sent" }, 40, { ...chris, message: "m1" });
  a.push("mention", { who: VIEWER }, 5, { message: "m1" });
  a.push("pin", {}, 5, { ...chris, message: "m1" });
  a.push("read-marker", { upto: "@m1" }, 20, alex);
  a.push("presence", { who: "assistant:kit", state: "doing", doing: "running the tests" }, 80);
  a.push("presence", { who: "assistant:juno", state: "doing", doing: "drafting the note" }, 5);

  // Two assistants stream at once; each keeps its own message.
  const k = new Clock().at(a.t);
  k.say("k1", "Running the intake tests. Two of the fourteen failed on the first pass, both on 29 February. The check uses a fixed month table, so I am switching it to the real month length and running them again.", tps, 250, { ...kit, message: "k1" });
  // A terminal block in a room of more than one person says so under itself (the server sets the note when the room has more than one person).
  k.push("tool-started", { tool_id: "gt1", tool: "Bash", kind: "terminal", summary: "npm test -- intake" }, 100, { ...kit });
  k.push("tool-finished", { tool_id: "gt1", ok: true, result: { block: "terminal", command: "npm test -- intake", output: "pass 14  fail 0\n", exit: 0, note: "visible to everyone in this chat" } }, 300, { ...kit });
  k.push("presence", { who: "assistant:kit", state: "idle" }, 40);
  const j = new Clock().at(a.t);
  j.say("j1", "Draft for the owner: the demand letter went out on 2 October and the landlord has until 14 October to reply. I will write again that day either way, and you can call before then if you prefer.", tps, 300, { ...juno, message: "j1" });
  j.push("presence", { who: "assistant:juno", state: "idle" }, 40);

  // After kit finishes: an approval that is chris's, a reaction, a thread reply.
  const kEnd = k.t;
  const b = new Clock().at(kEnd);
  b.push("ask", { ask_id: "g1", kind: "approval", title: "Send the fixed branch to review", task: { block: "task", id: "tg1", title: "Send the fixed branch to review", doer: "kit", state: "needs-approval", why: "It goes to the reviewer, so it waits for the person who asked.", approve: { label: "Send to review" }, tags: ["intake-form"] } }, 200, { ...kit });
  b.push("reaction", { emoji: "\u{1F44D}" }, 300, { ...alex, message: "k1" });
  b.push("reaction", { emoji: "\u{1F440}" }, 100, { ...chris, message: "j1" });
  b.push("user-message", { message: "m3", text: "Can kit also cover the leap year in the form test?", state: "sent" }, 400, { ...alex, message: "m3" });
  b.push("thread-reply", { parent: "k1" }, 5, { ...alex, message: "m3" });
  b.push("participant-joined", { who: "person:dana", name: "dana", role: "Paralegal" }, 600);

  // Alex asks three models at once. They stream together; the local one is cut short.
  const f = new Clock().at(Math.max(j.t, b.t) + 800);
  f.push("user-message", { message: "m5", text: "One line each: what is the biggest risk in the Northwind lease?", state: "sent" }, 0, { ...alex, message: "m5" });
  f.push("fanout", { group: "f1", message: "m5", members: [{ message: "f1a", author: "model:sonnet" }, { message: "f1b", author: "model:opus" }, { message: "f1c", author: "model:local" }] }, 40);
  const t0 = f.t;
  const fa = new Clock().at(t0).say("f1a", "The landlord can end the lease on 60 days notice with no cause, so the bakery has no fixed term to rely on. Ask for 24 months with a renewal right.", tps * 1.3, 120, { author: "model:sonnet", message: "f1a" });
  const fb = new Clock().at(t0).say("f1b", "Section 4 lets the landlord pass on any tax increase without a cap. That is the cost that can grow unseen, so ask for a cap tied to the first year.", tps * 1.1, 160, { author: "model:opus", message: "f1b" });
  const fc = new Clock().at(t0).say("f1c", "The lease has no repair duty for the landlord. Check the roof and the oven vent before", tps * 1.6, 100, { author: "model:local", message: "f1c" });
  fc.push("text-cut", { note: "Stopped at this model's reply limit" }, 0, { message: "f1c" });
  const g = new Clock().at(Math.max(fa.t, fb.t, fc.t) + 100);
  g.push("status", { state: "waiting", turn: "turn-g" }, 0);

  const all = [a, k, j, b, f, fa, fb, fc, g].flatMap((c) => c.steps).sort((x, y) => x.at - y.at);
  // The read marker names the cursor of a message; the first frame of m1 is its place in the log.
  const idx = (m: string) => all.findIndex((s) => (s.top?.message ?? s.data.message) === m && (s.type === "user-message" || s.type === "text-delta")) + 1;
  for (const s of all) if (s.type === "read-marker" && typeof s.data.upto === "string") s.data = { upto: idx(s.data.upto.slice(1)) };
  return [{ gate: null, steps: all }];
}

/**
 * The three-model chat of the sample world (CONTRACT-one-chat.md section 4): alex asks one question and kit on Claude, kit on Codex and a Grok model answer at once, each frame carrying its provider; alex
 * keeps one answer.
 */
export function modelsScript(o: { tps?: number } = {}): Segment[] {
  const tps = o.tps ?? 30;
  const alex = { author: VIEWER };
  const slots = [
    { id: "agent:kit", name: "kit on Claude", provider: "claude", message: "q1a", text: "Section 4 lets the landlord pass on any tax increase without a cap. Ask for a cap tied to the first year." },
    { id: "model:codex/gpt-5#1", name: "kit on Codex", provider: "codex", message: "q1b", text: "The lease has no repair duty for the landlord. Check the roof and the oven vent before you sign." },
    { id: "model:grok/grok-4#1", name: "Grok", provider: "grok", message: "q1c", text: "Sixty days notice with no cause is the exposure: the bakery has no fixed term to rely on." },
  ];
  const a = new Clock();
  a.push("status", { state: "working", turn: "turn-m" });
  a.push("participant-joined", { who: VIEWER, name: "alex", role: "You" }, 5);
  for (const sl of slots) a.push("participant-joined", { who: sl.id, name: sl.name, role: sl.provider }, 5);
  a.push("user-message", { message: "m1", text: "One line each: what is the biggest risk in the Northwind lease?", state: "sent" }, 40, { ...alex, message: "m1" });
  a.push("fanout", { group: "f1", message: "m1", members: slots.map((sl) => ({ message: sl.message, author: sl.id })) }, 40);
  const t0 = a.t;
  const clocks = slots.map((sl, i) => new Clock().at(t0).say(sl.message, sl.text, tps * (1.4 - i * 0.2), 120 + i * 40, { author: sl.id, message: sl.message }, { provider: sl.provider }));
  const end = new Clock().at(Math.max(...clocks.map((c) => c.t)) + 200);
  end.push("status", { state: "waiting", turn: "turn-m" }, 0);
  end.push("fanout-keep", { group: "f1", keep: "q1a" }, 600, { ...alex });
  return [{ gate: null, steps: [a, ...clocks, end].flatMap((c) => c.steps).sort((x, y) => x.at - y.at) }];
}

/** The people-only chat of the sample world: alex and Sam, no assistant, so nobody answers unless someone is asked. */
export function peopleScript(o: { tps?: number } = {}): Segment[] {
  const tps = o.tps ?? 30;
  const sam = { author: "person:sam" };
  const a = new Clock();
  a.push("status", { state: "waiting", turn: "turn-p" });
  a.push("participant-joined", { who: VIEWER, name: "alex", role: "You" }, 5);
  a.push("participant-joined", { who: "person:sam", name: "Sam", role: "Associate" }, 5);
  a.push("user-message", { message: "p1", text: "Did the intake form come through for the Okafor estate?", state: "sent" }, 40, { author: VIEWER, message: "p1" });
  const s = new Clock().at(a.t);
  s.say("p2", "Yes, this morning. I will call them Monday to book the first meeting.", tps, 600, { ...sam, message: "p2" });
  return [{ gate: null, steps: [a, s].flatMap((c) => c.steps).sort((x, y) => x.at - y.at) }];
}

/**
 * A chat where the person's assistant acted for them (CONTRACT-one-chat.md section 5): the message is the person's, with `via: "assistant"`, so it reads "(Sent by Vyre Assistant)". The assistant holds no seat:
 * kit, a space agent, answers as itself, acting for the person.
 */
export function assistantScript(o: { tps?: number } = {}): Segment[] {
  const tps = o.tps ?? 30;
  const kit = { author: "agent:kit", acts_for: VIEWER };
  const a = new Clock();
  a.push("status", { state: "working", turn: "turn-a" });
  a.push("participant-joined", { who: VIEWER, name: "alex", role: "You" }, 5);
  a.push("participant-joined", { who: "agent:kit", name: "kit", role: "Engineer" }, 5);
  a.push("user-message", { message: "s1", text: "@kit please run the intake tests before the 3 pm call and tell me what fails.", state: "sent" }, 40, { author: VIEWER, via: "assistant", message: "s1" });
  const k = new Clock().at(a.t);
  k.say("s2", "Ran them: 14 pass, none fail. The leap-year case you flagged is covered now.", tps, 400, { ...kit, message: "s2" }, { provider: "claude" });
  return [{ gate: null, steps: [a, k].flatMap((c) => c.steps).sort((x, y) => x.at - y.at) }];
}

/** The previews scenario (/chat-demo?scenario=previews): the assistant starts something on a port and a live preview card lands in the chat, between two of its own messages. */
export function previewsScript(o: { tps?: number } = {}): Segment[] {
  const tps = o.tps ?? 80;
  const c = new Clock();
  c.push("status", { state: "working", turn: "turn-1" });
  c.push("user-message", { message: "m1", text: "Build me a small intake form I can show Maria this afternoon, and let me look at it.", state: "sent" }, 40);
  c.say("a1", "I built the form with the three questions you listed and started it on a port. It validates the date and keeps nothing until you press send.", tps, 200);
  c.push("tool-started", { tool_id: "e1", tool: "Edit", summary: "Edit form.html" }, 120);
  c.push("tool-finished", { tool_id: "e1", ok: true, result: { block: "diff", path: "form.html", hunks: [{ del: "<input name=\"date\">", add: "<input name=\"date\" type=\"date\" required>" }] } }, 300);
  c.push("tool-started", { tool_id: "e2", tool: "Edit", summary: "Edit form.css" }, 100);
  c.push("tool-finished", { tool_id: "e2", ok: true, result: { block: "diff", path: "form.css", hunks: [{ del: "gap: 8px;", add: "gap: 12px;" }] } }, 300);
  c.push("tool-started", { tool_id: "c1", tool: "Bash", kind: "terminal", summary: "Start the form on a port" }, 100);
  c.push("tool-finished", { tool_id: "c1", ok: true, result: { block: "terminal", command: "node serve.js", output: "listening on 5173", exit: 0, running: false } }, 300);
  c.push("tool-finished", { tool_id: "preview:0a1b2c3d", ok: true, result: { block: "preview", id: "0a1b2c3d", title: "Intake form", state: "live", source: "port", mode: "session", access: "me", thumb: 1 } }, 300);
  c.say("a2", "It ends with this chat. If you want it there tomorrow, tap Keep it running and I will leave it to Vyre.", tps, 200);
  c.push("status", { state: "waiting", turn: "turn-1" }, 60);
  return [{ gate: null, steps: c.steps }];
}

/** The activity scenario (/chat-demo?scenario=activity): a thought, a step, a hand-off to a teammate with the teammate's own steps nested under it, the report-back, the reply. */
export function activityScript(o: { tps?: number } = {}): Segment[] {
  const tps = o.tps ?? 60;
  const c = new Clock();
  const juno = { author: "assistant:juno" };
  const to = { agent: "kit-billing", role: "billing", name: "kit", project: "Northwind Bakery" };
  c.push("status", { state: "working", turn: "turn-1" });
  c.push("user-message", { message: "m1", text: "Chase the overdue invoices, and tell me what Northwind owes.", state: "sent" }, 40);
  c.say("a1", "Three invoices are over thirty days. Billing should chase them; I will look at Northwind first.", tps, 200, undefined, { reasoning: true, index: 0 });
  c.push("tool-started", { tool_id: "t1", tool: "records.search", summary: "Looking up overdue invoices" }, 150);
  c.push("tool-finished", { tool_id: "t1", ok: true }, 400);
  c.push("handoff", { request: "r_1", to, text: "Chase the overdue invoices this week", state: "queued", at: 1 }, 150, juno);
  c.push("handoff", { request: "r_1", to, text: "Chase the overdue invoices this week", state: "running", thread: "ses_kit", at: 2 }, 300, juno);
  c.push("tool-started", { tool_id: "k1", tool: "mail.draft", summary: "Drafting three reminders", via: "r_1" }, 300, { author: "assistant:kit-billing" });
  c.push("tool-finished", { tool_id: "k1", ok: true, via: "r_1" }, 500, { author: "assistant:kit-billing" });
  c.push("tool-started", { tool_id: "k2", tool: "records.log", summary: "Logging each on its client", via: "r_1" }, 200, { author: "assistant:kit-billing" });
  c.push("tool-finished", { tool_id: "k2", ok: true, via: "r_1" }, 500, { author: "assistant:kit-billing" });
  c.push("handoff", { request: "r_1", to, text: "Chase the overdue invoices this week", state: "done", thread: "ses_kit", result: "Three reminders drafted for Northwind, Oakline and Brightwell. Each waits for your yes.", at: 3 }, 200, juno);
  c.say("a2", "Kit drafted three reminders. Northwind owes $4,200 across two invoices.", tps, 200);
  c.push("status", { state: "waiting", turn: "turn-1" }, 60);
  return [{ gate: null, steps: c.steps }];
}

/** The markdown scenario (/chat-demo?scenario=markdown): one reply that uses every mark the chat draws (headings, bold, italic, lists, a link, inline code, a quote, a table, a code block), to look at. */
export function markdownScript(o: { tps?: number } = {}): Segment[] {
  const tps = o.tps ?? 400;
  const c = new Clock();
  c.push("status", { state: "working", turn: "turn-1" });
  c.push("user-message", { message: "m1", text: "Why does the intake form reject 29 February, and what should the check look like?", state: "sent" }, 40);
  c.say("a1", [
    "## The short answer", "",
    "The check compares the day against a **fixed month table**, so it rejects 29 February in a *leap year*. Use the real month length instead:", "",
    "```ts", "function validDay(year: number, month: number, day: number): boolean {", "  const days = new Date(year, month + 1, 0).getDate(); // 29 in Feb 2028", "  return Number.isInteger(day) && day >= 1 && day <= days;", "}", "```", "",
    "Three things change:", "", "1. the month table is deleted", "2. the leap-year rule comes from `Date`", "3. the test adds two cases:", "   - 29 February 2028 passes", "   - 29 February 2027 fails", "",
    "> A date check should never carry its own calendar.", "",
    "| File | Change |", "|:--|--:|", "| `src/intake/date.ts` | 6 lines |", "| `src/intake/date.test.ts` | 12 lines |", "",
    "The full history is in the [intake notes](https://example.com/intake).",
  ].join("\n"), tps, 200);
  c.push("status", { state: "waiting", turn: "turn-1" }, 60);
  return [{ gate: null, steps: c.steps }];
}

/** The steps scenario (/chat-demo?scenario=steps): a turn of many steps in a row, then the reply, to look at the folded run. */
export function stepsScript(o: { tps?: number } = {}): Segment[] {
  const tps = o.tps ?? 60;
  const c = new Clock();
  c.push("status", { state: "working", turn: "turn-1" });
  c.push("user-message", { message: "m1", text: "Find out why the intake form rejects 29 February and fix it.", state: "sent" }, 40);
  c.say("a1", "I'll look at the form first.", tps, 200);
  const steps = ["Reading the intake form", "Searching for the month table", "Reading date.ts", "Editing date.ts", "Running the intake tests"];
  steps.forEach((summary, i) => {
    c.push("tool-started", { tool_id: `s${i}`, tool: ["files.read", "files.search", "files.read", "files.edit", "shell.run"][i], summary }, 300);
    c.push("tool-finished", { tool_id: `s${i}`, ok: true }, 450);
  });
  c.say("a2", "Fixed: the check now uses the real month length, and all fourteen tests pass.", tps, 200);
  c.push("status", { state: "waiting", turn: "turn-1" }, 60);
  return [{ gate: null, steps: c.steps }];
}

export type MockOptions = {
  /** "group": two people, two assistants, a fan-out (groupScript). */
  scenario?: "group" | "models" | "people" | "assistant" | "activity" | "previews" | "markdown" | "steps";
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
  const segments = opts.scenario === "steps" ? stepsScript({ tps: opts.tps }) : opts.scenario === "markdown" ? markdownScript({ tps: opts.tps }) : opts.scenario === "previews" ? previewsScript({ tps: opts.tps }) : opts.scenario === "group" ? groupScript({ tps: opts.tps }) : opts.scenario === "models" ? modelsScript({ tps: opts.tps }) : opts.scenario === "people" ? peopleScript({ tps: opts.tps }) : opts.scenario === "assistant" ? assistantScript({ tps: opts.tps }) : opts.scenario === "activity" ? activityScript({ tps: opts.tps }) : script({ tps: opts.tps });
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

  function emit(type: string, data: any, top?: Record<string, any>) {
    const f: Frame = { v: 1, id: `${session}-${cur + 1}`, cur: ++cur, session, turn, type: `session.${type}`, time: Date.now(), corr: turn, t: now(), data, ...top };
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
    emit(s.type, s.data, s.top);
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
    sendGroup(text, o) {
      const message = `m${nextMsg++}`;
      // A quoted reply (the frame's reply_to and quote): the quote is the message answered, as the log holds it.
      const quoted = o.replyTo ? log.find((f) => f.message === o.replyTo || f.data?.message === o.replyTo) : null;
      const qtext = quoted ? String(quoted.data?.text ?? "") : "";
      emit("user-message", { message, text, state: "sent", ...(o.replyTo ? { reply_to: o.replyTo, quote: { message: o.replyTo, author: quoted?.author ?? VIEWER, text: qtext } } : {}) }, { author: VIEWER, message });
      if (o.parent) emit("thread-reply", { parent: o.parent }, { author: VIEWER, message });
      const c = new Clock();
      const tps = opts.tps ?? 30;
      const targets = o.to.length ? o.to : ["kit"];
      if (o.fanout) {
        const group = `f${nextMsg++}`;
        const members = targets.map((t, i) => ({ message: `${group}${"abc"[i] ?? i}`, author: `assistant:${t}` }));
        c.push("fanout", { group, message, members }, 40);
        const merged: Step[] = [];
        targets.forEach((t, i) => {
          const cc = new Clock().at(c.t);
          cc.say(members[i].message, `${t}: noted. This is the mock chat, so this is a sample answer number ${i + 1}.`, tps * (1 + i * 0.3), 100, { author: `assistant:${t}`, acts_for: VIEWER, message: members[i].message });
          merged.push(...cc.steps);
        });
        schedule([...c.steps, ...merged].sort((x, y) => x.at - y.at), 0);
        return;
      }
      const who = targets[0];
      c.say(`a${nextMsg}`, `${who}: noted. This is the mock chat, so nothing else happens.`, tps, 150, { author: `assistant:${who}`, acts_for: VIEWER, message: `a${nextMsg}` });
      schedule(c.steps, 0);
    },
    keep(group, message) { emit("fanout-keep", { group, keep: message }, { author: VIEWER }); },
    react(message, emoji, remove) { emit("reaction", { emoji, ...(remove ? { remove: true } : {}) }, { author: VIEWER, message }); },
    pin(message, pinned) { emit("pin", { pinned }, { author: VIEWER, message }); },
    markRead(upto) { emit("read-marker", { upto }, { author: VIEWER }); },
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
    if (k === 0) out.push(f("user-message", { message: id, text: `Message ${msg}: look at the intake form for Juniper Studio and tell me what is left.`, state: "sent" }));
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
