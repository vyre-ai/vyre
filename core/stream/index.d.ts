// Types for core/stream (ADR 0052). The runtime is plain ESM JavaScript.

export type Kind =
  | "text-delta" | "text-done" | "tool-started" | "tool-progress" | "tool-finished" | "term-chunk"
  | "term-command" | "file-changed" | "ask" | "ask-answered" | "user-message" | "status"
  | "participant-joined" | "participant-left" | "reaction" | "pin" | "mention" | "fanout" | "fanout-keep" | "text-cut";
export type ControlKind = "reset" | "heartbeat";
/** Delivered, never logged, cur 0. */
export type EphemeralKind = "presence" | "read-marker";
/** "person:<id>", "assistant:<id>" or "model:<id>". */
export type Author = `person:${string}` | `assistant:${string}` | `model:${string}`;
export type State = "starting" | "working" | "asking" | "waiting" | "paused" | "stopped" | "finished" | "failed";

export type BlockName = "terminal" | "diff" | "files" | "record" | "task" | "draft" | "flow-change" | "answer" | "screen" | "text" | "field-ref" | "field";
/** A cited field: which record and field, never a value. The server draws it per viewer into a `field` block or a placeholder chip. */
export interface FieldRef { block: "field-ref"; record: string; field: string; label?: string }
export interface Block { block: BlockName; [prop: string]: any }

export interface DataByKind {
  "text-delta": { message: string; index: number; text: string; reasoning?: boolean; parts?: number[]; parent?: string };
  "text-done": { message: string; index?: number; blocks?: Block[] };
  "tool-started": { tool_id: string; tool: string; kind: string; summary: string };
  "tool-progress": { tool_id: string; text?: string; pct?: number };
  "tool-finished": { tool_id: string; ok: boolean; result: Block };
  "term-chunk": { term: string; offset: number; b64: string; parts?: number[] };
  "term-command": { term: string; command: string };
  "file-changed": { path: string; op: "create" | "edit" | "delete"; diff?: Block };
  "ask": { ask_id: string; kind: "permission" | "question" | "approval"; tool?: string; summary?: string; task?: unknown };
  "ask-answered": { ask_id: string; decision?: string | null };
  "user-message": { message: string; text: string; state: "sent" | "queued" | "picked-up" | "cancelled"; queued_at?: number; parent?: string };
  "participant-joined": { who: Author; role?: string };
  "participant-left": { who: Author };
  "presence": { who: Author; state: "typing" | "doing"; doing?: string };
  "reaction": { message: string; emoji: string; on: boolean };
  "pin": { message: string; on: boolean };
  "mention": { message: string; who: Author[] };
  "read-marker": { upto: number };
  "fanout": { group: string; message: string; members: { who: Author; message: string }[] };
  "fanout-keep": { group: string; keep: string };
  "text-cut": { message: string; note: string };
  "status": { state: State; turn?: string; stopping?: boolean };
  "reset": { reason: string; head?: number };
  "heartbeat": { head: number };
}

/** The frame: a projection of kernel/contracts EventEnvelope. cur is 0 for control frames. */
export interface Frame<K extends Kind | ControlKind | EphemeralKind = Kind | ControlKind | EphemeralKind> {
  v: 1;
  id: string;
  /** Per-session cursor, gapless from 1. When `span` is set, this is the LAST cursor of a merged frame. */
  cur: number;
  session: string;
  turn: string | null;
  type: `session.${K}`;
  time: number;
  corr: string | null;
  /** Who wrote it. Optional: frames from before group chats have none. */
  author?: Author;
  /** For an assistant or model frame: the person who asked (the chain is [acts_for, author]). */
  acts_for?: `person:${string}`;
  /** The message id the frame belongs to. */
  message?: string;
  /** History only: the number of cursors a merged frame covers (its first is cur - span + 1). */
  span?: number;
  data: DataByKind[K];
}

export type Spec = { kind: string; data: any; turn?: string | null };

export function validate(f: unknown): { ok: true } | { ok: false; error: string };
export function validBlock(b: unknown): boolean;
export function frame(kind: string, data: any, ctx: { session: string; turn?: string | null; cur?: number; time?: number; id?: string; author?: string; acts_for?: string; message?: string }): Frame;
export function toEnvelope(f: Frame, ctx?: { space?: string; actor?: string; trust?: string; red?: string; vis?: string }): Record<string, any>;
export function blockFor(tool: string, input: unknown, output: unknown): Block;
export function summarize(tool: string, input: unknown): string;
export function kindOfTool(tool: string): string;
export function termChunks(term: string, offset: number, bytes: Buffer, max?: number): Spec[];
export function startOf(f: Frame): number;
export function kindOf(f: unknown): string;
export const KINDS: readonly Kind[];
export const CONTROL: readonly ControlKind[];
export const EPHEMERAL: readonly EphemeralKind[];
export function isEphemeral(f: unknown): boolean;
export function isAuthor(v: unknown): v is Author;
export const HOLDBACK: number;
export function settle(text: string, done: boolean): { stable: string; provisional: string };

export interface Participant { id: Author; name?: string }
/** Who answers a message: mentioned assistants, the assigned one, else the default assistant when no person is talking to a person. */
export function whoAnswers(a: { participants: readonly Participant[]; defaultAssistant?: string | null; text?: string; mentions?: readonly string[]; assigned?: string | readonly string[] | null; author: string; previous?: string | null }): string[];

