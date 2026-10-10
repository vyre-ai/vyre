// The pure half of Connections on a real vyred: what connectors.catalog, mcp.servers, google.accounts, github.accounts and vault.connections.list answer, as the lines the screen
// shows. These pickers copy only the keys they name, so a stray field (a token) in an answer cannot reach the screen. Wording is the Deck's.

import { locateSecrets } from "../../src/store-core/credential-shapes.js";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObj) : []);
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---- hiding what was typed ----

// What a known secret looks like is the table's (lib/credential-shapes.js, copied into src/store-core by scripts/sync-copies.mjs: the app's bundle cannot import from lib/); only the generic runs are written here.
const GENERIC = [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, /\b[A-Fa-f0-9]{40,}\b/g];
/** A message that may echo what the person typed (a pasted token) with known secret shapes masked, and the exact strings just typed. */
export function redact(text: unknown, also: string[] = []): string {
  let s = String(text ?? "");
  for (const x of also) if (typeof x === "string" && x.length >= 6) s = s.split(x).join("[hidden]");
  const spans = locateSecrets(s);
  for (let i = spans.length - 1; i >= 0; i--) s = s.slice(0, spans[i].start) + "[hidden]" + s.slice(spans[i].end);
  for (const re of GENERIC) s = s.replace(re, (m) => (/^Bearer/i.test(m) ? "Bearer [hidden]" : "[hidden]"));
  return s;
}

/** A refusal in words: a box without the module says so, and nothing typed is echoed. */
export const words = (e: { code?: string; message?: string } | null | undefined, also: string[] = []): string =>
  e?.code === "no_such_tool" ? "Connectors are not running on your server yet." : redact(e?.message || "That did not go through.", also);

