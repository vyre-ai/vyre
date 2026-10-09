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
export type RealItem = { id: string; kind: string; tab: Tab; name: string; title: string; line: string; fields: string[]; unverified: boolean; rotate: boolean; grants: { who: string; project?: string }[] };

/** Logins and cards have their own tabs; every other kind (api keys, secrets, ssh keys, notes, env sets) is a Key. */
export const tabOf = (kind: string): Tab => (kind === "login" ? "Login" : kind === "card" ? "Card" : "Key");

const KIND_WORD: Record<string, string> = { login: "Login", card: "Card", "api-key": "API key", secret: "Secret", "ssh-key": "SSH key", note: "Note", "env-set": "Env set", authenticator: "Authenticator", passkey: "Passkey", identity: "Identity", address: "Address", wifi: "Wi-Fi" };
export const kindWord = (kind: string): string => KIND_WORD[kind] ?? kind;

/** A name as a person reads it: the vault keeps letters, digits, dot, dash and underscore, so "Airline-account" is shown as "Airline account". The name itself is still what every action sends. */
export const displayName = (name: string): string => name.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();

/** A site as a person reads it: the host, with no scheme or path. */
export const hostWord = (h: string): string => h.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "").replace(/^www\./, "");

/** The line under a name: what the person wrote, else where it is used, else the kind. */
export function lineOf(r: ListRow): string {
  const host = hostWord(r.hosts[0] ?? r.url ?? "");
  return r.description || host || kindWord(r.kind);
}

export function toItem(r: ListRow): RealItem {
  return {
    id: r.name, kind: r.kind, tab: tabOf(r.kind), name: r.name, title: displayName(r.name), line: lineOf(r), fields: r.fields, unverified: Boolean(r.unverified), rotate: r.rotate,
    grants: r.grants.map((g) => ({ who: g.watcher ? `${g.module}/${g.watcher}` : g.module, ...(g.project ? { project: g.project } : {}) })),
  };
}

export const itemsOf = (rows: ListRow[], tab: Tab): RealItem[] => rows.filter((r) => tabOf(r.kind) === tab).map(toItem);

/**
 * Find items by what the person remembers: part of the name, the note, the site it is for, or the kind ("card", "api key"). Every word typed must match somewhere; names first, then the rest, each in
 * name order. Matches across all tabs. Only names, notes, hosts and kinds are searched: never a value.
 */
export function searchItems(rows: ListRow[], query: string): RealItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored = rows.map((r) => {
    const name = r.name.toLowerCase(), rest = [r.description, ...r.hosts, r.url ?? "", kindWord(r.kind), r.kind].join(" ").toLowerCase();
    const all = words.every((w) => name.includes(w) || rest.includes(w));
    return { r, all, byName: words.every((w) => name.includes(w)) };
  }).filter((x) => x.all);
  scored.sort((a, b) => Number(b.byName) - Number(a.byName) || a.r.name.localeCompare(b.r.name));
  return scored.map((x) => toItem(x.r));
}

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
/** The wait a lock-out names, from the box's `retry_after_s`: seconds under a minute, else whole minutes rounded up. */
export function waitWords(seconds: number | undefined): string {
  const n = Math.max(1, Math.ceil(Number(seconds) || 0));
  if (n < 60) return `${n} ${n === 1 ? "second" : "seconds"}`;
  const m = Math.ceil(n / 60);
  return `${m} ${m === 1 ? "minute" : "minutes"}`;
}

/** The words for an unlock of the personal vault from the phone, by code (vault, 078bfd7e8). Only our own sentences: the server's text is never shown. */
export function personalUnlockRefusal(code: string | undefined, detail?: { retry_after_s?: number }): string {
  if (code === "presence_required") return "That needs you. Approve on this device, then try again.";
  if (code === "wrong_password") return "That is not the password for this vault. It is still locked.";
  if (code === "throttled") return `Too many wrong passwords. Even the right one is refused for now. Try again in ${waitWords(detail?.retry_after_s)}.`;
  if (code === "no_account") return "This vault has no account password yet, so there is no personal vault to open.";
  if (code === "no_secret_key") return "This server does not have your account's Secret Key, so it cannot open the personal vault. You need your recovery kit.";
  if (code === "wrong_account") return "The Secret Key on this server belongs to another account. Nothing was changed.";
  if (code === "denied" || code === "not_available" || code === "no_such_tool" || code === "not_found") return "This server cannot unlock it from a phone yet.";
  return "The personal vault did not open. Nothing was changed.";
}

export function revealRefusal(code: string | undefined, message: string, how: "phone" | "touchid" | "browser" = "browser"): string {
  if (code === "presence_required") return "That needs you. Approve on this device, then try again.";
  if (code === "locked") return "The vault is locked. Enter its passphrase to open it, then try again.";
  // A release server takes an approval only from a phone key it can verify (vault, 5 Oct): until that check exists no phone can give it, and "approve on your phone" would send the person in a circle.
  // By method (lead, 4 Oct): the file key a browser or daemon holds is not a presence method on a release server. Say the method the person has.
  if (code === "software_key") {
    if (how === "phone") return "This server cannot accept an approval from this phone yet. Nothing was revealed or changed.";
    return how === "touchid" ? "Approve this with Touch ID. This key cannot approve it by itself." : "Approve this in Vyre on your phone. This browser cannot approve it by itself.";
  }
  return message || "The vault did not answer.";
}

export type NewItem = { kind: "login" | "api-key" | "secret"; name: string; username: string; secret: string; url: string };
export const NEW_KINDS: [NewItem["kind"], string][] = [["login", "Login"], ["api-key", "API key"], ["secret", "Secret"]];

/** The host of a link the person typed, lower case, or "" when it is not one. */
export const hostOf = (url: string): string => { const m = /^(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?(?:[/?#]|$)/i.exec(url.trim()); return m ? m[1].toLowerCase() : ""; };

/** What is wrong with a new item, field by field, in words the person can act on: every required field that is empty, shown under that field (never left to the browser's own bubble). */
export function putProblems(n: NewItem): Partial<Record<"name" | "username" | "secret" | "url", string>> {
  const out: Partial<Record<"name" | "username" | "secret" | "url", string>> = {};
  if (!n.name.trim()) out.name = "Give it a name.";
  if (n.kind === "login" && !n.username.trim()) out.username = "Type the username.";
  if (!n.secret) out.secret = n.kind === "login" ? "Type the password." : "Type the value.";
  if (n.kind === "login" && n.url.trim() && !hostOf(n.url)) out.url = "That is not a web address.";
  return out;
}

/** The input of vault.put for what the person typed, or the first thing wrong in words (putProblems has every one, by field). A login needs the username and the password and a name; a key or secret its value. */
export function putInput(n: NewItem): { input: Record<string, unknown> } | { error: string } {
  const first = Object.values(putProblems(n))[0];
  if (first) return { error: first };
  const name = n.name.trim();
  if (n.kind === "login") {
    const host = hostOf(n.url);
    return { input: { name, kind: "login", fields: { username: n.username.trim(), password: n.secret }, ...(host ? { url: n.url.trim(), hosts: [host] } : {}) } };
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