export interface FieldSpec { label?: string; kind?: string; value?: unknown; read_roles?: readonly string[]; seal?: unknown; present?: boolean }
export interface Viewer { id?: string; roles?: readonly string[]; resolve?: (record: string, field: string) => Promise<FieldSpec | null>; resolveMs?: number }
export function render<F>(frame: F, viewer: Viewer): F;
export function forViewer<F>(frame: F, viewer: Viewer): F;
export function forViewerAsync<F>(frame: F, viewer: Viewer): Promise<F>;
export function resolveRefs<F>(frame: F, viewer: Viewer): Promise<F>;
export function hasRefs(frame: unknown): boolean;
export function assertAskerCanRead(frame: unknown, asker: Viewer): void;
export function canRead(field: unknown, viewer: Viewer): boolean;
export function placeholder(field: unknown, viewer: Viewer): Record<string, any>;
export function cutData(message: string): { message: string; note: string };

export function createPresence(o: { session: string; now?: () => number; minMs?: number }): { set(author: string, state: "typing" | "doing", doing?: string): Frame | null; clear(author: string): void };
export function presenceFor(log: SessionLog, now?: () => number): { set(author: string, state: "typing" | "doing", doing?: string): Frame | null; clear(author: string): void };
export const PRESENCE_MS: number;
export function createReadMarkers(): { get(person: string, session: string): number; set(person: string, session: string, upto: number): Frame | null; subscribe(person: string, fn: (f: Frame) => void): () => void; unread(person: string, session: string, head: number): number; toJSON(): Record<string, Record<string, number>>; load(j: Record<string, Record<string, number>>): void };
export const BLOCKS: readonly BlockName[];

export interface LogOptions { maxFrames?: number; maxBytes?: number; maxStored?: number; mergeChars?: number; coalesce?: boolean; flushMs?: number; db?: any; now?: () => number }
export class SessionLog {
  constructor(session: string, opts?: LogOptions);
  readonly session: string;
  readonly head: number;
  /** The cursor before the oldest frame this log can still serve. */
  readonly floor: number;
  append(kind: string, data: any, ctx?: { turn?: string | null; time?: number; id?: string; author?: string; acts_for?: string; message?: string; asker?: Viewer }): Frame;
  emit(kind: EphemeralKind, data: any, ctx?: { time?: number; author?: string }): Frame;
  subscribe(fn: (f: Frame) => void): () => void;
  read(from: number, limit?: number): Frame[];
  since(cur: number): { reset: true; head: number } | { reset?: false; frames: Frame[]; head: number };
  flush(): void;
  close(): void;
}
export class Logs {
  constructor(opts?: LogOptions);
  get(session: string): SessionLog;
  has(session: string): boolean;
  drop(session: string): void;
  close(): void;
}

export interface Conn {
  send(f: Frame | Record<string, any>): void;
  onClose(cb: () => void): void;
  close?(): void;
  onMessage?(cb: (m: any) => void): void;
  buffered?(): number;
  onDrain?(cb: () => void): void;
}
export interface ServeOptions { from?: number; heartbeatMs?: number; maxBuffered?: number; timers?: { setInterval: Function; clearInterval: Function } }
export function serve(log: SessionLog, conn: Conn, opts?: ServeOptions): { close(): void; readonly sent: number; readonly paused: boolean };
export function serveSSE(log: SessionLog, req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, opts?: ServeOptions): { close(): void };
export function serveWS(log: SessionLog, req: any, socket: import("node:net").Socket, head: Buffer, opts?: ServeOptions): { close(): void } | null;
export const HEARTBEAT_MS: number;

export interface Duplex { send(m: any): void; onMessage(cb: (m: any) => void): void; onClose(cb: () => void): void; close(): void }
export type ClientState = "connecting" | "live" | "reconnecting" | "resetting" | "closed";
export interface ConnectOptions {
  open(a: { from: number; attempt: number }): Duplex | Promise<Duplex>;
  from?: number;
  snapshot?(): { cur: number } | Promise<{ cur: number }>;
  onFrame(f: Frame): void;
  onState?(s: ClientState, info?: any): void;
  backoff?: { base?: number; cap?: number; jitter?: number };
  idleMs?: number;
  random?: () => number;
  timers?: { setTimeout(fn: () => void, ms: number): any; clearTimeout(t: any): void };
}
export function connect(o: ConnectOptions): { readonly last: number; readonly state: ClientState; close(): void; reconnect(): void };
export function wsDuplex(url: string, WS?: any): Promise<Duplex>;
export function sseDuplex(url: string, ES?: any): Promise<Duplex>;
export function trim(f: Frame, skip: number): Frame;

export function createAdapter(): {
  event(e: { type: string; payload?: any }): Spec[];
  block(b: any): Spec[];
  term(term: string, offset: number, bytes: Buffer): Spec[];
  seekTerm(term: string, at: number): void;
  readonly turn: string | null;
};
export function pipe(log: SessionLog, ad: ReturnType<typeof createAdapter>, e: { type: string; payload?: any }): Frame[];
declare const mod: { start(ctx: any): Promise<any> };
export default mod;
