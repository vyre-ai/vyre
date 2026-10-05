// The pure half of All settings: every key core/settings lists (settings.schema), with a control by its type and no other work per key (the Deck's settings-keys.js, ported).
// Account level only: the Project level, J and K, and the restart banner are not ported.

export type KeyDef = { key: string; group: string; label: string; help?: string; type: string; enum?: string[]; labels?: Record<string, string>; choices?: number[]; min?: number; max?: number; levels?: string[]; apply?: "live" | "session" | "restart"; advanced?: boolean; hidden?: boolean; default?: unknown };
export type KeyValue = { key: string; value?: unknown; source?: string; account?: unknown; available?: boolean; problem?: string };
export type Group = { id: string; label: string };
export type Schema = { keys: KeyDef[]; groups: Group[] };

/** When a change takes effect, as the row's line says. Live says nothing. */
export const APPLY: Record<string, string> = { live: "", session: "Next chat", restart: "After restart" };

/** The keys a person sees: those their module does not hide, with a group, and the groups that have one. */
export function schemaOf(data: any): Schema {
  const keys: KeyDef[] = (Array.isArray(data?.keys) ? data.keys : []).filter((k: KeyDef) => k && typeof k.key === "string" && k.hidden !== true);
  const groups: Group[] = (Array.isArray(data?.groups) ? data.groups : []).filter((g: Group) => g && keys.some((k) => k.group === g.id));
  return { keys, groups };
}

/** Which of the controls a key gets. Lists, objects and models have no editor here: they are shown, and changed where they were made. */
export type Control = "switch" | "segment" | "select" | "number" | "text" | "readonly";
export function controlOf(k: KeyDef): Control {
  if (k.type === "bool") return "switch";
  if (k.type === "enum") return (k.enum || []).length <= 4 ? "segment" : "select";
  if ((k.type === "int" || k.type === "number") && k.choices?.length) return "segment";
  if (k.type === "int" || k.type === "number") return "number";
  if (k.type === "string" || k.type === "text") return "text";
  return "readonly";
}
/** The choices of a segment or select as [value, label]. */
export function choicesOf(k: KeyDef): [string, string][] {
  if (k.type === "enum") return (k.enum || []).map((v) => [v, k.labels?.[v] || v]);
  return (k.choices || []).map((v) => [String(v), String(v)]);
}

/** A typed number for a key, or the line to show: whole for an int, inside its min and max. */
export function numberInput(k: KeyDef, raw: string): { value: number } | { problem: string } {
  const t = raw.trim();
  const n = Number(t);
  if (!t || !Number.isFinite(n)) return { problem: "That is not a number." };
  if (k.type === "int" && !Number.isInteger(n)) return { problem: "That is a whole number." };
  if (k.min != null && n < k.min) return { problem: `It is at least ${k.min}.` };
  if (k.max != null && n > k.max) return { problem: `It is at most ${k.max}.` };
  return { value: n };
}

/** What a key holds, in words: a switch is On or Off, a list its items. */
export function valueLine(k: KeyDef, v: unknown): string {
  if (v === undefined || v === null || v === "") return "Not set";
  if (typeof v === "boolean") return v ? "On" : "Off";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "None";
  if (typeof v === "object") return JSON.stringify(v);
  return k.labels?.[String(v)] || String(v);
}

/** Reset goes back to the default when the key has been set on the account. */
export const canReset = (v: KeyValue | undefined): boolean => !!v && v.account !== undefined;
/** The chip on a row: only when its value is not the default. */
export const sourceLine = (v: KeyValue | undefined): string => (v?.source === "account" ? "Changed" : "");

/** The keys that match what was typed in Find (label or key), and are not advanced unless asked, grouped in the schema's order. */
export function visible(s: Schema, find: string, advanced: boolean): { group: Group; keys: KeyDef[] }[] {
  const q = find.trim().toLowerCase();
  return s.groups.map((group) => ({
    group,
    keys: s.keys.filter((k) => k.group === group.id && (!k.levels || k.levels.includes("account")) && (advanced || !k.advanced || !!q) && (!q || k.label.toLowerCase().includes(q) || k.key.toLowerCase().includes(q))),
  })).filter((g) => g.keys.length);
}

/** The box's words for a refusal, in the person's. */
export function refusal(e: unknown): string {
  const m = e instanceof Error ? e.message : "";
  if (/no passkey is enrolled/.test(m)) return "This needs your passkey, and none is set up yet. Add one under Account and recovery, then try again.";
  return m || "That did not go through.";
}
