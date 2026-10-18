// The Records tools the screens use that are agreed with the backend and may land after the screen: history and its undo, logging a call or a note, the sample data, a type's flags. One thin place, so a screen
// asks in one line, gets { data } or { error }, and a tool the box does not have yet shows as "missing" (the screen then draws what it drew before) instead of breaking.
import { callT } from "../../src/real/call-tool";

export type Actor = { kind: "person" | "agent"; id: string; name: string };
export type HistoryItem = { id: string; kind: string; actor: Actor; text: string; at: number; file?: string; undo?: boolean };

/** True when the box answered that it has no such tool (the tool is not there yet), so a screen can fall back. @param {{ code?: string; message?: string } | undefined} e */
export const isMissing = (e?: { code?: string; message?: string }) => !!e && (e.code === "not_found" || e.code === "unknown_tool" || /no such tool|unknown tool/i.test(e.message ?? ""));

export const recordsApi = {
  history: (urn: string) => callT<{ items: HistoryItem[] }>("records.history", { urn }),
  undo: (id: string) => callT<unknown>("records.history.undo", { id }),
  log: (urn: string, kind: "call" | "meeting" | "note", text: string) => callT<unknown>("records.log", { urn, kind, text }),
  sampleAdd: () => callT<unknown>("records.sample.add", {}),
  sampleRemove: () => callT<unknown>("records.sample.remove", {}),
  typeUpdate: (name: string, patch: { hidden_in_records?: boolean }) => callT<unknown>("records.type.update", { name, ...patch }),
};
