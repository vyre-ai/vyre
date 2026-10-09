// The pure half of Vault's other pages on a real vyred: Passes (and what waits for the person), Shared with you, Devices, Watchtower and an item's history.
// Nothing here ever holds a value: these pickers copy only the keys they name, so a stray field in an answer cannot reach the screen. Wording is the Deck's.

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") as Record<string, unknown>[] : []);

export type Pass = { id: string; direction: "to" | "from"; holder: string; person: string; items: string[]; scope: string; service: string; hosts: string[]; mode: "sealed" | "relayed"; state: "waiting" | "active"; expires: number | string | null };
export type Pending = { id: string; kind: "grant" | "pass"; name: string; module: string; watcher: string; holder: string; items: string[]; mode: "sealed" | "relayed"; by: string; at: number | null };
export type Device = { id: string; name: string; created: number | null; lastSeen: number | null; revoked: number | null; sessions: number };
export type Health = { checked: number; counts: Record<string, number>; items: { name: string; kind: string; reasons: string[]; group: string }[] };
export type Version = { ver: number; at: number; fields: string[]; by: string };

/** vault.pass.list: passes given ("to") and held ("from"). A revoked one is not shown. */
export function pickPasses(d: unknown): Pass[] {
  const o = d as { passes?: unknown; held?: unknown } | unknown[] | null;
  const list: Record<string, unknown>[] = Array.isArray(o) ? arr(o)
    : [...arr(o?.passes).map((p) => ({ ...p, direction: p.direction || "to" })), ...arr(o?.held).map((p) => ({ ...p, direction: "from", holder: p.holder || p.owner }))];
  return list.filter((p) => typeof p.id === "string" || typeof p.id === "number").map((p) => ({
    id: String(p.id), direction: p.direction === "from" ? "from" as const : "to" as const, holder: str(p.holder), person: str(p.person), items: strs(p.items),
    scope: str(p.scope) || str(p.note), service: str(p.service), hosts: strs(p.hosts), mode: p.mode === "sealed" ? "sealed" as const : "relayed" as const,
    state: p.state === "waiting" || p.status === "pending" ? "waiting" as const : p.status === "revoked" || p.revoked ? ("revoked" as never) : "active" as const,
    expires: typeof p.expires === "number" || typeof p.expires === "string" ? p.expires : null,
  })).filter((p) => (p.state as string) !== "revoked");
}

/** vault.pending: the grants and passes waiting for the person. */
export function pickPending(d: unknown): Pending[] {
  const o = d as { grants?: unknown; passes?: unknown } | null;
  const grants = arr(o?.grants).map((g) => ({ id: str(g.id), kind: "grant" as const, name: str(g.name), module: str(g.module), watcher: str(g.watcher), holder: "", items: [] as string[], mode: "relayed" as const, by: str(g.by), at: num(g.at) }));
  const passes = arr(o?.passes).map((p) => ({ id: str(p.id), kind: "pass" as const, name: "", module: "", watcher: "", holder: str(p.holder), items: strs(p.items), mode: p.mode === "sealed" ? "sealed" as const : "relayed" as const, by: str(p.by), at: num(p.created) }));
  return [...grants, ...passes].filter((x) => x.id);
}

/** Who asked, as a name: an agent's name, "Claude" for an MCP client, else what the box said. */
export const whoAsked = (by: string): string => (by.includes("agent:") ? by.split("agent:")[1] : by.startsWith("mcp") ? "Claude" : by || "An agent");

/** The line for one waiting ask. */
export function waitingLine(x: Pending): string {
  const who = whoAsked(x.by);
  return x.kind === "grant" ? `${who} asked to let ${x.module}${x.watcher ? `/${x.watcher}` : ""} use ${x.name}` : `${who} asked to share ${x.items.join(", ")} with ${x.holder}, ${x.mode}`;
}

/** vault.devices: browsers paired for autofill. */
export function pickDevices(d: unknown): Device[] {
  return arr((d as { devices?: unknown } | null)?.devices).filter((x) => x.id).map((x) => ({
    id: String(x.id), name: str(x.name) || "A browser", created: num(x.created), lastSeen: num(x.lastSeen), revoked: num(x.revoked), sessions: num(x.sessions) || 0,
  }));
}

