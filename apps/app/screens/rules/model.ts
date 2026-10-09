import { ROLE_IDS } from "../../../../kernel/contracts/index.js";
// The pure half of Rules: the kernel's standing rules (kernel/grants rulesList) and proposals as the lines the screen shows. The sentence for each rule is the
// kernel's own `view`, built from its structured fields; nothing here composes one, and a proposer's label is never the line.

export type RuleKind = "never" | "draft_only" | "always_ask";
export type Rule = { id: string; kind: RuleKind; binds: ("assistants" | "members")[]; covers: { actions: string[]; resource?: string }; approver?: { person?: string; role?: string }; label: string; view: string; status?: string; by?: string | { kind: string; id: string }; at?: number; proposed_by?: { kind: string; id: string } };
export type Listing = { rules: Rule[]; proposals: Rule[] };
export type Draft = { kind: RuleKind; binds: ("assistants" | "members")[]; actions: string; resource: string; approverKind: "person" | "role"; approver: string; label: string };

export const KINDS: { kind: RuleKind; title: string; help: string }[] = [
  { kind: "never", title: "Never", help: "The act is refused, whatever anyone is granted." },
  { kind: "draft_only", title: "Drafts only", help: "The act is prepared as a draft and never sent." },
  { kind: "always_ask", title: "Always ask", help: "Someone named approves every time, with presence. No grant waives it." },
];
export const ROLES: string[] = [...ROLE_IDS];

/** Active rules grouped by kind in the order above; a kind with none is left out. */
export function groups(rules: Rule[]): { kind: RuleKind; title: string; help: string; rules: Rule[] }[] {
  return KINDS.map((k) => ({ ...k, rules: rules.filter((r) => r.kind === k.kind && (r.status ?? "active") === "active").sort((a, b) => (a.at ?? 0) - (b.at ?? 0)) })).filter((g) => g.rules.length);
}

/** Rules an owner turned off: still listed, binding nothing, until turned on again. */
export const disabled = (rules: Rule[]): Rule[] => rules.filter((r) => r.status === "disabled").sort((a, b) => (a.at ?? 0) - (b.at ?? 0));

/** Who suggested a proposal, in words. A Kit or an assistant is named; a person is "a member". */
export function proposer(p: Rule): string {
  const b = p.by;
  if (!b || typeof b === "string") return "someone";
  return b.kind === "person" ? "a member" : b.kind === "agent" ? `the assistant ${b.id}` : `${b.kind} ${b.id}`;
}

const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
/** The actions a person typed, split on commas, spaces or lines; the kernel's own shape is checked here so a typo is caught before the owner's proof is asked. */
export function parseActions(text: string): { actions: string[]; bad: string[] } {
  const all = [...new Set(text.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
  return { actions: all.filter((a) => ACTION.test(a) && !a.startsWith("rules.")), bad: all.filter((a) => !ACTION.test(a) || a.startsWith("rules.")) };
}

/** The rule the kernel is sent, or the first thing wrong with the draft in words. */
export function build(d: Draft): { rule: Omit<Rule, "id" | "view" | "status"> } | { error: string } {
  const { actions, bad } = parseActions(d.actions);
  if (!d.binds.length) return { error: "Choose who it binds: assistants, members, or both." };
  if (bad.length) return { error: `${bad[0]} is not an action name. Actions look like mail.send, in lower case.` };
  if (!actions.length) return { error: "Name at least one action, like mail.send." };
  if (!d.label.trim()) return { error: "Give the rule a short name." };
  if (d.label.length > 120) return { error: "The name is longer than 120 characters." };
  if (d.kind === "always_ask" && !d.approver.trim()) return { error: d.approverKind === "role" ? "Choose the role that approves." : "Name the person who approves." };
  const covers = { actions, ...(d.resource.trim() ? { resource: d.resource.trim() } : {}) };
  return { rule: { kind: d.kind, binds: [...d.binds].sort(), covers, ...(d.kind === "always_ask" ? { approver: d.approverKind === "role" ? { role: d.approver.trim() } : { person: d.approver.trim() } } : {}), label: d.label.trim() } as never };
}

/** A refusal's cause, from a decision or an error's detail: "Refused by the rule: <label>". Null when no rule refused it. */
export function refusedBy(x: unknown): string | null {
  const d = x as { rule?: { kind?: string; label?: string }; detail?: { rule?: { kind?: string; label?: string } } } | null | undefined;
  const r = d?.rule ?? d?.detail?.rule;
  if (!r?.label) return null;
  return r.kind === "always_ask" ? `Waiting on the rule: ${r.label}` : r.kind === "draft_only" ? `Kept as a draft by the rule: ${r.label}` : `Refused by the rule: ${r.label}`;
}

/** The words for a refused rules call, from the kernel's code. */
export function ruleRefusal(code: string | undefined, message: string): string {
  if (code === "not_allowed") return "Only an owner can do that.";
  if (code === "presence_required") return "That needs you. Approve on this device, then try again.";
  if (code === "not_found") return "That rule is already gone.";
  return message || "The rules did not answer.";
}
