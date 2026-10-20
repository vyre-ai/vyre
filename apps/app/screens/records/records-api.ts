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

export type NoteRow = { id: string; title?: string; body?: string; visibility?: string; record?: string; owner?: string };
export type BusyBlock = { starts_at: string | number; ends_at: string | number | null; all_day: boolean; busy: true };

export type StatsGroup = { key: unknown; count: number } & Record<string, any>;

/** The marker the app's box layer reads to send a note call to the joined team's door while a team shows (and drops, with `kind`, before it goes). At home it is only dropped. Put on every Notes call and on no other planner call. */
const note = <T extends object>(input: T) => ({ ...input, notes: true });

export const recordsApi = {
  /** Totals by stage (or another choice field) across every record the caller may read. */
  stats: (type: string, o: { group_by?: string; filter?: object } = {}) => callT<{ groups: StatsGroup[]; total: StatsGroup }>("records.stats", { type, ...o }),
  /** Who can read a note or a synced event; only its writer changes it, and the box says so in plain words when it is someone else. */
  share: (urn: string, visibility: "private" | "record" | "space", o: { type?: string; record?: string } = {}) =>
    // A note is the planner's, so it is shared through the planner; an outside-calendar event through records.share.
    o.type === "note" || o.type === "record-note"
      ? callT<unknown>("planner.update", note({ item: urn.split("/").pop(), visibility, ...(o.record ? { record: o.record } : {}) }))
      : callT<unknown>("records.share", { urn, visibility }),
  /** A new note of your own, private until shared (planner.add; in a joined team it lands in the team's planner). */
  noteAdd: (title: string, body: string) => callT<unknown>("planner.add", note({ kind: "note", title, ...(body ? { body } : {}), visibility: "private" })),
  /** One note, and a change to your own (planner.get, planner.update). */
  noteGet: (id: string) => callT<unknown>("planner.get", note({ item: id })),
  noteUpdate: (input: Record<string, any>) => callT<unknown>("planner.update", note(input)),
  /** Notes by who they are about: mine, shared with me, or the whole Space (planner.list, which cuts them to what the caller may read). */
  notes: (scope: "mine" | "shared" | "space") => callT<{ items: NoteRow[] }>("planner.list", note({ kind: "note", scope, state: "all", limit: 200 })),
  /** The blocks of time other people's private events take up: Busy, nothing else. */
  busy: (from?: string, to?: string) => callT<{ busy: BusyBlock[] }>("records.busy", { ...(from ? { from } : {}), ...(to ? { to } : {}) }),
  /** My tasks in one slot: the box reads who "mine" is from the caller (their person, the assistant acting, every role held). */
  tasksMine: (mine: MineSlot, state?: string[]) => callT<{ tasks: TaskRow[] }>("tasks.list", { mine, ...(state ? { state } : {}) }),
  history: (urn: string) => callT<{ items: HistoryItem[] }>("records.history", { urn }),
  undo: (id: string) => callT<unknown>("records.history.undo", { id }),
  // A note is the planner's, so it is written there (the same note at home, and the joined team's note in a team); a call or a meeting is a record log.
  log: (urn: string, kind: "call" | "meeting" | "note", text: string) => kind === "note"
    ? callT<unknown>("planner.add", note({ kind: "note", title: text.split("\n")[0].slice(0, 120), ...(text.includes("\n") ? { body: text } : {}), visibility: "private", record: urn }))
    : callT<unknown>("records.log", { urn, kind, text }),
  sampleAdd: () => callT<unknown>("records.sample.add", {}),
  sampleRemove: () => callT<unknown>("records.sample.remove", {}),
  typeUpdate: (name: string, patch: { hidden_in_records?: boolean }) => callT<unknown>("records.type.update", { name, ...patch }),
  /** Move a record to the bin, and bring it back (records.remove, records.restore): whoever may change it may do both. */
  remove: (urn: string, version: number) => callT<{ removed: string }>("records.remove", { urn, base_version: version }),
  restore: (urn: string) => callT<{ restored: string }>("records.restore", { urn }),
  /** The bin of one type: the removed records this person may see (their own; every one for an owner or an admin). records.list with include_deleted lists the live ones too, so they are left out here. */
  bin: (type: string) => callT<{ rows: any[] }>("records.list", { type, include_deleted: true, limit: 200 }).then((r) => (r.error ? r : { data: { rows: (r.data?.rows ?? []).filter((x: any) => x && x.deleted_at) } })),
};