export const httpsOnly = (u: unknown): string | null => (typeof u === "string" && /^https:\/\//i.test(u) ? u : null);
/** Only https://github.com/... ever becomes a link; anything else falls back to GitHub's own device page. */
export const safeGithubUrl = (u: unknown): string => (/^https:\/\/github\.com\//.test(String(u || "")) ? String(u) : "https://github.com/login/device");

// ---- who can use a connection ----

export type Scope = { projects: "*" | string[]; agents: "*" | string[] } | null;
export type Who = { mode: "me" | "all" | "some"; projects: string[] };
export const WHO: ["me" | "all" | "some", string][] = [["me", "Just me and the assistant"], ["all", "All projects, every agent"], ["some", "Only these projects"]];

/** What a connection carries, in words. An entry with no scope at all (a box from before scopes) is unknown, not the default. */
export function scopeLine(scope: unknown): string {
  if (scope === undefined) return "Scope not recorded";
  if (!isObj(scope)) return "Just you and the assistant";
  const agents = scope.agents === "*" ? "every agent" : Array.isArray(scope.agents) && scope.agents.length ? scope.agents.join(", ") : "";
  if (scope.projects === "*") return agents === "every agent" ? "All projects, every agent" : `All projects${agents ? `, ${agents}` : ""}`;
  const p = Array.isArray(scope.projects) ? scope.projects.join(", ") : "";
  return p ? `${p}${agents && agents !== "every agent" ? `, ${agents}` : ""}` : "Just you and the assistant";
}
/** A who-choice as the scope connectors.connect takes: null is the default (nothing written), undefined is an unfinished choice (some, none picked). */
export function scopeOf(w: Who | null | undefined): Scope | undefined {
  if (!w || w.mode === "me") return null;
  if (w.mode === "all") return { projects: "*", agents: "*" };
  return w.projects.length ? { projects: w.projects, agents: "*" } : undefined;
}
export function whoFrom(scope: unknown): Who {
  if (!isObj(scope)) return { mode: "me", projects: [] };
  if (scope.projects === "*") return { mode: "all", projects: [] };
  return Array.isArray(scope.projects) && scope.projects.length ? { mode: "some", projects: scope.projects.map(String) } : { mode: "me", projects: [] };
}
export const whoHelp = (m: Who["mode"]): string => (m === "me" ? "Agents in a project can't use it unless you choose that project." : m === "all" ? "Agents in any project can use it." : "Agents in the projects you pick can use it.");

// ---- the catalog (Add a service) ----

export type Connected = { name: string; mode: string; label: string; scope: Scope | undefined };
export type Preset = { id: string; label: string; group: string; who: string; note: string; setup: string; via: string; connected: Connected[] };
export const SETUP_WORD: Record<string, string> = { none: "", app: "Needs an app from the vendor", token: "Needs a token", via: "Comes through another connector" };

/** The catalog as groups, in the order the box sent them. A Google sign-in that covers Gmail and Calendar is one preset (the box names it). */
export function groupsOf(d: unknown): { group: string; presets: Preset[] }[] {
  const by = new Map<string, Preset[]>();
  for (const p of list((d as { presets?: unknown } | null)?.presets)) {
    if (typeof p.id !== "string" || !p.label) continue;
    const row: Preset = { id: p.id, label: String(p.label), group: String(p.group || "Other"), who: str(p.who), note: str(p.note), setup: str(p.setup) || "none", via: str(p.via),
      connected: list(p.connected).filter((c) => c.name).map((c) => ({ name: String(c.name), mode: str(c.mode), label: str(c.label), scope: "scope" in c ? (c.scope === null ? null : isObj(c.scope) ? (c.scope as unknown as Scope) : undefined) : undefined })) };
    (by.get(row.group) ?? by.set(row.group, []).get(row.group)!).push(row);
  }
  return [...by.entries()].map(([group, presets]) => ({ group, presets }));
}

/** One answer of connectors.connect, as the step the screen draws. */
export type Step =
  | { step: "connected"; line: string }
  | { step: "open"; id: string; url: string | null }
  | { step: "token"; label: string; help: string; guide: Guide | null; extra: { name: string; label: string; required: boolean }[] }
  | { step: "client"; help: string; redirect: string; guide: Guide | null; fields: { name: string; label: string; secret: boolean; required: boolean }[] }
  | { step: "via"; message: string }
  | { step: "none" };

/** A vendor's own steps for making an app or a token: lines, and links that are https only. */
export type Guide = { steps: string[]; links: { label: string; url: string }[] };
export function guideOf(g: unknown): Guide | null {
  if (!isObj(g)) return null;
  const links = list(g.links).map((l) => ({ label: str(l.label) || "Open", url: httpsOnly(l.url) })).filter((l): l is { label: string; url: string } => Boolean(l.url));
  const steps = strs(g.steps);
  return steps.length || links.length ? { steps, links } : null;
}

export function stepOf(d: unknown, label: string): Step {
  const s = (isObj(d) ? d : {}) as Record<string, unknown>;
  if (s.step === "connected") {
    const tools = Array.isArray(s.tools) ? s.tools.length : num(s.tools) ?? 0;
    return { step: "connected", line: `${label} is connected${s.tools ? `, ${plural(tools, "tool")}` : ""}${s.warning ? `. ${str(s.warning)}` : "."}` };
  }
  if (s.step === "open" && str(s.id)) return { step: "open", id: str(s.id), url: httpsOnly(s.url) };
  if (s.step === "needs" && s.needs === "token") return { step: "token", label: str(s.label) || "Token", help: str(s.help), guide: guideOf(s.guide), extra: list(s.extra).filter((x) => x.name).map((x) => ({ name: String(x.name), label: str(x.label) || String(x.name), required: x.required === true })) };
  if (s.step === "needs" && s.needs === "client") return { step: "client", help: str(s.help), redirect: str(s.redirect), guide: guideOf(s.guide),
    fields: (list(s.fields).length ? list(s.fields) : [{ name: "client_id", label: "Client ID", secret: false, required: true }, { name: "client_secret", label: "Client secret", secret: true, required: false }])
      .filter((f) => f.name).map((f) => ({ name: String(f.name), label: str(f.label) || String(f.name), secret: f.secret === true, required: f.required !== false })) };
  if (s.step === "via") return { step: "via", message: str(s.message) || `Connect this through ${str(s.via)}.` };
  return { step: "none" };
}

// ---- MCP servers ----

const STATE = new Set(["stopped", "starting", "running", "failed"]);
type Ref = { item: string; field: string };
const ref = (v: unknown): Ref => (typeof v === "string" ? { item: v, field: "" } : isObj(v) ? { item: str(v.item), field: str(v.field) } : { item: "", field: "" });
export type Mode = "read" | "write" | "off";
export type Server = { name: string; transport: string; state: string; error: string; tools: number | null; lastUsed: number | null; auth: { type: string; item: string }; env: ({ var: string } & Ref)[];
  scope: { projects: "*" | string[]; agents: "*" | string[]; assistant: boolean }; command: string; args: string[]; url: string; policy: { allow?: string[]; deny?: string[]; mode: Record<string, Mode> } };

export function pickServers(d: unknown): Server[] {
  return (Array.isArray(d) ? d : []).filter((s) => isObj(s) && typeof s.name === "string").map((raw) => {
    const s = raw as Record<string, any>;
    const env = isObj(s.env) ? Object.entries(s.env).map(([k, v]) => ({ var: k, ...ref(v) })).filter((e) => e.item) : [];
    const mode = isObj(s.policy) && isObj(s.policy.mode) ? (Object.fromEntries(Object.entries(s.policy.mode).filter(([, m]) => ["read", "write", "off"].includes(String(m)))) as Record<string, Mode>) : {};
    return {
      name: s.name as string, transport: str(s.transport), state: STATE.has(s.state) ? (s.state as string) : "stopped", error: str(s.error), tools: num(s.tools), lastUsed: num(s.lastUsed),
      auth: { type: str(s.auth?.type) || "none", item: str(s.auth?.item) }, env,
      scope: { projects: s.scope?.projects === "*" || !Array.isArray(s.scope?.projects) ? "*" as const : strs(s.scope.projects), agents: s.scope?.agents === "*" || !Array.isArray(s.scope?.agents) ? "*" as const : strs(s.scope.agents),
        assistant: s.scope?.assistant === true && Array.isArray(s.scope?.agents) && s.scope.agents.length === 0 },
      command: str(s.command), args: strs(s.args), url: str(s.url),
      policy: { ...(Array.isArray(s.policy?.allow) ? { allow: strs(s.policy.allow) } : {}), ...(Array.isArray(s.policy?.deny) ? { deny: strs(s.policy.deny) } : {}), mode },
    };
  });
}

const AUTH_WORDS: Record<string, string> = { none: "None", bearer: "Bearer token", env: "Env vars", oauth: "OAuth", "service-account": "Service account" };
export function authWords(s: Server): string {
  if (s.auth.type === "env") return s.env.length ? s.env.map((e) => `${e.var} from ${e.item}${e.field ? `.${e.field}` : ""}`).join(", ") : "Env vars";
  if (s.auth.type === "none") return "None";
  return `${AUTH_WORDS[s.auth.type] || s.auth.type}, from ${s.auth.item}`;
}
const every = (v: "*" | string[], all: string, one: string) => (v === "*" ? all : v.length ? v.join(", ") : `No ${one}`);
export const serverScopeLine = (s: Server): string => (s.scope.assistant ? "Just you and the assistant" : `${every(s.scope.projects, "Every project", "project")}, ${every(s.scope.agents, "every agent", "agent")}`);
export const serverHow = (s: Server): string => (s.transport === "stdio" ? [s.command, ...s.args].join(" ") : s.url);
/** Every vault item a server uses. */
export const itemsOf = (s: Server): string[] => [...new Set([s.auth.item, ...s.env.map((e) => e.item)].filter(Boolean))];

export type Tested = { ok: boolean; ms: number; error: string; tools: { tool: string; outward: boolean; sends: boolean }[]; stderr: string[] };
export const pickTest = (d: unknown): Tested => {
  const o = (isObj(d) ? d : {}) as Record<string, unknown>;
  return { ok: o.ok === true, ms: num(o.ms) ?? 0, error: str(o.error), tools: list(o.tools).filter((t) => typeof t.tool === "string").map((t) => ({ tool: t.tool as string, outward: t.outward !== false, sends: t.sends === true })), stderr: strs(o.stderr).slice(-8) };
};

/** One row per tool for the mode picker: the tools mcp.test listed (read or held, from the hub's own classification) and the ones turned off, which the hub no longer lists. */
export function toolModes(tools: Tested["tools"], mode: Record<string, Mode> = {}): { tool: string; mode: Mode; sends: boolean }[] {
  const out = tools.map((t) => ({ tool: t.tool, mode: mode[t.tool] || (t.outward ? "write" as Mode : "read" as Mode), sends: t.sends }));
  for (const [tool, m] of Object.entries(mode)) if (m === "off" && !out.some((t) => t.tool === tool)) out.push({ tool, mode: "off", sends: false });
  return out.sort((a, b) => a.tool.localeCompare(b.tool));
}
export const MODE_WORDS: [Mode, string][] = [["read", "Read"], ["write", "Held"], ["off", "Off"]];
export const testedLine = (t: Tested, rows: number): string => `Answered in ${t.ms} ms with ${rows === 1 ? "one tool" : `${rows} tools`}. A held tool waits at the Gate for you before anything reaches the server.`;

/** Vault kinds that make sense for each way a server or account uses an item. */
export const ITEM_KINDS: Record<string, string[]> = { bearer: ["api-key", "secret"], env: ["api-key", "secret", "env-set"], oauth: ["env-set"], "service-account": ["note", "secret"], signin: ["env-set"] };
export type VaultItem = { name: string; kind: string; fields: string[]; grants: string[] };
export const pickItems = (d: unknown): VaultItem[] => list(Array.isArray(d) ? d : (d as { items?: unknown } | null)?.items).filter((x) => typeof x.name === "string" && x.state !== "trashed" && x.state !== "archived" && !x.trashed && !x.archived)
  .map((x) => ({ name: x.name as string, kind: str(x.kind) || "secret", fields: strs(x.fields), grants: list(x.grants).map((g) => str(g.module)).filter(Boolean) }));
export const itemsFor = (items: VaultItem[], type: string): VaultItem[] => items.filter((i) => (ITEM_KINDS[type] ?? []).includes(i.kind));

export type NewServer = { name: string; transport: "stdio" | "http"; command: string; args: string; url: string; auth: "none" | "bearer" | "env" | "oauth" | "service-account"; item: string; env: { var: string; item: string; field: string }[]; who: Who };
/** The input of mcp.add, or the first thing wrong in words. */
export function serverInput(n: NewServer): { input: Record<string, unknown> } | { error: string } {
  const name = n.name.trim();
  if (!name) return { error: "Give the server a name." };
  if (!/^[a-z0-9-]+$/.test(name)) return { error: "A name is lowercase letters, digits and dashes." };
  const input: Record<string, unknown> = { name, transport: n.transport };
  if (n.transport === "stdio") {
    if (!n.command.trim()) return { error: "Say the command that starts it." };
    input.command = n.command.trim();
    const a = n.args.trim();
    if (a) input.args = a.split(/\s+/);
  } else {
    if (!/^https?:\/\//i.test(n.url.trim())) return { error: "A web address that starts with https://." };
    input.url = n.url.trim();
  }
  if (n.auth === "env") {
    const env: Record<string, unknown> = {};
    for (const r of n.env) {
      const k = r.var.trim();
      if (!k && !r.item) continue;
      if (!k || !r.item) return { error: "Each variable needs a name and a vault item." };
      env[k] = r.field ? { item: r.item, field: r.field } : r.item;
    }
    if (!Object.keys(env).length) return { error: "Name at least one variable and its vault item, or choose None." };
    input.env = env;
    input.auth = { type: "env" };
  } else if (n.auth !== "none") {
    if (!n.item) return { error: "Choose the vault item this server uses." };
    input.auth = { type: n.auth, item: n.item };
  } else input.auth = { type: "none" };
  const scope = scopeOf(n.who);
  if (scope === undefined) return { error: "Choose at least one project." };
  if (scope) input.scope = scope;
  return { input };
}
/** The vault items a new server needs the module to be able to read. */
export const itemsNeeded = (input: Record<string, unknown>): string[] => {
  const a = (input.auth as { item?: string } | undefined)?.item;
  const env = Object.values((input.env as Record<string, string | { item: string }> | undefined) ?? {}).map((v) => (typeof v === "string" ? v : v.item));
  return [...new Set([a, ...env].filter((x): x is string => Boolean(x)))];
};

// ---- Google accounts ----

export type Account = { name: string; email: string; auth: { type: "oauth" | "service-account"; item: string; subject: string } };
export const pickAccounts = (d: unknown): Account[] => (Array.isArray(d) ? d : []).filter((a) => isObj(a) && typeof a.name === "string").map((raw) => {
  const a = raw as Record<string, any>;
  return { name: a.name as string, email: str(a.email), auth: { type: a.auth?.type === "service-account" ? "service-account" as const : "oauth" as const, item: str(a.auth?.item), subject: str(a.auth?.subject) } };
});
export const accountAuthLine = (a: Account): string => (a.auth.type === "service-account" ? `Service account acting as ${a.auth.subject || a.email}` : "OAuth");

export type GoogleTest = { ok: boolean; scopes: Record<string, boolean>; error: string; clientId: string; adminScopes: string };
export function pickGoogleTest(d: unknown): GoogleTest {
  const o = (isObj(d) ? d : {}) as Record<string, unknown>;
  const scopes: Record<string, boolean> = {};
  if (isObj(o.scopes)) for (const [k, v] of Object.entries(o.scopes)) scopes[k] = v === true;
  return { ok: o.ok === true, scopes, error: str(o.error),
    clientId: /^\d{5,30}$/.test(str(o.client_id)) ? str(o.client_id) : "",
    adminScopes: str(o.admin_scopes).split(",").filter((x) => /^https:\/\/www\.googleapis\.com\/auth\/[\w.]+$/.test(x)).join(",") };
}
export const scopeLines = (t: GoogleTest): { scope: string; ok: boolean }[] => Object.entries(t.scopes).map(([scope, ok]) => ({ scope, ok }));

export type NewAccount = { name: string; email: string; type: "service-account" | "oauth"; item: string; subject: string };
export function accountInput(n: NewAccount): { input: Record<string, unknown> } | { error: string } {
  if (!n.name.trim() || !n.email.trim()) return { error: "Give the account a name and its address." };
  if (!n.item) return { error: "Choose the vault item this account uses." };
  return { input: { name: n.name.trim(), email: n.email.trim(), auth: { type: n.type, item: n.item, ...(n.type === "service-account" && n.subject.trim() ? { subject: n.subject.trim() } : {}) } } };
}

// ---- GitHub ----

export type GithubAccount = { name: string; login: string; avatar: string };
export const pickGithub = (d: unknown): GithubAccount[] => (Array.isArray(d) ? d : []).filter((a) => isObj(a) && typeof a.name === "string").map((a) => ({ name: (a as { name: string }).name, login: str((a as any).login), avatar: str((a as any).avatar_url) }));
export type DeviceFlow = { id: string; code: string; uri: string; open: string; minutes: number };
/** github.connect's device-code answer, or null when GitHub sent no code. The link is only ever GitHub's own. */
export function deviceFlow(d: unknown): DeviceFlow | null {
  const o = (isObj(d) ? d : {}) as Record<string, unknown>;
  if (!str(o.id) || !str(o.user_code) || !str(o.verification_uri)) return null;
  return { id: str(o.id), code: str(o.user_code), uri: str(o.verification_uri), open: safeGithubUrl(o.verification_uri_complete || o.verification_uri), minutes: Math.max(1, Math.round((num(o.expires_in) || 900) / 60)) };
}
export type Repo = { full: string; name: string; private: boolean; description: string; updated: number | null };
export function pickRepos(d: unknown): { repos: Repo[]; more: boolean } {
  const o = d as { repos?: unknown; more?: unknown } | null;
  return { repos: list(o?.repos).filter((r) => typeof r.full_name === "string").map((r) => ({ full: r.full_name as string, name: str(r.name), private: r.private === true, description: str(r.description), updated: r.updated_at ? Date.parse(String(r.updated_at)) || null : null })), more: o?.more === true };
}

// ---- connections granted to surfaces (vault.connections.list) ----

export const SURFACES = ["capsule", "chat", "agents", "phone"] as const;
export const SURFACE_LABEL: Record<string, string> = { capsule: "Capsule", chat: "Chat", agents: "Agents", phone: "Phone" };
const PROVIDER: Record<string, string> = { "google-oauth": "Google", "google-dwd": "Google", "google-apps-script": "Apps Script", "imap-smtp": "Mail login", mcp: "MCP server" };
export type Conn = { id: string; provider: string; word: string; label: string; ready: boolean; needs: { module: string; need: string }[]; capabilities: string[]; surfaces: string[]; lastUsed: number | null };
export const pickConnections = (d: unknown): Conn[] => list(Array.isArray(d) ? d : (d as { connections?: unknown } | null)?.connections).filter((c) => typeof c.id === "string").map((c) => ({
  id: c.id as string, provider: str(c.provider), word: PROVIDER[str(c.provider)] ?? (str(c.provider) || "Connection"), label: str(c.label) || str(c.account), ready: c.state === "ready",
  needs: list(c.needs).map((n) => ({ module: str(n.module), need: str(n.need) })), capabilities: strs(c.capabilities), surfaces: SURFACES.filter((s) => Array.isArray(c.surfaces) && (c.surfaces as unknown[]).includes(s)), lastUsed: num(c.last_used),
}));

const MIN = 60_000;
export function since(t: number | null, now = Date.now()): string {
  if (!t) return "never";
  const m = Math.max(0, Math.floor((now - t) / MIN));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}
