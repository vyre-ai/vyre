import { dayOf } from "../../src/time/show.js";
// The pure half of Kits on the real box: flows.kit.list rows (kernel/flows/kits.js list) as the lines the screen shows. The box has no catalog of Kits to install
// from, so there is no "available" list here, and the update diff is the kernel's own (flows.kit.diff), never one made up here.

export type KitRow = { id: string; version: number; status: string; by?: string; at?: number };

/** One Kit the box offers, from records/kits/library.js: what it adds, in counts the person can read. */
export type LibraryKit = { id: string; name?: string; version?: number; description?: string; adds?: { types?: unknown[]; templates?: unknown[]; roles?: unknown[]; flows?: unknown[]; views?: unknown[]; sealed_fields?: unknown[] } };

const STATUS: Record<string, string> = { installed: "Installed", removed: "Removed", pending: "Waiting for a yes", failed: "Failed" };
export const statusWord = (s: string): string => STATUS[s] ?? s;

/** "estate-planning" is "Estate planning". */
export const kitName = (id: string): string => { const t = id.replace(/[-_]+/g, " ").trim(); return t ? t[0].toUpperCase() + t.slice(1) : id; };

/** The line under a Kit: its version, who put it in, and when. */
export function kitLine(k: KitRow): string {
  const when = k.at ? dayOf(new Date(k.at).getTime()) : "";
  return [`v${k.version}`, k.by ? `by ${k.by}` : "", when].filter(Boolean).join(" · ");
}

/** Installed ones first, then the rest; a removed Kit is not listed. */
export const listed = (rows: KitRow[]): KitRow[] => rows.filter((k) => k.status !== "removed").sort((a, b) => Number(b.status === "installed") - Number(a.status === "installed") || kitName(a.id).localeCompare(kitName(b.id)));

export function kitRefusal(code: string | undefined, message: string): string {
  if (code === "unknown_action") return "This box cannot install Kits yet. It will once it is updated.";
  if (code === "chain_not_person") return "Only a person removes a Kit, not an assistant.";
  if (code === "presence_required") return "That needs you. Approve on this device, then try again.";
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

// ------------------------------------------------------------------------------------------------------------------------------------ update diff

type Part = { kind: string; name: string };
/** What flows.kit.diff answers (kernel/flows/kits.js diff): the installed version against a newer one, read only. */
export type KitDiff = { installed: boolean; from: number | null; to: number; newer: boolean; diff: null | { added: Part[]; removed: Part[]; changed: Part[]; widenings: { part: string; what: string }[]; risks: { part: string; what: string }[]; widening: boolean } };

/** The Kits installed whose library version is newer: id to the version on offer. A Kit that is removed or pending is not offered an update. */
export function updatesOf(rows: KitRow[], lib: LibraryKit[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.status !== "installed") continue;
    const l = lib.find((k) => k.id === r.id);
    if (l && typeof l.version === "number" && l.version > r.version) out[r.id] = l.version;
  }
  return out;
}

const KIND_WORD: Record<string, string> = { type: "Record type", flow: "Flow", template: "Template", role: "Role", teammate: "Assistant", view: "View" };
const partText = (p: Part): string => `${KIND_WORD[p.kind] ?? p.kind} ${p.name}`;

/** The diff as lines for the diff block: a plus for a part added, a minus for one removed, a plain line for one changed. */
export function diffLines(d: KitDiff): { t: "a" | "d" | "c"; s: string }[] {
  const x = d.diff;
  if (!x) return [];
  return [
    ...x.added.map((p) => ({ t: "a" as const, s: partText(p) })),
    ...x.changed.map((p) => ({ t: "c" as const, s: `${partText(p)} changes` })),
    ...x.removed.map((p) => ({ t: "d" as const, s: partText(p) })),
  ];
}

/** "What it can do that it could not before" and the risks, as plain lines. */
export const widenings = (d: KitDiff): { part: string; what: string }[] => d.diff?.widenings ?? [];
export const risks = (d: KitDiff): { part: string; what: string }[] => d.diff?.risks ?? [];

/** The sub line under an update page's title. */
export const versionLine = (d: KitDiff): string => (d.from == null ? `Not installed. v${d.to} is on offer.` : d.newer ? `v${d.from} to v${d.to}` : `v${d.from} is the newest this box has.`);

/** True when there is something to approve: newer, and the box found a difference. */
export const hasChanges = (d: KitDiff): boolean => d.installed && d.newer && !!d.diff && (d.diff.added.length + d.diff.removed.length + d.diff.changed.length > 0 || d.diff.widenings.length > 0);

/** The installed Kits as rows of a list block: Update (when a newer one is on offer) and a held Remove; one that is not installed yet shows where it stands. */
export const installedRows = (shown: KitRow[], newer: Record<string, number>) => shown.map((k) => ({
  id: k.id, title: kitName(k.id), subtitle: kitLine(k), icon: "kits",
  ...(k.status === "installed" ? { actions: [...(newer[k.id] ? [{ id: "update", title: `Update to v${newer[k.id]}`, kind: "primary" }] : []), { id: "remove", title: "Remove", kind: "hold" }] } : { accessories: [{ label: statusWord(k.status) }] }),
}));
/** The Kits on offer as rows: one action, Read the card. */
export const availableRows = (offer: LibraryKit[], loadingCard: string) => offer.map((k) => ({
  id: k.id, title: k.name ?? kitName(k.id), subtitle: [k.description, addsLine(k)].filter(Boolean).join(" · "), icon: "kits",
  actions: [{ id: "read", title: loadingCard === k.id ? "Reading" : "Read the card", kind: "primary" }],
}));
