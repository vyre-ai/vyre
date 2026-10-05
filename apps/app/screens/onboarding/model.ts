// The setup steps after the passkey (steps 8 to 10 of the one setup flow), as data. Ported from the Deck's deck/setup/steps.js and mount.js:
// steps 1 to 7 are done by the time anyone is here, so these are the three that remain (you and your assistant, your computers, your history)
// and the ending. Pure: no React, no network. The state comes from onboard.status, the box's own record, and onboard.setup when the box has it.

export type StepId = "install" | "words" | "address" | "tailscale" | "ai" | "phone" | "passkey" | "assistant" | "computers" | "history";
export type StepState = "done" | "current" | "skipped" | "todo";
export type Step = { id: StepId; title: string; where: string; optional: boolean };
export type StepView = Step & { n: number; status: StepState };
export type View = { list: StepView[]; current: StepId | null; number: number; finished: boolean };

export const STEPS: readonly Step[] = Object.freeze([
  { id: "install", title: "Install", where: "On your server", optional: false },
  { id: "words", title: "Check the words", where: "On your server", optional: false },
  { id: "address", title: "Choose your address", where: "In your browser", optional: false },
  { id: "tailscale", title: "Connect Tailscale", where: "In your browser", optional: false },
  { id: "ai", title: "Sign in to your AI", where: "In your browser", optional: false },
  { id: "phone", title: "Add your phone", where: "In your browser", optional: true },
  { id: "passkey", title: "Create your passkey", where: "At your address", optional: false },
  { id: "assistant", title: "You and your assistant", where: "At your address", optional: false },
  { id: "computers", title: "Your computers", where: "At your address", optional: true },
  { id: "history", title: "Your history", where: "At your address", optional: true },
]);

/** onboard.status's answer, as far as the screens read it. */
export type Status = {
  person?: string | null; assistant?: string | null; finished?: boolean;
  steps?: Record<string, string>;
  detail?: { devices?: { mac?: { connected?: boolean; name?: string | null } | null; macDownload?: string }; history?: { sessions?: number; machines?: { machine?: string; source?: string; sessions?: number }[] } };
};
/** onboard.setup's answer: the box's own ten-step list. */
export type Setup = { steps?: { id: string; title: string; where: string; optional?: boolean; status: string }[]; current?: string | null; finished?: boolean; name?: string } | null;
export type Ending = { name: string | null; display: string | null; thread: string | null; why?: string | null };

const IDS = new Set<string>(STEPS.map((s) => s.id));

/** Where steps 8 to 10 stand, from onboard.status. `passed` holds steps the person moved past in this visit that the box does not record as done (history is read only, so Continue is only a page move). */
export function setupSteps(status: Status | null | undefined, local: { passed?: string[] } = {}): View {
  const st = status || {};
  const passed = new Set(local.passed || []);
  const steps = st.steps || {}, detail = st.detail || {};
  const person = typeof st.person === "string" && st.person.trim() !== "";
  const mac = detail.devices?.mac?.connected === true;
  const skipped = (id: string) => (id === "computers" ? steps.devices : steps[id]) === "skipped";
  const own: Record<string, "done" | "skipped" | "todo"> = {
    assistant: person ? "done" : "todo",
    computers: mac ? "done" : skipped("computers") || passed.has("computers") ? "skipped" : "todo",
    history: skipped("history") ? "skipped" : passed.has("history") ? "done" : "todo",
  };
  const firstTodo = (["assistant", "computers", "history"] as const).find((id) => own[id] === "todo") || null;
  const list = STEPS.map((s, i) => {
    const n = i + 1;
    const status: StepState = n <= 7 ? "done" : own[s.id] === "todo" ? (s.id === firstTodo ? "current" : "todo") : own[s.id];
    return { ...s, n, status };
  });
  return { list, current: firstTodo, number: firstTodo ? STEPS.findIndex((s) => s.id === firstTodo) + 1 : 10, finished: firstTodo === null };
}

