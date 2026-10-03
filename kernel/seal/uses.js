// kernel/seal/uses.js: the vault and Drive on the same grants and events as everything else. A credential is used without being seen: the
// caller supplies what to do, the kernel decides (`authorize`), the use runs once inside the vault or Drive adapter, and one typed event says
// what happened ("used for Gmail, 3 times today") without any value. The ActionDefs below are the vault, Drive and sealing entries of the
// action registry; the adapters register them with the kernel at install. Contract 6.1, 7.7; invariants 1 and 7.

/** Registry entries (kernel/contracts/authorize.d.ts ActionDef). `sealed_ok` only where the sealing process runs the step model-free. */
export const ACTIONS = Object.freeze([
  // A credential's effect is not the vault's risk (R5-4): filling a login is bound to the origin it was lent for, a read-only API call is a read,
  // and any other request made with a key is an outward act that waits for a person like a send or a payment.
  { action: "vault.fill", resource_type: "credential", risk: "write", label: "Sign in with a login", gloss: "Fills a login on the site it was lent for, without showing it." },
  { action: "vault.totp", resource_type: "credential", risk: "write", label: "Use a one-time code", gloss: "Enters the current code without showing it." },
  { action: "vault.read", resource_type: "credential", risk: "read", label: "Read through a service key", gloss: "Looks something up with a key, changing nothing." },
  { action: "vault.call", resource_type: "credential", risk: "outward.send", label: "Act through a service key", gloss: "Makes a request that can change things at the service: a refund, a payment, a message." },
  { action: "vault.run", resource_type: "credential", risk: "admin", label: "Give a program a secret", gloss: "Puts the value in a program's environment." },
  { action: "vault.reveal", resource_type: "credential", risk: "admin", label: "Show a secret", gloss: "Shows the value to a person, on their own screen." },
  { action: "vault.share", resource_type: "credential", risk: "outward.share", label: "Share a login or key", gloss: "Lets someone outside the Space use it." },
  { action: "vault.rotate", resource_type: "credential", risk: "admin", label: "Rotate a key", gloss: "Replaces a key at the service that issued it." },
  { action: "drive.read", resource_type: "file", risk: "read", label: "Read a file", gloss: "Opens a file in a project or a Drive share." },
  { action: "drive.write", resource_type: "file", risk: "write", label: "Change a file", gloss: "Saves or edits a file." },
  { action: "drive.share", resource_type: "file", risk: "outward.share", label: "Share a file", gloss: "Gives someone outside the Space access to a file." },
  { action: "drive.delete", resource_type: "file", risk: "outward.delete", label: "Delete a file", gloss: "Removes a file for good." },
  { action: "seal.put", resource_type: "record", risk: "write", label: "Seal a value", gloss: "Moves a value into the sealed store." },
  { action: "seal.use", resource_type: "record", risk: "write", label: "Fill a sealed slot", gloss: "Merges a sealed value into a document or message.", sealed_ok: true },
  { action: "seal.deliver", resource_type: "record", risk: "outward.send", label: "Send what was filled", gloss: "Sends a message or document that holds a sealed value." },
  { action: "seal.reveal", resource_type: "record", risk: "admin", label: "Show a sealed value", gloss: "Shows it on your screen only, after Face ID." },
]);

/** fill and totp as themselves, a GET or HEAD API call as a read, any other or unknown method as an outward call, a program's environment as admin. */
export function credentialAction(kind, method = "GET") {
  if (kind === "fill") return "vault.fill";
  if (kind === "totp") return "vault.totp";
  if (kind === "run") return "vault.run";
  if (kind === "api") return ["GET", "HEAD"].includes(String(method).toUpperCase()) ? "vault.read" : "vault.call";
  return "vault.call";
}
const BAD = /(^|\/)\.{1,2}(\/|$)|%2e|%2f|%5c|%00|\\|[\u0000-\u001f\u007f]|\/\//i;
/** A file path under a project or Drive root: no dot segments, no encoded dots or slashes, no backslash, NUL or control characters, no empty segment. A grant for a folder must not reach outside it. */
export function safePath(p) {
  const s = String(p ?? "");
  const winBad = s.split("/").some(x => /[. ]$/.test(x) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(x));
  if (!s || s.startsWith("/") || BAD.test(s) || s.normalize("NFKC") !== s || winBad) throw Object.assign(new Error("bad_input"), { code: "bad_input" });
  return s;
}
/** One URN segment (a credential name): no slash, dot segment, encoding or control character. */
export function segment(x) { const s = String(x ?? ""); if (!s || /[/\\%]|^\.+$|[\u0000-\u001f\u007f]/.test(s)) throw Object.assign(new Error("bad_input"), { code: "bad_input" }); return s; }
const EVENTS = { allow: { vault: "vault.used", drive: "file.accessed" }, deny: "access.refused" };
const noun = a => a.split(".")[0];

