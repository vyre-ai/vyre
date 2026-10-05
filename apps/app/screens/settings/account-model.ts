import { dayOf } from "../../src/time/show.js";
// The pure half of Account, What my assistants can see and Privacy on the real box: spaces.identity.* answers and the sealed fields of records.types as lines.

export type Identity = { exists: boolean; name?: string; label?: string; id?: string; pending?: boolean };
export type Entry = { eid: string; kind: "device" | "code" | "contact" | string; label: string | null; since: number; self: boolean; newcomer: boolean };
export type TypeDef = { name: string; label?: string; fields: { name: string; label?: string; kind: string; seal?: unknown }[] };

const WAY: Record<string, string> = { device: "Device", code: "Recovery code", contact: "Recovery contact" };
const day = (ms: number) => dayOf(ms);

/** The sign-in methods people use every day: the devices on the list. The newest sign-in says so for 24 hours. */
export const devices = (es: Entry[]): Entry[] => es.filter((e) => e.kind === "device");
export const contacts = (es: Entry[]): Entry[] => es.filter((e) => e.kind === "contact");
export const hasCode = (es: Entry[]): boolean => es.some((e) => e.kind === "code");

export function entryTitle(e: Entry): string { return e.label || (e.kind === "device" ? (e.self ? "This device" : "A device") : WAY[e.kind] ?? e.kind); }
export function entryLine(e: Entry): string { return `${WAY[e.kind] ?? e.kind}. Added ${day(e.since)}${e.newcomer ? ". New sign-in, under 24 hours old" : ""}`; }
/** A device you are on cannot be removed from here; the recovery code is replaced, not removed. */
export const removable = (e: Entry): boolean => !e.self && e.kind !== "code";

/** The line under the name: the Vyre name, or that setup is waiting. */
export const identityLine = (i: Identity): string => (i.pending ? "Setting up." : i.name ?? "");

/** The code the box answers once, as the line to show; null when the answer holds none. */
export function codeOf(r: unknown): string | null {
  const x = r as { code?: unknown; recoveryCode?: unknown } | null;
  const c = x?.code ?? x?.recoveryCode;
  return typeof c === "string" && c ? c : null;
}

/** Every sealed field of every type: kind "sealed", or a field with a seal setting. These are hidden from every assistant. */
export function sealedFields(types: TypeDef[]): { type: string; typeLabel: string; field: string; label: string }[] {
  return types.flatMap((t) => t.fields.filter((f) => f.kind === "sealed" || !!f.seal).map((f) => ({ type: t.name, typeLabel: t.label || t.name, field: f.name, label: f.label || f.name })));
}
