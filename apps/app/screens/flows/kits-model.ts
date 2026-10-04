// The pure half of Kits on the real box: flows.kit.list rows (kernel/flows/kits.js list) as the lines the screen shows. The box has no catalog of Kits to install
// from, so there is no "available" list here, and no update diff: both would be invented.

export type KitRow = { id: string; version: number; status: string; by?: string; at?: number };

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
