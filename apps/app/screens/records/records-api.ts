// The Records tools the screens use that are agreed with the backend and may land after the screen: history and its undo, logging a call or a note, the sample data, a type's flags. One thin place, so a screen
// asks in one line, gets { data } or { error }, and a tool the box does not have yet shows as "missing" (the screen then draws what it drew before) instead of breaking.
import { callT } from "../../src/real/call-tool";

export type Actor = { kind: "person" | "agent"; id: string; name: string };
export type HistoryItem = { id: string; kind: string; actor: Actor; text: string; at: number; file?: string; undo?: boolean };

/** True when the box answered that it has no such tool (the tool is not there yet), so a screen can fall back. @param {{ code?: string; message?: string } | undefined} e */
export const isMissing = (e?: { code?: string; message?: string }) => !!e && (e.code === "not_found" || e.code === "unknown_tool" || /no such tool|unknown tool/i.test(e.message ?? ""));

/** A task as tasks.list answers it with the three slots (tasks v2). Fields a box without v2 lacks are simply absent. */
export type TaskRow = { id: string; title: string; state: string; due?: number | string | null; due_shown?: string; record?: string; slots?: { doer?: { holder: string }; reviewer?: { holder: string }; approver?: { holder: string } } };
export type MineSlot = "assigned" | "reviewing" | "approving";

export type BusyBlock = { starts_at: string | number; ends_at: string | number | null; all_day: boolean; busy: true };

export const recordsApi = {
  /** Who can read a note or a synced event; only its writer changes it, and the box says so in plain words when it is someone else. */
  share: (urn: string, visibility: "private" | "record" | "space") => callT<unknown>("records.share", { urn, visibility }),
  /** The blocks of time other people's private events take up: Busy, nothing else. */
  busy: (from?: string, to?: string) => callT<{ busy: BusyBlock[] }>("records.busy", { ...(from ? { from } : {}), ...(to ? { to } : {}) }),
  /** My tasks in one slot: the box reads who "mine" is from the caller (their person, the assistant acting, every role held). */
  tasksMine: (mine: MineSlot, state?: string[]) => callT<{ tasks: TaskRow[] }>("tasks.list", { mine, ...(state ? { state } : {}) }),
  history: (urn: string) => callT<{ items: HistoryItem[] }>("records.history", { urn }),
  undo: (id: string) => callT<unknown>("records.history.undo", { id }),
  log: (urn: string, kind: "call" | "meeting" | "note", text: string) => callT<unknown>("records.log", { urn, kind, text }),
  sampleAdd: () => callT<unknown>("records.sample.add", {}),
  sampleRemove: () => callT<unknown>("records.sample.remove", {}),
  typeUpdate: (name: string, patch: { hidden_in_records?: boolean }) => callT<unknown>("records.type.update", { name, ...patch }),
};
