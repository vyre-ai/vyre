// Needs you, as data (team/archive/CONTRACT-native-apps.md sections 2.2 and 2.4): held Gate items and open asks as
// one kind of row, oldest first, kept live by the box's events. Pure: no React, no imports, so
// the Node tests load it as it is.
//
// Presence: every item the box lists carries `presence: {required, covered, since}` (gate.held,
// threads.asks). Events do not, so an item that arrives by event is taken as needing a proof when
// its kind acts outside (send, spend, delete) and as not covered, and the list is read again to
// learn the truth. A swipe never commits what the box would refuse for presence: it opens the
// item instead.

export type Presence = { required: boolean; covered: boolean; since: number | null };

export type Need = {
  /** "gate:<id>" or "ask:<id>": unique across both sources. */
  id: string;
  source: "gate" | "ask";
  /** The Gate item's id or the ask's id, as the box names it. */
  ref: string;
  /** gate: send, spend or delete; ask: permission or question. */
  kind: string;
  title: string;
  /** One line: the subject, the command, the question. */
  detail: string;
  /** The detail is a command or a URL (mono). */
  mono: boolean;
  agent: string | null;
  project: string | null;
  thread: string | null;
  at: number;
  presence: Presence;
  /** An approved send that failed and came back to held. */
  error?: string | null;
  /** Gate only: where it goes. */
  to?: string[];
  via?: string | null;
  why?: string | null;
  tool?: string | null;
};

/** What joins an item to names: projects by slug, threads by id. */
export type NeedsContext = {
  projects?: Record<string, string>;
  threads?: Record<string, { agent?: string | null; name?: string | null; project?: string | null }>;
};

export type Decision = "approve" | "reject";

/** Gate kinds that act as the person outside, and so need a proof to approve (core/gate). */
const OUTBOUND = new Set(["send", "spend", "delete"]);

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

function presenceOf(v: unknown, required: boolean): Presence {
  const p = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  return {
    required: p && typeof p.required === "boolean" ? p.required : required,
    covered: Boolean(p && p.covered),
    since: p && typeof p.since === "number" ? p.since : null,
  };
}

/** "sam@northwind.test" as "sam". */
const person = (to: string) => to.replace(/^mailto:/, "").split("@")[0] || to;

function gateTitle(kind: string, via: string | null, to: string[], summary: string): string {
  const who = to.length ? person(to[0]) + (to.length > 1 ? ` and ${to.length - 1} more` : "") : "";
  if (kind === "send") {
    const what = via && /mail/i.test(via) ? "email" : "message";
    return who ? `Send ${what} to ${who}` : `Send ${what}`;
  }
  if (kind === "spend") return who ? `Pay ${who}` : "Approve a payment";
  if (kind === "delete") return summary ? `Delete ${summary}` : "Approve a deletion";
  return summary || "Approve";
}

/** A tool as the verb a person reads. */
function askTitle(kind: string, tool: string | null, agent: string | null): string {
  if (kind === "question") return `${agent ?? "A chat"} has a question`;
  switch (tool) {
    case "Bash": return "Run a command";
    case "Write": return "Write a file";
    case "Edit": case "MultiEdit": case "NotebookEdit": return "Edit a file";
    case "WebFetch": return "Fetch a page";
    case "WebSearch": return "Search the web";
    default: return tool ? `Use ${tool.replace(/^mcp__/, "").replace(/__/g, " ")}` : "Allow a step";
  }
}

/** One held Gate item (gate.held's Brief, or a gate.held event's payload). */
export function fromGate(b: Record<string, unknown>, ctx: NeedsContext = {}, at?: number): Need | null {
  const id = str(b.id);
  if (!id) return null;
  const kind = str(b.kind) ?? "send";
  const via = str(b.via);
  const to = Array.isArray(b.to) ? b.to.filter((x): x is string => typeof x === "string") : typeof b.to === "string" ? [b.to] : [];
  const summary = str(b.summary) ?? "";
  const project = str(b.project);
  const thread = str(b.thread);
  const agent = str(b.agent) ?? (thread ? str(ctx.threads?.[thread]?.agent) : null);
  return {
    id: "gate:" + id,
    source: "gate",
    ref: id,
    kind,
    title: gateTitle(kind, via, to, summary),
    detail: summary,
    mono: /^[A-Z]+ https?:\/\//.test(summary),
    agent,
    project: project ? (ctx.projects?.[project] ?? project) : null,
    thread,
    at: num(b.at, at ?? 0),
    presence: presenceOf(b.presence, OUTBOUND.has(kind)),
    error: str(b.error),
    to,
    via,
    why: str(b.why),
  };
}

/** One open ask (threads.asks, or an ask.raised event's payload with the ask's id under `ask`). */
export function fromAsk(a: Record<string, unknown>, ctx: NeedsContext = {}, at?: number): Need | null {
  const id = str(a.id) ?? str(a.ask);
  if (!id) return null;
  const thread = str(a.thread);
  const t = thread ? ctx.threads?.[thread] : undefined;
  const agent = str(a.agent) ?? str(t?.agent);
  const kind = str(a.kind) ?? "permission";
  const tool = str(a.tool);
  const project = str(a.project) ?? str(t?.project);
  const questions = Array.isArray(a.questions) ? a.questions : null;
  const q = questions && questions[0] && typeof questions[0] === "object" ? str((questions[0] as Record<string, unknown>).question) : null;
  const detail = q ?? str(a.summary) ?? str(a.reason) ?? "";
  return {
    id: "ask:" + id,
    source: "ask",
    ref: id,
    kind,
    title: askTitle(kind, tool, agent),
    detail,
    mono: kind !== "question" && tool === "Bash",
    agent,
    project: project ? (ctx.projects?.[project] ?? project) : null,
    thread,
    at: num(a.at, at ?? 0),
    // Answering an ask is the person's own action: no proof (switchboard, the no-nag rule).
    presence: presenceOf(a.presence, false),
    tool,
  };
}