/** vault.health: what Watchtower found, by reason. */
export function pickHealth(d: unknown): Health {
  const o = d as { checked?: unknown; counts?: unknown; items?: unknown } | null;
  return {
    checked: num(o?.checked) ?? 0, counts: o?.counts && typeof o.counts === "object" ? (o.counts as Record<string, number>) : {},
    items: arr(o?.items).filter((i) => typeof i.name === "string").map((i) => ({ name: String(i.name), kind: str(i.kind), reasons: strs(i.reasons), group: str(i.group) })),
  };
}

/** Words for Watchtower's reason codes, in the order they are shown. */
export const REASON: Record<string, [string, string]> = {
  weak: ["Weak", "Easy to guess. Replace it with a generated one."],
  reused: ["Reused", "The same value is in more than one item."],
  rotate: ["Rotate", "Marked for rotation: a copy left this box."],
  old: ["Old", "Not changed for more than a year."],
  "2fa-available": ["Two-factor available", "This site offers one-time codes. Add the seed and Vyre makes them."],
  unprotected: ["Not yet protected", "Still opened without your password. Set one to move it to your personal vault."],
};
export const REASON_ORDER = ["weak", "reused", "rotate", "old", "2fa-available", "unprotected"];

/** Watchtower's groups: each reason that has items, with them; reused ones kept together by their group. */
export function healthGroups(h: Health): { code: string; title: string; why: string; rows: { name: string; kind: string; others: string[] }[] }[] {
  return REASON_ORDER.filter((c) => h.counts[c] && REASON[c]).map((code) => {
    const rows = h.items.filter((i) => i.reasons.includes(code));
    const ordered = code === "reused" ? [...rows].sort((a, b) => a.group.localeCompare(b.group)) : rows;
    return { code, title: `${REASON[code][0]}, ${rows.length}`, why: REASON[code][1],
      rows: ordered.map((i) => ({ name: i.name, kind: i.kind, others: code === "reused" ? rows.filter((x) => x.group === i.group && x.name !== i.name).map((x) => x.name) : [] })) };
  });
}

/** The Vault home's one line about health: how many items need attention and the biggest reasons, or nothing when all is well. Counts only; no name and no value. */
export function healthSummary(h: Health): { total: number; line: string } {
  const flagged = new Set(h.items.filter((i) => i.reasons.some((r) => REASON_ORDER.includes(r) && r !== "2fa-available")).map((i) => i.name));
  const parts = REASON_ORDER.filter((c) => c !== "2fa-available" && h.counts[c]).map((c) => `${h.counts[c]} ${REASON[c][0].toLowerCase()}`);
  const total = flagged.size;
  return { total, line: total ? `${total} ${total === 1 ? "item needs" : "items need"} attention: ${parts.join(", ")}.` : "" };
}

/** What a breach check answers: the names that appear in known breaches, and how many were checked. */
export function pickBreach(d: unknown): { checked: number; breached: string[] } {
  const o = d as { checked?: unknown; breached?: unknown } | null;
  return { checked: num(o?.checked) ?? 0, breached: strs(o?.breached) };
}
export const breachLine = (b: { checked: number; breached: string[] }): string =>
  b.breached.length ? `${b.breached.length} of ${b.checked} passwords appear in known breaches. Replace them.` : `None of ${b.checked} passwords appear in known breaches.`;

/** Whether this box may check breaches at all (vault.caps: breach is "ask" or "off"). */
export const pickCaps = (d: unknown): { reveal: boolean; breach: "ask" | "off"; host: string } => {
  const o = d as { reveal?: unknown; breach?: unknown; host?: unknown } | null;
  return { reveal: o?.reveal === true, breach: o?.breach === "ask" ? "ask" : "off", host: str(o?.host) };
};

/** vault.history: the versions of an item (what changed, who, when) and how many earlier passwords are kept sealed. */
export function pickHistory(d: unknown): { versions: Version[]; earlier: { count: number; last: number } | null } {
  const o = d as { versions?: unknown; passwords?: unknown } | null;
  const versions = arr(o?.versions).filter((v) => typeof v.at === "number").map((v) => ({ ver: Number(v.ver) || 0, at: v.at as number, fields: strs(v.fields), by: str(v.by) }));
  const pw = arr(o?.passwords).filter((v) => typeof v.at === "number").map((v) => v.at as number);
  return { versions, earlier: pw.length ? { count: pw.length, last: Math.max(...pw) } : null };
}

