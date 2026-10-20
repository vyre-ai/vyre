// AI accounts from sessions.accounts.list, the one source every row reads: one list of providers, each drawn the same way, with the accounts the person has under it, one line for each
// state, and the sign-in flow's steps. No provider comes first or gets a card of its own. Pure: no calls.
import { ACCOUNTS_COPY, PROVIDERS, keyKindOf, keyShapeOk } from "../first-run/ai-accounts-model.js";
import { KEY_ACCOUNTS } from "../../../../lib/ai-ids.js";
import { providerName as nameOf, providerVendor } from "../../ui/marks/provider.js";

export type Account = {
  id: string; provider: string; label: string; kind: string; isDefault: boolean; pending: boolean; needs: "sign-in" | "confirm" | null;
  signedIn: boolean; synthetic: boolean; who: string; item: string | null; baseUrl: string | null; privacy: boolean | null; privacyLabel: string; privacyNote: string;
  goOnly?: boolean; goOk?: boolean;
};
export type Flow = { id: string; step: string; url?: string; code?: string; message?: string; provider: string };
/** The kinds the server's key tool (sessions.accounts.key) takes. */
export type KeyKind = "anthropic-compatible" | "openrouter" | "openai-compatible" | "opencode";

/** The provider's display name: "codex" is "Codex", an unknown one is capitalised as given. */
export const providerName = (p: unknown): string => nameOf(String(p || ""));

/**
 * How each provider connects, as the server offers it: its own sign-in (core/sessions/signin.js LOGINS) and an API key (sessions.accounts.key's kinds). Codex's and Grok's keys are
 * OpenAI-style keys, so they go under OpenAI-compatible. A provider the app does not know yet has neither here and still shows its accounts.
 */
const CONNECT: Record<string, { signIn: boolean; key: KeyKind | null }> = {
  claude: { signIn: true, key: "anthropic-compatible" },
  codex: { signIn: true, key: null },
  grok: { signIn: true, key: null },
  openrouter: { signIn: false, key: "openrouter" },
  "openai-compatible": { signIn: false, key: "openai-compatible" },
  opencode: { signIn: false, key: "opencode" },
};

/** The providers in the order shown: the AI providers' own list (lib/ai-ids.js), then the two key-only ones, then any other a row names. The same order whether or not one is connected. */
export function providerOrder(rows: Account[]): string[] {
  const out: string[] = [...PROVIDERS, ...KEY_ACCOUNTS];
  for (const a of rows) if (!out.includes(a.provider)) out.push(a.provider);
  return out;
}

const KIND_WORDS: Record<string, string> = { login: "Signed in with the provider", "api-key": "API key", "setup-token": "Setup token" };

/** The words for a sign-in the server refuses because it is a computer that runs Claude on the login already on it (no separate account per person). */
export const serverCannotWords = (message: string): string | null =>
  /uses the login already on it/i.test(message) ? "This team's server is a computer that runs Claude on its own login, so it cannot hold a Claude account of yours. Ask the owner to run the team on a server, or run your session on your own computer." : null;
/** The server refuses a provider's own sign-in on a computer that runs that provider on the login already on it: the owner signs in there through the setup token instead. */
export const usesMachineLogin = (message: string): boolean => /uses the login already on it/i.test(message);

/** sessions.accounts.list's rows, reduced to what is drawn. */
export function accountsOf(d: any): Account[] {
  return (Array.isArray(d) ? d : Array.isArray(d?.accounts) ? d.accounts : [])
    .filter((a: any) => a && typeof a.id === "string" && typeof a.provider === "string")
    .map((a: any): Account => ({
      id: String(a.id), provider: String(a.provider), label: String(a.label || providerName(a.provider)), kind: String(a.kind || "login"),
      isDefault: a.is_default === true || a.default === true, pending: a.pending === true,
      needs: a.needs === "sign-in" || a.needs === "confirm" ? a.needs : null,
      signedIn: a.synthetic === true || a.signed_in_at != null || a.signed_in === true, synthetic: a.synthetic === true,
      who: [a.identity?.email, a.identity?.org].filter((x: unknown) => typeof x === "string" && x).join(", "),
      item: typeof a.vault_item === "string" && a.vault_item ? a.vault_item : null,
      baseUrl: typeof a.base_url === "string" && a.base_url ? a.base_url : null,
      privacy: typeof a.privacy === "boolean" ? a.privacy : null,
      privacyLabel: typeof a.privacy_label === "string" ? a.privacy_label : "", privacyNote: typeof a.privacy_note === "string" ? a.privacy_note : "",
      ...(a.provider === "opencode" ? { goOnly: a.go_only === true, goOk: a.go_ok === true } : {}),
    }));
}