/** Oldest first, so nothing starves; ties by id, so the order is stable. */
export function order(list: readonly Need[]): Need[] {
  return [...list].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** gate.held and threads.asks as one list. */
export function merge(gates: unknown, asks: unknown, ctx: NeedsContext = {}): Need[] {
  const out: Need[] = [];
  for (const g of Array.isArray(gates) ? gates : []) {
    const n = g && typeof g === "object" ? fromGate(g as Record<string, unknown>, ctx) : null;
    if (n) out.push(n);
  }
  for (const a of Array.isArray(asks) ? asks : []) {
    const n = a && typeof a === "object" ? fromAsk(a as Record<string, unknown>, ctx) : null;
    if (n) out.push(n);
  }
  return order(out);
}

export type NeedsEvent = { type: string; at?: number; thread?: string | null; project?: string | null; payload?: Record<string, unknown> };

/**
 * One event on the list. `list` is the new list (the same array when nothing changed), and
 * `refetch` says the event does not carry enough (presence, a failed send's error): read the
 * box's lists again.
 */
export function applyNeedsEvent(list: readonly Need[], e: NeedsEvent, ctx: NeedsContext = {}): { list: readonly Need[]; refetch: boolean } {
  const p = e.payload ?? {};
  const without = (id: string) => {
    const next = list.filter((n) => n.id !== id);
    return next.length === list.length ? list : next;
  };
  switch (e.type) {
    case "ask.raised": {
      const n = fromAsk({ ...p, thread: p.thread ?? e.thread ?? null }, ctx, e.at);
      if (!n || list.some((x) => x.id === n.id)) return { list, refetch: false };
      return { list: order([...list, n]), refetch: !n.agent && !!n.thread };
    }
    case "ask.answered":
      return { list: without("ask:" + String(p.ask ?? "")), refetch: false };
    case "gate.held": {
      const n = fromGate({ ...p, thread: p.thread ?? e.thread ?? null, project: p.project ?? e.project ?? null }, ctx, e.at);
      if (!n) return { list, refetch: false };
      if (list.some((x) => x.id === n.id)) return { list, refetch: true };
      return { list: order([...list, n]), refetch: true };
    }
    case "gate.released":
    case "gate.rejected":
      return { list: without("gate:" + String(p.id ?? "")), refetch: false };
    case "gate.failed": {
      const id = "gate:" + String(p.id ?? "");
      const err = str(p.error) ?? "The send failed";
      const next = list.map((n) => (n.id === id ? { ...n, error: err } : n));
      return { list: next, refetch: true };
    }
    case "gate.revised":
      return { list, refetch: true };
    default:
      return { list, refetch: false };
  }
}

/** The cached list, if it is one (the cache survives versions, so it is checked, not trusted). */
export function hydrate(value: unknown): Need[] | null {
  if (!Array.isArray(value)) return null;
  const out: Need[] = [];
  for (const v of value) {
    if (!v || typeof v !== "object") return null;
    const n = v as Partial<Need>;
    if (typeof n.id !== "string" || (n.source !== "gate" && n.source !== "ask") || typeof n.ref !== "string" || typeof n.title !== "string"
      || typeof n.at !== "number" || !n.presence || typeof n.presence !== "object") return null;
    out.push({
      ...(n as Need),
      detail: typeof n.detail === "string" ? n.detail : "",
      mono: Boolean(n.mono),
      agent: n.agent ?? null,
      project: n.project ?? null,
      thread: n.thread ?? null,
      presence: presenceOf(n.presence, false),
    });
  }
  return order(out);
}

/** Can a swipe commit this answer here, or must the item open? */
export function canCommit(n: Need, d: Decision): { ok: true } | { ok: false; why: string } {
  if (d === "approve" && n.source === "ask" && n.kind === "question") return { ok: false, why: "Needs your answer" };
  // Discarding a Gate item and denying an ask send nothing, so they never need a proof.
  const needsProof = d === "approve" && n.presence.required;
  if (needsProof && !n.presence.covered) return { ok: false, why: "Needs Face ID on this device" };
  return { ok: true };
}

/** The tool call an answer is. */
export function answerCall(n: Need, d: Decision, surface: string): { tool: string; input: Record<string, unknown> } {
  if (n.source === "gate") return d === "approve" ? { tool: "gate.approve", input: { id: n.ref } } : { tool: "gate.reject", input: { id: n.ref } };
  return { tool: "threads.answer", input: { ask: n.ref, decision: d === "approve" ? "allow" : "deny", surface } };
}

/** The box's answer to an answer: through, or refused with the reason a person reads. */
export function answerOutcome(n: Need, r: { data?: unknown; error?: { code?: string; message?: string } }): { ok: true } | { ok: false; reason: string } {
  if (r.error) return { ok: false, reason: r.error.message || r.error.code || "Refused" };
  const d = r.data && typeof r.data === "object" ? (r.data as Record<string, unknown>) : {};
  if (n.source === "gate" && d.state === "failed") return { ok: false, reason: str(d.error) ?? "The send failed" };
  if (n.source === "ask" && d.answered === false) return { ok: false, reason: str(d.note) ?? "Not answered" };
  return { ok: true };
}

/** "12m", "3h", "2d": the age a row shows. */
export function age(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
