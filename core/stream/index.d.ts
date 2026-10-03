// Types for core/stream (ADR 0052). The runtime is plain ESM JavaScript.

export type Kind =
  | "text-delta" | "text-done" | "tool-started" | "tool-progress" | "tool-finished" | "term-chunk"
  | "term-command" | "file-changed" | "ask" | "ask-answered" | "user-message" | "status";
export type ControlKind = "reset" | "heartbeat";
export type State = "starting" | "working" | "asking" | "waiting" | "paused" | "stopped" | "finished" | "failed";

export type BlockName = "terminal" | "diff" | "files" | "record" | "task" | "draft" | "flow-change" | "answer" | "screen" | "text";
export interface Block { block: BlockName; [prop: string]: any }

export interface DataByKind {
  "text-delta": { message: string; index: number; text: string; reasoning?: boolean; parts?: number[] };
  "text-done": { message: string; index?: number };
  "tool-started": { tool_id: string; tool: string; kind: string; summary: string };
  "tool-progress": { tool_id: string; text?: string; pct?: number };
  "tool-finished": { tool_id: string; ok: boolean; result: Block };
  "term-chunk": { term: string; offset: number; b64: string; parts?: number[] };
  "term-command": { term: string; command: string };
  "file-changed": { path: string; op: "create" | "edit" | "delete"; diff?: Block };
  "ask": { ask_id: string; kind: "permission" | "question" | "approval"; tool?: string; summary?: string; task?: unknown };
  "ask-answered": { ask_id: string; decision?: string | null };
  "user-message": { message: string; text: string; state: "sent" | "queued" | "picked-up" | "cancelled"; queued_at?: number };
  "status": { state: State; turn?: string; stopping?: boolean };
  "reset": { reason: string; head?: number };
  "heartbeat": { head: number };
}

/** The frame: a projection of kernel/contracts EventEnvelope. cur is 0 for control frames. */
export interface Frame<K extends Kind | ControlKind = Kind | ControlKind> {
  v: 1;
  id: string;
  /** Per-session cursor, gapless from 1. When `span` is set, this is the LAST cursor of a merged frame. */
  cur: number;
  session: string;
  turn: string | null;
  type: `session.${K}`;
  time: number;
  corr: string | null;
  /** History only: the number of cursors a merged frame covers (its first is cur - span + 1). */
  span?: number;
  data: DataByKind[K];
}

export type Spec = { kind: string; data: any; turn?: string | null };

export function validate(f: unknown): { ok: true } | { ok: false; error: string };
export function validBlock(b: unknown): boolean;
export function frame(kind: string, data: any, ctx: { session: string; turn?: string | null; cur?: number; time?: number; id?: string }): Frame;
export function toEnvelope(f: Frame, ctx?: { space?: string; actor?: string; trust?: string; red?: string; vis?: string }): Record<string, any>;
export function blockFor(tool: string, input: unknown, output: unknown): Block;
export function summarize(tool: string, input: unknown): string;
export function kindOfTool(tool: string): string;
export function termChunks(term: string, offset: number, bytes: Buffer, max?: number): Spec[];
export function startOf(f: Frame): number;
export function kindOf(f: unknown): string;
export const KINDS: readonly Kind[];
export const CONTROL: readonly ControlKind[];
export const BLOCKS: readonly BlockName[];

export interface LogOptions { maxFrames?: number; maxBytes?: number; maxStored?: number; mergeChars?: number; coalesce?: boolean; flushMs?: number; db?: any; now?: () => number }
export class SessionLog {
  constructor(session: string, opts?: LogOptions);
  readonly session: string;
  readonly head: number;
  /** The cursor before the oldest frame this log can still serve. */
  readonly floor: number;
  append(kind: string, data: any, ctx?: { turn?: string | null; time?: number; id?: string }): Frame;
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