/** Whether an account can run a turn now: not waiting on the person, not asking to sign in again, and signed in or holding its key. The server's own test (sessions' signedIn). */
export const usable = (a: Account): boolean => !a.pending && a.needs === null && (a.kind !== "login" || a.signedIn);

/** Who an account is, as a person reads it: the email its login left, else its name. The machine's own login is "this computer's sign-in". */
export const accountTitle = (a: Account): string => (a.synthetic ? "this computer's sign-in" : a.who || a.label);

/** One line for an account's state. */
export function stateWord(a: Account): string {
  if (a.needs === "confirm") return "Waiting for you to confirm it";
  if (a.needs === "sign-in") return "Needs signing in again";
  if (a.pending) return "Waiting for you to finish it";
  if (a.synthetic) return "Signed in on this computer";
  if (a.kind === "login") return a.signedIn ? (a.who ? `Signed in as ${a.who}` : "Signed in") : "Not signed in yet";
  return KIND_WORDS[a.kind] || a.kind;
}

export type ProviderBlock = {
  id: string; name: string; vendor: string; connected: boolean; status: string; accounts: Account[];
  /** What Connect offers: the provider's own sign-in first where one exists, an API key where keys are supported. */
  signIn: boolean; key: KeyKind | null;
};

/** The status of one provider from its accounts alone: "Connected as <who>", "Connected with N accounts", or "Not connected". */
export function providerStatus(accounts: Account[]): { connected: boolean; status: string } {
  const on = accounts.filter(usable);
  if (!on.length) return { connected: false, status: "Not connected" };
  if (on.length === 1) return { connected: true, status: `Connected as ${accountTitle(on[0])}` };
  return { connected: true, status: `Connected with ${on.length} accounts` };
}

/**
 * Every provider as one row, each drawn the same way, from sessions.accounts.list's rows and nothing else. A member keeps keys in their own Vault (the member key path, onboard.agent.key), so a member's key is added there and never through the owner's key shortcut.
 */
export function providerBlocks(rows: Account[], member = false): ProviderBlock[] {
  return providerOrder(rows).map((id) => {
    const accounts = rows.filter((a) => a.provider === id);
    const how = CONNECT[id] ?? { signIn: false, key: null };
    return { id, name: providerName(id), vendor: providerVendor(id), ...providerStatus(accounts), accounts, signIn: how.signIn, key: how.key };
  });
}

/** Whether a sign-in address is safe to open: https, no credentials, no whitespace. */
export const safeUrl = (u: unknown): boolean => {
  try {
    if (typeof u !== "string" || /[\s\\\u0000-\u001f]/.test(u)) return false;
    const x = new URL(u);
    return x.protocol === "https:" && !x.username && !x.password;
  } catch { return false; }
};

/** Whether an account row offers Sign in: a login that is not signed in, or one that says it needs it again. */
export const canSignIn = (a: Account): boolean => a.kind === "login" && !a.synthetic && (!a.signedIn || a.needs === "sign-in");
/** Make default is for the second account of a provider onward. */
export const canMakeDefault = (a: Account, rows: Account[]): boolean => !a.isDefault && rows.filter((r) => r.provider === a.provider).length > 1;
/** Replace key is for an API-key account whose key this app put in the Vault, of a kind the key tool checks. */
export const canReplaceKey = (a: Account): boolean => a.kind === "api-key" && Boolean(a.item) && Boolean(CONNECT[a.provider]?.key);

