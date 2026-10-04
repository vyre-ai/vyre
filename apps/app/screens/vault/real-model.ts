// The pure half of Vault's real source: vault.list and vault.uses rows as the screen's items. Nothing here ever holds a value; a value
// exists only in the screen's state for REVEAL_MS after a person's own vault.reveal.

/** One item from vault.list (core/vault/vault.js list()). Names, kinds, field names and grants, never a value. */
export type ListRow = {
  name: string; kind: string; description: string; fields: string[]; url?: string; hosts: string[]; rotate: boolean; why?: string;
  updated: number; vault: string; unverified?: boolean; grants: { module: string; watcher?: string; project?: string }[];
};
/** One row from vault.uses (core/vault/agents.js uses()). */
export type UseRow = { at: number; action: string; item: string | null; who: string; origin?: string; surface?: string; ok: boolean };

export type Tab = "Login" | "Key" | "Card";
export type RealItem = { id: string; kind: string; tab: Tab; name: string; line: string; fields: string[]; unverified: boolean; rotate: boolean; grants: { who: string; project?: string }[] };

/** Logins and cards have their own tabs; every other kind (api keys, secrets, ssh keys, notes, env sets) is a Key. */
export const tabOf = (kind: string): Tab => (kind === "login" ? "Login" : kind === "card" ? "Card" : "Key");

const KIND_WORD: Record<string, string> = { login: "Login", card: "Card", "api-key": "API key", secret: "Secret", "ssh-key": "SSH key", note: "Note", "env-set": "Env set", authenticator: "Authenticator", passkey: "Passkey", identity: "Identity", address: "Address", wifi: "Wi-Fi" };
export const kindWord = (kind: string): string => KIND_WORD[kind] ?? kind;

/** The line under a name: what the person wrote, else where it is used, else the kind. */
export function lineOf(r: ListRow): string {
  const host = r.hosts[0] ?? (r.url ? r.url.replace(/^https?:\/\//, "").split("/")[0] : "");
  return r.description || host || kindWord(r.kind);
}

export function toItem(r: ListRow): RealItem {
  return {
    id: r.name, kind: r.kind, tab: tabOf(r.kind), name: r.name, line: lineOf(r), fields: r.fields, unverified: Boolean(r.unverified), rotate: r.rotate,
    grants: r.grants.map((g) => ({ who: g.watcher ? `${g.module}/${g.watcher}` : g.module, ...(g.project ? { project: g.project } : {}) })),
  };
}

export const itemsOf = (rows: ListRow[], tab: Tab): RealItem[] => rows.filter((r) => tabOf(r.kind) === tab).map(toItem);

const WORD: Record<string, string> = { reveal: "revealed", fill: "filled", "agent-fill": "filled for an agent", relay: "used through a relay", request: "used for a request", totp: "one-time code", copy: "copied", release: "released to a module", resolve: "read" };
export const actionWord = (a: string): string => WORD[a] ?? a;

const DAY = 86_400_000;
/** The last day's uses of one item, grouped by who and what, newest first. A refused use says so. */
export function usesLine(rows: UseRow[], now: number): { key: string; who: string; text: string; ok: boolean }[] {
  const by = new Map<string, { who: string; action: string; ok: boolean; times: number; last: number }>();
  for (const u of rows) {
    if (now - u.at > DAY) continue;
    const key = `${u.who}|${u.action}|${u.ok}`;
    const cur = by.get(key);
    if (cur) { cur.times += 1; cur.last = Math.max(cur.last, u.at); } else by.set(key, { who: u.who, action: u.action, ok: u.ok, times: 1, last: u.at });
  }
  return [...by.entries()].sort((a, b) => b[1].last - a[1].last).map(([key, v]) => ({
    key, who: v.who, ok: v.ok, text: `${actionWord(v.action)}${v.ok ? "" : ", refused"}, ${v.times} ${v.times === 1 ? "time" : "times"} today`,
  }));
}

/** The line under an item in the list: what it is, and how often it was used today. */
export function useCount(rows: UseRow[], now: number): number { return rows.filter((u) => now - u.at <= DAY && u.ok).length; }

/** The words a refused reveal gets, from the box's error code, never from a value. */
export function revealRefusal(code: string | undefined, message: string): string {
  if (code === "presence_required") return "That needs you. Approve on this device, then try again.";
  if (code === "locked") return "The vault is locked. Unlock it, then try again.";
  return message || "The vault did not answer.";
}

export type NewItem = { kind: "login" | "api-key" | "secret"; name: string; username: string; secret: string; url: string };
export const NEW_KINDS: [NewItem["kind"], string][] = [["login", "Login"], ["api-key", "API key"], ["secret", "Secret"]];

/** The host of a link the person typed, lower case, or "" when it is not one. */
export const hostOf = (url: string): string => { const m = /^(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?(?:[/?#]|$)/i.exec(url.trim()); return m ? m[1].toLowerCase() : ""; };

/** The input of vault.put for what the person typed, or the first thing wrong in words. A login needs the password and a name for it; a key or secret its value. */
export function putInput(n: NewItem): { input: Record<string, unknown> } | { error: string } {
  const name = n.name.trim();
  if (!name) return { error: "Give it a name." };
  if (!n.secret) return { error: n.kind === "login" ? "Type the password." : "Type the value." };
  if (n.kind === "login") {
    const host = hostOf(n.url);
    if (n.url.trim() && !host) return { error: "That is not a web address." };
    return { input: { name, kind: "login", fields: { ...(n.username.trim() ? { username: n.username.trim() } : {}), password: n.secret }, ...(host ? { url: n.url.trim(), hosts: [host] } : {}) } };
  }
  return { input: { name, kind: n.kind, fields: { value: n.secret } } };
}

/** The words for a refused add or unlock. */
export function putRefusal(code: string | undefined, message: string): string {
  if (code === "presence_required") return "That needs you. Approve on this device, then try again.";
  if (code === "denied" || code === "forbidden") return "This device may not add to the vault.";
  if (code === "locked" || code === "vault_locked") return "Unlock the vault first.";
  if (code === "bad_passphrase" || code === "wrong_passphrase") return "That passphrase is not right.";
  return message || "The vault did not answer.";
}