/** The steps as drawn: the box's own list when it has all ten, else the one derived from onboard.status. */
export function viewOf(status: Status | null, setup: Setup, passed: string[]): View {
  if (setup && Array.isArray(setup.steps) && setup.steps.length === 10 && setup.steps.every((x) => IDS.has(String(x.id)))) {
    const list: StepView[] = setup.steps.map((x, i) => ({
      id: String(x.id) as StepId, title: String(x.title), where: String(x.where), optional: Boolean(x.optional), n: i + 1,
      status: (["done", "current", "skipped", "todo"].includes(x.status) ? x.status : "todo") as StepState,
    }));
    const cur = typeof setup.current === "string" && IDS.has(setup.current) ? (setup.current as StepId) : null;
    const idx = cur ? list.findIndex((x) => x.id === cur) : -1;
    return { list, current: cur, number: idx >= 0 ? idx + 1 : 10, finished: setup.finished === true || cur === null };
  }
  return setupSteps(status, { passed });
}

/** "Step 8 of 10, optional". */
export function stepLabel(view: View, id: StepId): string {
  const s = view.list.find((x) => x.id === id);
  return s ? `Step ${s.n} of 10${s.optional ? ", optional" : ""}` : "";
}

/** The two names the first step asks for. A name is needed; the assistant's name is optional and the box picks one when it is left blank. */
export function youInput(name: string, assistant: string): { error: string } | { name: string; assistant?: string } {
  const you = String(name || "").trim();
  if (!you) return { error: "Tell Vyre your name first." };
  const a = String(assistant || "").trim();
  return { name: you, assistant: a || undefined };
}

/** What the history step says it found. */
export function historyLines(status: Status | null): { found: string; hint: string | null } {
  const hs = status?.detail?.history || {};
  const machines = (Array.isArray(hs.machines) ? hs.machines : []).filter((m) => m && Number(m.sessions) >= 0);
  const total = Number(hs.sessions) || 0;
  const names = machines.map((m) => (m.source === "box" ? "your server" : String(m.machine || "your Mac").slice(0, 60)));
  if (total > 0) {
    const where = names.filter((_, i) => Number(machines[i].sessions) > 0).join(" and ") || "your computers";
    return { found: `Found ${total} session${total === 1 ? "" : "s"}${machines.length ? ` on ${where}` : ""}.`, hint: "Open Lumen on your Mac to choose what to import. Your history stays on that computer until you choose what to send." };
  }
  return { found: `Found nothing${names.length ? ` on ${names.join(" and ")}` : ""}. ${names.length ? "It has" : "There is"} no Claude Code, Codex or Grok history in the usual folders.`, hint: null };
}

/** The Mac the box has paired, and the https link to download Lumen (anything else is dropped). */
export function computersOf(status: Status | null): { mac: { name: string } | null; download: string | null } {
  const d = status?.detail?.devices || {};
  return { mac: d.mac && d.mac.connected ? { name: d.mac.name || "Your Mac" } : null, download: safeHttps(d.macDownload) };
}

export function safeHttps(u: unknown): string | null {
  try { const x = new URL(String(u)); return x.protocol === "https:" && !x.username && !x.password && x.href.length < 600 ? x.href : null; } catch { return null; }
}

/** An onboard.finish or onboard.assistant answer, as the ending reads it. A failed assistant carries its reason. */
export function endingOf(answer: unknown): Ending {
  const r = (answer && typeof answer === "object" ? answer : {}) as Record<string, any>;
  const a = (r.assistant && typeof r.assistant === "object" ? r.assistant : r) as Record<string, any>;
  if (a.state === "failed") return { name: null, display: a.display ?? null, thread: null, why: String(a.why || "it could not be made") };
  return { name: a.name ?? null, display: a.display ?? null, thread: a.thread ?? null };
}

export const say = (e: unknown): string => String((e as { message?: string })?.message || e || "That did not work").slice(0, 200);
