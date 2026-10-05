// Spending caps (spend.summary, spend.raise) and standing permissions (gate.said.list, add, revoke): the Deck's settings-spend.js and settings-permissions.js, ported. Pure: no calls.

// ---- Spend ------------------------------------------------------------------------------------------------------------------------------------------
export type SpendRow = { provider: string; spent: number; cap: number | null; capped: boolean; calls: number; estimated: boolean };

export const usd = (n: number): string => `$${Number(n).toFixed(2)}`;

/** spend.summary's answer: "all providers together" first, then each provider. */
export function providersOf(d: any): SpendRow[] {
  const all = d?.all && typeof d.all === "object" ? [{ provider: "all", spent: d.all.spent, cap: d.all.cap, capped: d.all.capped, calls: 0, estimated: false }] : [];
  return [...all, ...(Array.isArray(d?.providers) ? d.providers : [])]
    .filter((p: any) => p && typeof p.provider === "string")
    .map((p: any): SpendRow => ({ provider: String(p.provider), spent: Number(p.spent) || 0, cap: typeof p.cap === "number" && p.cap > 0 ? p.cap : null, capped: p.capped === true, calls: Number(p.calls) || 0, estimated: p.estimated === true }));
}
export const spendName = (p: string): string => (p === "all" ? "All providers together" : p[0].toUpperCase() + p.slice(1));
export const spendWords = (p: SpendRow): string => (p.cap == null ? `${usd(p.spent)} today, no cap` : `${usd(p.spent)} of ${usd(p.cap)} today${p.capped ? ", paused" : ""}`);
/** What a typed cap means: dollars above zero, to the cent, or null with the line to say. */
export function capInput(raw: string): { to: number } | { problem: string } {
  const n = Number(String(raw).trim().replace(/^\$/, "").trim());
  return n > 0 && Number.isFinite(n) ? { to: Math.round(n * 100) / 100 } : { problem: "Enter an amount in dollars, more than zero, or choose No cap." };
}

// ---- Standing permissions -------------------------------------------------------------------------------------------------------------------------------
export type Intent = { id: string; kind: string; channel: string | null; to: string[]; what: string; standing: boolean; agents: string[]; limits: { max_amount?: number; currency?: string } | null; at: number; used: number | null; when: string | null };

export const KINDS: [string, string][] = [["send", "Send"], ["post", "Post"], ["pay", "Pay"], ["act_out", "Do something outward"]];
const VERB: Record<string, string> = { send: "send to", post: "post to", pay: "pay", act_out: "do something outward for" };
export const splitList = (s: string): string[] => String(s || "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

export function intentsOf(d: any): Intent[] {
  return (Array.isArray(d?.intents) ? d.intents : []).filter((i: any) => i && typeof i.id === "string" && !i.revoked).map((i: any): Intent => ({
    id: String(i.id), kind: String(i.kind || ""), channel: i.channel ? String(i.channel) : null, to: Array.isArray(i.to) ? i.to.map(String) : [], what: i.what ? String(i.what) : "",
    standing: i.standing === true, agents: Array.isArray(i.agents) ? i.agents.map(String) : [], limits: i.limits && typeof i.limits === "object" ? i.limits : null,
    at: Number(i.at) || 0, used: i.used ? Number(i.used) : null, when: i.when ? String(i.when) : null,
  }));
}

/** One permission in a sentence: who, what it may do, to what, with its limit. */
export function sentence(i: Intent): string {
  const who = i.agents.length ? i.agents.join(", ") : "Any of your agents";
  const to = i.to.length ? i.to.join(", ") : "";
  const via = i.channel ? ` on ${i.channel}` : "";
  const cap = i.limits && Number(i.limits.max_amount) > 0 ? `, up to ${i.limits.max_amount} ${String(i.limits.currency || "").toUpperCase()}`.trimEnd() : "";
  const what = i.what ? ` (${i.what})` : "";
  return `${who} may ${VERB[i.kind] || i.kind} ${to}${via}${cap}${what}`.replace(/\s+/g, " ").trim();
}

export type PermissionForm = { kind: string; channel: string; to: string; what: string; agents: string; amount: string; currency: string };
export const EMPTY_FORM: PermissionForm = { kind: "send", channel: "", to: "", what: "", agents: "", amount: "", currency: "" };

/** The gate.said.add input for a filled form, or the line saying what is missing. A pay permission, or one naming no agent, opens a path the charter puts proof on, so `proof` says to ask for it. */
export function addInput(f: PermissionForm): { input: Record<string, unknown>; proof: boolean } | { problem: string } {
  const to = splitList(f.to);
  if (!to.length) return { problem: "Name who or where it may go: at least one exact address or channel." };
  const input: Record<string, unknown> = { kind: f.kind, to };
  if (f.channel.trim()) input.channel = f.channel.trim();
  if (f.what.trim()) input.what = f.what.trim();
  const agents = splitList(f.agents);
  if (agents.length) input.agents = agents;
  if (f.kind === "pay") {
    const n = Number(f.amount);
    if (!(n > 0 && Number.isFinite(n))) return { problem: "A payment permission needs a most-per-payment amount above zero." };
    input.limits = { max_amount: n, ...(f.currency.trim() ? { currency: f.currency.trim().toUpperCase() } : {}) };
  }
  return { input, proof: f.kind === "pay" || !agents.length };
}

/** "6 min ago", "3 h ago", "2 d ago". */
export function ago(t: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
/** The small line under a permission. */
export const permissionMeta = (i: Intent, now = Date.now()): string =>
  [i.standing ? "Standing permission" : i.when ? `Asked for ${i.when}` : "Asked for", i.at ? `added ${ago(i.at, now)}` : "", i.used ? `used ${ago(i.used, now)}` : ""].filter(Boolean).join(" · ");
