// AI accounts from sessions.accounts.list (the Deck's settings-accounts.js, ported): the rows as drawn, the one line for each state, and the sign-in flow's steps. Pure: no calls.

export type Account = {
  id: string; provider: string; label: string; kind: string; isDefault: boolean; pending: boolean; needs: "sign-in" | "confirm" | null;
  signedIn: boolean; synthetic: boolean; who: string; item: string | null; privacy: boolean | null; privacyLabel: string; privacyNote: string;
};
export type Flow = { id: string; step: string; url?: string; code?: string; message?: string; provider: string };

const NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", grok: "Grok", openrouter: "OpenRouter" };
/** The provider's display name: "codex" is "Codex", an unknown one is capitalised as given. */
export const providerName = (p: unknown): string => {
  const k = String(p || "").toLowerCase();
  return NAMES[k] || (k ? k[0].toUpperCase() + k.slice(1) : "");
};

const KIND_WORDS: Record<string, string> = { login: "Signed in with the provider", "api-key": "API key", "setup-token": "Setup token" };
/** Providers a person can add by signing in from here. Claude signs in on the machine it runs on (the Claude card above), so it is not offered. */
export const ADDABLE: readonly string[] = Object.freeze(["codex", "grok"]);

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
      privacy: typeof a.privacy === "boolean" ? a.privacy : null,
      privacyLabel: typeof a.privacy_label === "string" ? a.privacy_label : "", privacyNote: typeof a.privacy_note === "string" ? a.privacy_note : "",
    }));
}

/** One line for an account's state. */
export function stateWord(a: Account): string {
  if (a.needs === "confirm") return "Waiting for you to confirm it";
  if (a.needs === "sign-in") return "Needs signing in again";
  if (a.pending) return "Waiting for you to finish it";
  if (a.synthetic) return "Signed in on this machine";
  if (a.kind === "login") return a.signedIn ? (a.who ? `Signed in as ${a.who}` : "Signed in") : "Not signed in yet";
  return KIND_WORDS[a.kind] || a.kind;
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

/** What sessions.accounts.signin answered, as the flow the panel draws. */
export function flowOf(d: any, provider: string, id = ""): Flow {
  return {
    id: String(d?.flow || id), step: String(d?.step || "waiting"), provider,
    ...(typeof d?.url === "string" ? { url: d.url } : {}), ...(typeof d?.code === "string" ? { code: d.code } : {}), ...(typeof d?.message === "string" ? { message: d.message } : {}),
  };
}
/** The box holds each status call open, so the follow loop goes on only while the flow is waiting; a pasted code (step "url"), done and failed all end it. */
export const keepFollowing = (f: Flow): boolean => f.step !== "done" && f.step !== "failed" && f.step !== "url";
