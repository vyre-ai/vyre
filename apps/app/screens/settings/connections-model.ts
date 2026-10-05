// Settings, Connections (the Deck's deck/views/connections.js, ported): the MCP servers behind the hub, the Google accounts and the GitHub accounts Vyre can use.
// Only names ever reach the screen: mcp.servers, google.accounts and github.accounts carry vault item NAMES, never values, and the pickers below copy only the keys that are drawn.
// Pure: no calls.

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);
const isObj = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export type Mode = "read" | "write" | "off";
export type Server = {
  name: string; transport: string; state: "stopped" | "starting" | "running" | "failed"; error: string; tools: number | null; lastUsed: number | null;
  auth: { type: string; item: string }; env: { var: string; item: string; field: string }[];
  scope: { projects: "*" | string[]; agents: "*" | string[]; assistant: boolean };
  command: string; args: string[]; url: string; policy: { allow?: string[]; deny?: string[]; mode: Record<string, Mode> };
};
export type Tested = { ok: boolean; ms: number; error: string; tools: { tool: string; outward: boolean; sends: boolean }[]; stderr: string[] };
export type GoogleAccount = { name: string; email: string; auth: { type: "service-account" | "oauth"; item: string; subject: string } };
export type GoogleTested = { ok: boolean; scopes: Record<string, boolean>; error: string };
export type GithubAccount = { name: string; login: string; avatar_url: string };
export type GithubFlow = { id: string; name: string; user_code: string; verification_uri: string; verification_uri_complete?: string; minutes: number };

const STATES = ["stopped", "starting", "running", "failed"] as const;
const ref = (v: unknown): { item: string; field: string } => (typeof v === "string" ? { item: v, field: "" } : isObj(v) ? { item: str(v.item), field: str(v.field) } : { item: "", field: "" });