/**
 * "Use an API key" under one provider: the input the server's key tool takes (sessions.accounts.key), or the line to show. The kind is the provider's own; a key whose prefix says it belongs to
 * another provider is sent there instead of being added under the wrong one. OpenAI-compatible takes any key and an optional address (an xAI key goes to xAI's). The name is the one typed, else
 * "<Provider> key". The key is only passed on, never kept here.
 */
export function keyInputFor(provider: string, key: string, label = "", baseUrl = ""): { input: Record<string, string> } | { problem: string } {
  const k = String(key || "").trim();
  if (!keyShapeOk(k)) return { problem: "That does not look like an API key." };
  const kind = CONNECT[provider]?.key;
  if (!kind) return { problem: `${providerName(provider)} connects by signing in, not with a key.` };
  const seen = keyKindOf(k);
  if (kind === "opencode") {
    if (seen && seen.kind !== "opencode") return { problem: `That key is for ${providerName(seen.provider)}. Add it under ${providerName(seen.provider)}.` };
    if (String(baseUrl || "").trim()) return { problem: "OpenCode has one address." };
  } else if (kind !== "openai-compatible" && seen?.kind !== kind) return { problem: `That does not look like a ${providerName(provider)} key.` };
  else if (kind === "openai-compatible" && seen && seen.kind !== "openai-compatible") return { problem: `That key is for ${providerName(seen.provider)}. Add it under ${providerName(seen.provider)}.` };
  const base = String(baseUrl || "").trim() || (kind === "openai-compatible" ? seen?.base_url ?? "" : "");
  if (base && !safeUrl(base)) return { problem: "The address must start with https://." };
  const name = String(label || "").trim() || `${providerName(provider)} key`;
  if (name.length > 80 || /[\u0000-\u001f]/.test(name)) return { problem: ACCOUNTS_COPY.tooLong };
  return { input: { kind, key: k, label: name, name, ...(base ? { base_url: base } : {}) } };
}

/** What sessions.accounts.signin answered, as the flow the panel draws. */
export function flowOf(d: any, provider: string, id = ""): Flow {
  return {
    id: String(d?.flow || id), step: String(d?.step || "waiting"), provider,
    ...(typeof d?.url === "string" ? { url: d.url } : {}), ...(typeof d?.code === "string" ? { code: d.code } : {}), ...(typeof d?.message === "string" ? { message: d.message } : {}),
  };
}
/** The box holds each status call open, so the follow loop goes on only while the flow is waiting; a pasted code (step "url"), done and failed all end it. */
export const keepFollowing = (f: Flow): boolean => f.step !== "done" && f.step !== "failed" && f.step !== "url";

/** One fallback entry: a provider, maybe an account, maybe the model it runs. */
export type RouteEntry = { provider: string; account?: string; model?: string };
/** sessions.routes.get's entries for one scope, or none. */
export const routeEntries = (d: any): RouteEntry[] =>
  (Array.isArray(d?.entries) ? d.entries : Array.isArray(d) ? d : []).filter((e: any) => e && typeof e.provider === "string").map((e: any) => ({ provider: String(e.provider), ...(typeof e.account === "string" && e.account ? { account: e.account } : {}), ...(typeof e.model === "string" && e.model ? { model: e.model } : {}) }));

/** The account the Assistant uses first, from its own fallback order: the account, or null when it has no order of its own. */
export function assistantAccount(entries: RouteEntry[], rows: Account[]): Account | null {
  const first = entries[0];
  if (!first) return null;
  return rows.find((a) => a.id === first.account) ?? rows.find((a) => !first.account && a.provider === first.provider && a.isDefault) ?? null;
}

/**
 * The Assistant's order with `a` first. Another account of the same provider leaves the order, so the order never holds two accounts of one provider (which the server saves only after the person
 * has seen a warning about the vendor's terms); every other entry keeps its place.
 */
export const withFirst = (entries: RouteEntry[], a: Account): RouteEntry[] => [{ provider: a.provider, ...(a.synthetic ? {} : { account: a.id }) }, ...entries.filter((e) => e.provider !== a.provider)];
