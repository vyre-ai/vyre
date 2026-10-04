// The pure half of Kits on the real box: flows.kit.list rows (kernel/flows/kits.js list) as the lines the screen shows. The box has no catalog of Kits to install
// from, so there is no "available" list here, and no update diff: both would be invented.

export type KitRow = { id: string; version: number; status: string; by?: string; at?: number };

/** One Kit the box offers, from records/kits/library.js: what it adds, in counts the person can read. */
export type LibraryKit = { id: string; name?: string; version?: number; description?: string; adds?: { types?: unknown[]; templates?: unknown[]; roles?: unknown[]; flows?: unknown[]; views?: unknown[]; sealed_fields?: unknown[] } };

const STATUS: Record<string, string> = { installed: "Installed", removed: "Removed", pending: "Waiting for a yes", failed: "Failed" };
export const statusWord = (s: string): string => STATUS[s] ?? s;

/** "estate-planning" is "Estate planning". */
export const kitName = (id: string): string => { const t = id.replace(/[-_]+/g, " ").trim(); return t ? t[0].toUpperCase() + t.slice(1) : id; };

/** The line under a Kit: its version, who put it in, and when. */
export function kitLine(k: KitRow): string {
  const when = k.at ? new Date(k.at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "";
  return [`v${k.version}`, k.by ? `by ${k.by}` : "", when].filter(Boolean).join(" · ");
}

/** Installed ones first, then the rest; a removed Kit is not listed. */
export const listed = (rows: KitRow[]): KitRow[] => rows.filter((k) => k.status !== "removed").sort((a, b) => Number(b.status === "installed") - Number(a.status === "installed") || kitName(a.id).localeCompare(kitName(b.id)));

export function kitRefusal(code: string | undefined, message: string): string {
  if (code === "chain_not_person") return "Only a person removes a Kit, not an assistant.";
  if (code === "presence_required") return "That needs you. Approve with Face ID or your fingerprint, then try again.";
  if (code === "not_found") return "That Kit is already gone.";
  return message || "Kits did not answer.";
}

/** The Kits offered and not already in the space. */
export const available = (lib: LibraryKit[], rows: KitRow[]): LibraryKit[] => lib.filter((k) => !rows.some((r) => r.id === k.id && (r.status === "installed" || r.status === "pending")));

/** "2 types, 1 Flow, 3 templates": what a Kit adds, from the counts in the library entry. */
export function addsLine(k: LibraryKit): string {
  const a = k.adds ?? {};
  const part = (n: number | undefined, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : "");
  return [part(a.types?.length, "type", "types"), part(a.flows?.length, "Flow", "Flows"), part(a.templates?.length, "template", "templates"), part(a.roles?.length, "role", "roles"), part(a.views?.length, "view", "views"), part(a.sealed_fields?.length, "sealed field", "sealed fields")].filter(Boolean).join(", ");
}

/** What propose answered, in words: waiting for a yes, or the first reason the Kit cannot be installed. */
export function proposeNote(r: { ok?: boolean; errors?: { path: string; message: string }[] }): { ok: boolean; text: string } {
  if (r?.ok === false) return { ok: false, text: r.errors?.[0] ? `${r.errors[0].path}: ${r.errors[0].message}` : "The Kit cannot be installed." };
  return { ok: true, text: "Waiting for your yes in Now. Nothing is installed until you approve it." };
}

type Card = { kit?: { name?: string; version?: number; description?: string }; ok?: boolean; errors?: { path: string; message: string }[]; adds?: Record<string, any>; notes?: string[] };

/** The install card (kits.card) as lines a person reads before saying yes: each part by name, then the cautions the kernel wrote. */
export function cardLines(card: Card): { head: string; lines: string[]; notes: string[]; blocked: string } {
  const a = card.adds ?? {};
  const names = (xs: any[] | undefined, pick: (x: any) => string) => (Array.isArray(xs) ? xs.map(pick) : []);
  const lines = [
    ...names(a.types, (t) => `Record type ${t.label || t.name}, ${t.fields} fields${t.sealed?.length ? `, ${t.sealed.length} sealed` : ""}`),
    ...names(a.flows, (f) => `Flow ${f.label || f.name}${f.outward?.length ? ", sends or publishes" : ""}${f.code?.length ? ", runs code" : ""}`),
    ...names(a.templates, (t) => `Template ${t.name}`),
    ...names(a.roles, (r) => `Role ${r.name}`),
    ...names(a.teammates, (t) => `Assistant ${t.name}`),
    ...names(a.views, (v) => `View ${String(v)}`),
  ];
  const k = card.kit ?? {};
  return { head: [k.name, k.version ? `v${k.version}` : ""].filter(Boolean).join(" "), lines, notes: card.notes ?? [], blocked: card.ok === false ? card.errors?.[0]?.message ?? "This Kit does not pass the box's checks." : "" };
}