/** mcp.servers, as rows with only the fields drawn. */
export function pickServers(d: unknown): Server[] {
  return (Array.isArray(d) ? d : []).filter((s) => s && typeof s.name === "string").map((s: any): Server => {
    const env = isObj(s.env) ? Object.entries(s.env).map(([k, v]) => ({ var: k, ...ref(v) })).filter((e) => e.item) : [];
    const mode = isObj(s.policy) && isObj(s.policy.mode) ? (Object.fromEntries(Object.entries(s.policy.mode).filter(([, m]) => ["read", "write", "off"].includes(m as string))) as Record<string, Mode>) : {};
    return {
      name: s.name, transport: str(s.transport), state: (STATES as readonly string[]).includes(s.state) ? s.state : "stopped", error: str(s.error), tools: num(s.tools), lastUsed: num(s.lastUsed),
      auth: { type: str(s.auth?.type) || "none", item: str(s.auth?.item) }, env,
      scope: {
        projects: s.scope?.projects === "*" || !Array.isArray(s.scope?.projects) ? "*" : strs(s.scope.projects),
        agents: s.scope?.agents === "*" || !Array.isArray(s.scope?.agents) ? "*" : strs(s.scope.agents),
        // The connectors' default for a server nobody widened: no project's agents, only the person and the assistant.
        assistant: s.scope?.assistant === true && Array.isArray(s.scope?.agents) && s.scope.agents.length === 0,
      },
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
const scopeWords = (v: "*" | string[], every: string, one: string): string => (v === "*" ? every : v.length ? v.join(", ") : `No ${one}`);
export const scopeLine = (s: Server): string => (s.scope.assistant ? "Just you and the assistant" : `${scopeWords(s.scope.projects, "Every project", "project")} · ${scopeWords(s.scope.agents, "every agent", "agent")}`);
/** What starts the server: its command and arguments, or its address. */
export const runsLine = (s: Server): string => (s.url || [s.command, ...s.args].filter(Boolean).join(" "));
export const toolsLine = (s: Server): string => (s.tools === null ? "Not listed yet. Test lists them." : String(s.tools));

/** mcp.test's answer. */
export function pickTest(d: any): Tested {
  return {
    ok: d?.ok === true, ms: num(d?.ms) ?? 0, error: str(d?.error),
    tools: (Array.isArray(d?.tools) ? d.tools : []).filter((t: any) => t && typeof t.tool === "string").map((t: any) => ({ tool: t.tool, outward: t.outward !== false, sends: t.sends === true })),
    stderr: strs(d?.stderr).slice(-8),
  };
}

/**
 * The tools a test found, each with its mode: a tool that sends is held until set otherwise (outward) and never Read (the hub refuses it); a tool the person set Off stays listed.
 */
export function toolModes(tools: Tested["tools"], mode: Record<string, Mode> = {}): { tool: string; mode: Mode; set: boolean; sends: boolean }[] {
  const out = tools.map((t) => ({ tool: t.tool, mode: mode[t.tool] || (t.outward ? "write" : "read") as Mode, set: Boolean(mode[t.tool]), sends: Boolean(t.sends) }));
  for (const [tool, m] of Object.entries(mode)) if (m === "off" && !out.some((t) => t.tool === tool)) out.push({ tool, mode: "off", set: true, sends: false });
  return out.sort((a, b) => a.tool.localeCompare(b.tool));
}
export const MODE_WORDS: [Mode, string][] = [["read", "Read"], ["write", "Held"], ["off", "Off"]];
/** The mcp.update input that sets one tool's mode, keeping the rest of the policy. */
export const modeUpdate = (s: Server, tool: string, mode: Mode) => ({ name: s.name, tools: { ...s.policy, mode: { ...s.policy.mode, [tool]: mode } } });

/** google.accounts, as rows. */
export function pickAccounts(d: unknown): GoogleAccount[] {
  return (Array.isArray(d) ? d : []).filter((a) => a && typeof a.name === "string").map((a: any): GoogleAccount => ({
    name: a.name, email: str(a.email), auth: { type: a.auth?.type === "service-account" ? "service-account" : "oauth", item: str(a.auth?.item), subject: str(a.auth?.subject) },
  }));
}
export const googleAuthLine = (a: GoogleAccount): string => (a.auth.type === "service-account" ? `Service account acting as ${a.auth.subject || a.email}` : "OAuth");
/** google.test's answer: each scope granted or refused. */
export function pickGoogleTest(d: any): GoogleTested {
  const scopes: Record<string, boolean> = {};
  if (isObj(d?.scopes)) for (const [k, v] of Object.entries(d.scopes)) scopes[k] = v === true;
  return { ok: d?.ok === true, scopes, error: str(d?.error) };
}

/** github.accounts, as rows: name, login and avatar, never a token. */
export function pickGithubAccounts(d: unknown): GithubAccount[] {
  return (Array.isArray(d) ? d : []).filter((a) => a && typeof a.name === "string").map((a: any) => ({ name: a.name, login: str(a.login), avatar_url: str(a.avatar_url) }));
}
/** Only https://github.com/... ever becomes a link: verification_uri is GitHub's own reply, passed through unchecked otherwise. Anything else falls back to the plain device page, which always works with the code beside it. */
export const safeGithubUrl = (u: unknown): string => (/^https:\/\/github\.com\//.test(String(u || "")) ? String(u) : "https://github.com/login/device");
/** github.connect's answer for a device sign-in, or null when GitHub did not return a code. */
export function githubFlowOf(d: any, name: string): GithubFlow | null {
  const id = str(d?.id), user_code = str(d?.user_code), verification_uri = str(d?.verification_uri);
  if (!id || !user_code || !verification_uri) return null;
  return { id, name, user_code, verification_uri, ...(str(d?.verification_uri_complete) ? { verification_uri_complete: str(d.verification_uri_complete) } : {}), minutes: Math.max(1, Math.round((num(d?.expires_in) || 900) / 60)) };
}
/** The event that ends the open device sign-in, or null for any other event or another flow. */
export function githubEnd(e: { type?: string; payload?: any } | null | undefined, flowId: string): { ok: true } | { ok: false; error: string } | null {
  const p = isObj(e?.payload) ? e!.payload : {};
  if (p.id !== flowId) return null;
  if (e?.type === "github.connected") return { ok: true };
  if (e?.type === "github.connect-failed") return { ok: false, error: str(p.error) || "The sign-in ended without an account." };
  return null;
}
/** A module that is not running answers `missing`: say so rather than the raw refusal. */
export const errText = (e: { missing?: boolean; module?: string; message?: string } | string | null | undefined): string =>
  typeof e === "object" && e?.missing ? `The ${e.module} module is not running, so this cannot be changed here yet.` : String((typeof e === "object" ? e?.message : e) || "That did not go through.");
/** Who the plural of a repo count reads to. */
export const reachLine = (login: string, repos: number | null): string => (login ? `Connected ${login}${repos != null ? `, reaches ${repos} ${repos === 1 ? "repo" : "repos"}` : ""}` : "Connected the GitHub account.");

const SHAPES = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:rq_live|pk_live|sk_live|rk_live)_[A-Za-z0-9]{10,}\b/g, /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, /\b[A-Fa-f0-9]{40,}\b/g,
];
/** A message that may echo what the person typed (a pasted token) is shown with known secret shapes masked, in case the box or a vendor ever repeats it. */
export function redact(text: unknown, also: string[] = []): string {
  let s = String(text ?? "");
  for (const x of also) if (typeof x === "string" && x.length >= 6) s = s.split(x).join("[hidden]");
  for (const re of SHAPES) s = s.replace(re, (m) => (/^Bearer/i.test(m) ? "Bearer [hidden]" : "[hidden]"));
  return s;
}