/**
 * @param {{ authorize: (i: any) => Promise<{ effect: string, decision: string, reason: string }>, append: (chain: any, e: { type: string, sv: number, subject: string, data: any, cause?: string }) => Promise<any> }} k
 */
export function createGuard({ authorize, append }) {
  /** Decide, run once, record. A refusal looks like absence to the caller; the true reason is in the event. */
  async function act(chain, { action, resource, service, data = {}, run }) {
    const d = await authorize({ chain, action, resource, input_class: service });
    if (d.effect === "deny") {
      await append(chain, { type: EVENTS.deny, sv: 1, subject: resource, data: { action, reason: d.reason, service: service ?? null }, cause: d.decision });
      return { status: "refused", error: { code: "not_found" } };
    }
    if (d.effect === "ask") return { status: "ask", decision: d.decision };
    const result = await run();
    await append(chain, { type: EVENTS.allow[noun(action)] ?? "access.used", sv: 1, subject: resource, data: { action, service: service ?? null, ...data }, cause: d.decision });
    return { status: "done", result };
  }
  return {
    act,
    /** Use a credential for a service. `run` receives nothing secret; the adapter that owns the vault does the use and returns only its outcome. */
    useCredential: async (chain, { item, service, kind = "api", method = "GET", run }) => act(chain, { action: credentialAction(kind, method), resource: `vyre://${chain.space}/credential/${segment(item)}`, service, data: { kind, ...(kind === "api" ? { method: String(method).toUpperCase() } : {}) }, run }),
    readFile: async (chain, { path, run }) => act(chain, { action: "drive.read", resource: `vyre://${chain.space}/file/${safePath(path)}`, run }),
  };
}

/** "Used for Gmail 3 times today, Stripe once" from `vault.used` events. @param {{ type: string, time: number, data: any, actor?: string }[]} events */
export function summarise(events, now = Date.now(), dayMs = 86_400_000) {
  const by = new Map();
  for (const e of events) {
    if (e.type !== "vault.used" || e.time < now - dayMs) continue;
    const k = e.data.service ?? "another service", cur = by.get(k) ?? { service: k, uses: 0, last: 0 };
    cur.uses++; cur.last = Math.max(cur.last, e.time); by.set(k, cur);
  }
  const rows = [...by.values()].sort((a, b) => b.uses - a.uses || a.service.localeCompare(b.service));
  const times = n => (n === 1 ? "once" : `${n} times`);
  return { rows, text: rows.length ? `Used for ${rows.map(r => `${r.service} ${times(r.uses)}`).join(", ")} today.` : "Not used today." };
}

/** An old `vault_audit` row as a typed event body (contract 7.7). Only the shape the audit already holds: item, who, origin, surface. */
export function foldAudit(row) {
  const kind = { release: "release", fill: "fill", relay: "relay", inject: "run", totp: "totp", "api-request": "api" }[row.action];
  if (!kind) return null;
  // An old audit row does not say which method an API request used, so it is folded as the stricter action.
  const action = { fill: "vault.fill", totp: "vault.totp", run: "vault.run", api: "vault.call", relay: "vault.call", release: "vault.run" }[kind];
  return { type: row.ok ? "vault.used" : "access.refused", sv: 1, data: { action, kind, item: row.name ?? null, service: row.origin ?? null, via: row.surface ?? null }, time: row.at };
}

/** A vault agent grant (core/vault/agents.js row) as a kernel grant input: the same lending, now in the one grants table. */
export function grantFromAgent(g, space) {
  return {
    subject: { kind: "actor", actor: { kind: "agent", id: g.agent, space } }, actions: ["vault.fill", "vault.totp"],
    resource: { prefix: `vyre://${space}/credential/${segment(g.item)}` },
    conditions: { where: { surfaces: ["harness", "mcp"] }, ...(g.expires ? { when: { expires: Number(g.expires) } } : {}), audience: [new URL(g.origin).host] },
    source: "vault:agent-grant", reason: `lent to ${g.agent} for ${g.origin}`,
  };
}