/** "module:gate" is "gate"; "cli" is "You, in a terminal". Plain words for who did it. */
export function whoWord(who: string): string {
  if (who.startsWith("module:")) return who.slice(7).split("/")[0];
  if (who.startsWith("pass:")) return who.split(":")[2] || "a pass";
  if (who === "cli") return "You, in a terminal";
  if (who === "deck" || who === "local" || who === "capsule") return "You";
  return who;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "3 Oct", with the year when it is not this one. */
export const dayWord = (t: number, now = Date.now()): string => { const d = new Date(t); return `${d.getDate()} ${MON[d.getMonth()]}${d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : ""}`; };

/** One version as a line: "v3, Changed password, You, 3 Oct". */
export const versionLine = (v: Version, now = Date.now()): string =>
  [`v${v.ver || "?"}`, v.fields.length ? `Changed ${v.fields.join(", ")}` : v.ver === 1 ? "Added" : "Changed", v.by ? whoWord(v.by) : "", dayWord(v.at, now)].filter(Boolean).join(", ");

/** "Until 31 Oct", "No end date", or what the pass said. */
export function expiryWord(e: number | string | null): string {
  if (e === null || e === "") return "No end date";
  const t = typeof e === "number" ? e : /^\d{4}-\d\d-\d\d/.test(String(e)) ? Date.parse(String(e)) : NaN;
  if (!Number.isFinite(t)) return String(e);
  const d = new Date(t);
  return `Until ${d.getDate()} ${MON[d.getMonth()]}`;
}

/** "today", "yesterday", "12 days ago", "3 months ago", "never". */
export function ago(t: number | null, now = Date.now()): string {
  if (!t) return "never";
  const d = Math.round((now - t) / 86400_000);
  return d < 1 ? "today" : d < 2 ? "yesterday" : d < 60 ? `${d} days ago` : d < 730 ? `${Math.round(d / 30)} months ago` : `${Math.round(d / 365)} years ago`;
}

/** A device's two lines: its state and its sessions. */
export function deviceLines(d: Device, now = Date.now()): { sub: string; sessions: string } {
  return d.revoked ? { sub: `Revoked ${ago(d.revoked, now)}`, sessions: "" }
    : { sub: `Paired ${ago(d.created, now)}, last seen ${ago(d.lastSeen, now)}`, sessions: d.sessions ? `${d.sessions} open ${d.sessions === 1 ? "session" : "sessions"}` : "Locked" };
}

/** A pass's row: who, what, how and until when. */
export function passLine(p: Pass): { title: string; sub: string; state: string } {
  return { title: `${p.direction === "to" ? "To" : "From"} ${p.holder}${p.person ? `, ${p.person}` : ""}`, sub: [p.items.join(", "), p.scope].filter(Boolean).join(", "),
    state: `${p.state === "waiting" ? "Waiting" : p.mode === "sealed" ? "Sealed" : "Relayed"}, ${expiryWord(p.expires).toLowerCase()}` };
}

/** Words for a refusal of one of these acts. A proof the person did not give is "Not done", never an error. */
export function refusalWord(e: { code?: string; message?: string }, done: string): string {
  if (e.code === "presence_refused" || e.code === "cancelled") return `Not ${done}. Nothing was sent.`;
  if (e.code === "presence_required" || e.code === "needs_presence") return "That needs you. Approve on this device, then try again.";
  if (e.code === "locked" || e.code === "vault_locked") return "The vault is locked. Unlock it first.";
  if (e.code === "no_such_tool") return "This server cannot do that from the app yet.";
  return e.message || "The vault did not answer.";
}

// ---- making a pass ----

export type NewPass = { holder: string; items: string[]; mode: "relayed" | "sealed"; expires: "7d" | "30d" | "90d" | "365d"; card: string; note: string; offHosts: string[] };
export const EXPIRES: ["7d" | "30d" | "90d" | "365d", string][] = [["7d", "7 days"], ["30d", "30 days"], ["90d", "90 days"], ["365d", "A year"]];

/** The input of vault.pass.create, or the first thing wrong in words. Hosts are narrowed only for a relayed pass that switched some off. */
export function passInput(n: NewPass, hostsOf: (item: string) => string[]): { input: Record<string, unknown> } | { error: string } {
  const holder = n.holder.trim();
  if (!holder) return { error: "Say who it is for." };
  if (!n.items.length) return { error: "Choose at least one item." };
  const hosts = [...new Set(n.items.flatMap(hostsOf))];
  const narrowed = hosts.filter((x) => !n.offHosts.includes(x));
  return { input: { holder, items: n.items, mode: n.mode, expires: n.expires, ...(n.card.trim() ? { card: n.card.trim() } : {}), ...(n.note.trim() ? { note: n.note.trim() } : {}),
    ...(n.mode === "relayed" && n.offHosts.length && narrowed.length ? { hosts: narrowed } : {}) } };
}

// ---- a pass for an outside agent (the Vault MCP) ----

export type NewMcpPass = { name: string; items: string[]; days: 7 | 30 | 90; budget: string; offHosts: string[]; reveal: boolean };
export const MCP_DAYS: [7 | 30 | 90, string][] = [[7, "7 days"], [30, "30 days"], [90, "90 days"]];

/** The input of vault.mcp.pass.create, or the first thing wrong in words. Only api credentials are used through a pass; hosts are narrowed only when some were switched off. */
export function mcpPassInput(n: NewMcpPass, hostsOf: (item: string) => string[]): { input: Record<string, unknown> } | { error: string } {
  const name = n.name.trim();
  if (!name) return { error: "Say who or what it is for." };
  if (!n.items.length) return { error: "Choose at least one credential." };
  const budget = n.budget.trim() ? Math.round(Number(n.budget)) : 0;
  if (n.budget.trim() && !(budget >= 1)) return { error: "The calls it may make is a whole number, or leave it empty." };
  const hosts = [...new Set(n.items.flatMap(hostsOf))];
  const narrowed = hosts.filter((x) => !n.offHosts.includes(x));
  if (hosts.length && !narrowed.length) return { error: "Leave at least one host switched on." };
  return { input: { name, items: n.items, days: n.days, ...(budget ? { budget } : {}), ...(n.offHosts.length ? { hosts: narrowed } : {}), ...(n.reveal ? { reveal: true } : {}) } };
}

/** What vault.mcp.pass.create answers, for the sheet: the token and the two lines are shown once. */
export function pickMcpMade(d: unknown): { token: string; claude: string; codex: string; expires: number | null; name: string } {
  const o = (d && typeof d === "object" ? d : {}) as { token?: unknown; name?: unknown; expires?: unknown; lines?: { claude?: unknown; codex?: unknown } };
  return { token: typeof o.token === "string" ? o.token : "", name: typeof o.name === "string" ? o.name : "", expires: typeof o.expires === "number" ? o.expires : null,
    claude: typeof o.lines?.claude === "string" ? o.lines.claude : "", codex: typeof o.lines?.codex === "string" ? o.lines.codex : "" };
}

export type Reveal = { id: string; item: string; pass: string; why: string };
/** vault.pending's mcpReveals: what an outside agent asked to see, waiting for the person. */
export function pickReveals(d: unknown): Reveal[] {
  const o = d as { mcpReveals?: unknown } | null;
  return arr(o?.mcpReveals).map((r) => ({ id: str(r.id), item: str(r.item), pass: str(r.pass), why: str(r.why) })).filter((r) => r.id);
}
/** The line a waiting ask reads as. */
export const revealLine = (r: Reveal): string => `${r.pass}'s agent asks to see ${r.item}${r.why ? `: ${r.why}` : ""}`;

/** What revoking a pass tells the person: sealed ones left a copy, so those items must be replaced. */
export const revokedLine = (holder: string, rotate: string[]): string => (rotate.length ? `Ended. Replace ${rotate.join(", ")}: they kept a sealed copy.` : `Ended. ${holder} cannot use it any more.`);

// ---- changing an item ----

export type EditInput = { name: string; description: string; was: string; replace: Record<string, string>; generate?: { field: string; length: number; symbols: boolean } | null };
/** The input of vault.update: only what changed. Values the person did not type stay exactly as they are. */
export function updateInput(e: EditInput): { input: Record<string, unknown> } | { error: string } {
  const fields = Object.fromEntries(Object.entries(e.replace).filter(([, v]) => v));
  const input: Record<string, unknown> = { name: e.name, ...(e.description.trim() !== e.was ? { description: e.description.trim() } : {}), ...(Object.keys(fields).length ? { fields } : {}),
    ...(e.generate ? { generate: { field: e.generate.field, length: Math.min(64, Math.max(8, Math.round(e.generate.length) || 24)), symbols: Boolean(e.generate.symbols) } } : {}) };
  if (Object.keys(input).length === 1) return { error: "Nothing changed." };
  if (e.generate && fields[e.generate.field]) return { error: `Type a new ${e.generate.field} or make one, not both.` };
  return { input };
}

/** The line after a save. */
export const savedLine = (name: string, generated?: string): string => (generated ? `Saved ${name}. A new ${generated} was made on your server.` : `Saved ${name}. The values are sealed on your server.`);

const NAME = /^[A-Za-z0-9._-]+$/;
/** An SSH key's name, or what is wrong with it. */
export const sshNameError = (name: string): string => (NAME.test(name) ? "" : "A name is letters, digits, dot, dash and underscore, with no spaces. Nothing was sent.");

// ---- Emergency access: a person you trust may ask, and after the wait the items open to them unless you deny it ----

export type EmergencyContact = { person: string; waitDays: number; state: "standby" | "waiting" | "denied" | "released"; requested: number | null; opens: number | null; denied: number | null; released: number | null; items: string };

/** vault.emergency.list: names, the wait and where a request stands. Only names and dates; the items are a sentence or a list of names, never a value. */
export function pickEmergency(d: unknown): EmergencyContact[] {
  return arr((d as { contacts?: unknown } | null)?.contacts).filter((c) => str(c.person)).map((c) => {
    const state = str(c.state);
    return {
      person: str(c.person), waitDays: Math.max(1, Math.round((num(c.wait_ms) ?? 7 * 86_400_000) / 86_400_000)),
      state: (state === "waiting" || state === "denied" || state === "released" ? state : "standby") as EmergencyContact["state"],
      requested: num(c.requested), opens: num(c.opens), denied: num(c.denied), released: num(c.released),
      items: Array.isArray(c.items) ? strs(c.items).join(", ") : str(c.items) || "every item except ssh keys and passkeys",
    };
  });
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** One plain line per contact: what they can do, and where a request stands. */
export function emergencyLine(c: EmergencyContact): { title: string; sub: string; canDeny: boolean } {
  const wait = `${c.waitDays} ${c.waitDays === 1 ? "day" : "days"}`;
  if (c.state === "released") return { title: c.person, sub: `Opened for them${c.released ? ` on ${day(c.released)}` : ""}. Remove them to end it.`, canDeny: false };
  if (c.state === "waiting") return { title: c.person, sub: `Asked${c.requested ? ` on ${day(c.requested)}` : ""}. It opens${c.opens ? ` on ${day(c.opens)}` : ` in ${wait}`} unless you deny it.`, canDeny: true };
  if (c.state === "denied") return { title: c.person, sub: `You denied their request${c.denied ? ` on ${day(c.denied)}` : ""}. They may ask again, and wait again.`, canDeny: false };
  return { title: c.person, sub: `Can ask. ${wait} after they ask, the items open to them unless you deny it.`, canDeny: false };
}

/** The wait choices the owner may pick: 1 to 30 days, 7 by default. */
export const EMERGENCY_WAITS: [string, string][] = [["1d", "1 day"], ["3d", "3 days"], ["7d", "7 days"], ["14d", "14 days"], ["30d", "30 days"]];

// ---- Two-factor codes: scan or paste, see what would come in, say yes once ----

/** The one-time-code addresses in what was pasted or scanned: otpauth:// and otpauth-migration:// only, each once, in order. Anything else is left out and counted. */
export function otpAddresses(text: string): { uris: string[]; ignored: number } {
  const seen = new Set<string>(), uris: string[] = [];
  let ignored = 0;
  for (const raw of String(text).split(/[\s,]+/)) {
    const t = raw.trim();
    if (!t) continue;
    if (!/^otpauth(-migration)?:\/\//i.test(t)) { ignored++; continue; }
    if (!seen.has(t)) { seen.add(t); uris.push(t); }
  }
  return { uris: uris.slice(0, 100), ignored };
}

export type CodesPlan = { add: string[]; added: string[]; same: string[]; renamed: { from: string; to: string }[]; skipped: string[]; missing: { of: number; parts: number[] }[] };

/** vault.codes.import: names only. A preview lists what would be added; an import lists what was. */
export function pickCodes(d: unknown): CodesPlan {
  const o = d as Record<string, unknown> | null;
  return { add: strs(o?.add), added: strs(o?.added), same: strs(o?.same), skipped: strs(o?.skipped),
    renamed: arr(o?.renamed).map((r) => ({ from: str(r.from), to: str(r.to) })).filter((r) => r.to),
    missing: arr(o?.missing).map((m) => ({ of: num(m.of) ?? 0, parts: Array.isArray(m.parts) ? (m.parts as unknown[]).filter((x): x is number => typeof x === "number") : [] })) };
}

/** The words for a preview or a result. */
export function codesLine(p: CodesPlan, preview: boolean): string {
  const n = preview ? p.add.length : p.added.length;
  const parts = [`${n} ${n === 1 ? "account" : "accounts"} ${preview ? "would be added" : "added"}`];
  if (p.same.length) parts.push(`${p.same.length} already here`);
  if (p.skipped.length) parts.push(`${p.skipped.length} could not be read`);
  const gap = p.missing[0];
  return parts.join(", ") + "." + (gap ? ` Scan the other ${gap.parts.length === 1 ? "part" : "parts"} too (${gap.parts.join(", ")} of ${gap.of}).` : "");
}

// ---- Shared vaults and the people Vyre shares with: names, roles and fingerprints; never a value ----

export type SharedVault = { id: string; name: string; role: string; members: { name: string; role: string; fingerprint: string }[]; items: { name: string; rotate: boolean }[]; conflicts: number };
export type Person = { name: string; fingerprint: string; verified: boolean; blocked: boolean };

export function pickVaults(d: unknown): SharedVault[] {
  return arr((d as { vaults?: unknown } | null)?.vaults).filter((v) => str(v.name)).map((v) => ({
    id: str(v.id) || str(v.name), name: str(v.name), role: str(v.role) || "member", conflicts: num(v.conflicts) ?? 0,
    members: arr(v.members).filter((m) => str(m.name)).map((m) => ({ name: str(m.name), role: str(m.role) || "member", fingerprint: str(m.fingerprint) })),
    items: arr(v.items).filter((i) => str(i.name)).map((i) => ({ name: str(i.name), rotate: Boolean(i.rotate) })),
  }));
}

export function pickPeople(d: unknown): Person[] {
  const list = Array.isArray(d) ? (d as unknown[]) : (d as { people?: unknown } | null)?.people;
  return arr(list).filter((p) => str(p.name)).map((p) => ({ name: str(p.name), fingerprint: str(p.fingerprint), verified: Boolean(p.verified), blocked: Boolean(p.blocked || p.changed) }));
}

const ROLE_WORD: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member", "read-only": "Read only" };
export const roleWord = (r: string): string => ROLE_WORD[r] ?? r;

/** One line per shared vault: how many people and items, and what needs attention. */
export function vaultLine(v: SharedVault): string {
  const n = v.members.length, i = v.items.length, rot = v.items.filter((x) => x.rotate).length;
  const parts = [`${n} ${n === 1 ? "person" : "people"}`, `${i} ${i === 1 ? "item" : "items"}`, `you are ${roleWord(v.role).toLowerCase()}`];
  if (rot) parts.push(`${rot} to rotate`);
  if (v.conflicts) parts.push(`${v.conflicts} ${v.conflicts === 1 ? "conflict" : "conflicts"} to settle`);
  return parts.join(", ");
}

/** One line per person: whether their card is checked. A changed key blocks new shares until it is verified again. */
export function personLine(p: Person): string {
  if (p.blocked) return "Their key changed. Check it with them before sharing anything new.";
  return p.verified ? "Card checked." : "Card pinned but not checked. Compare fingerprints with them before sharing.";
}
