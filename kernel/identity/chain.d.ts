// Types for kernel/identity/chain.js, for the app's type check (the .js itself is pinned and reviewer-gated, so it carries no further annotations).
// Loose where the chain is: an op is a plain object the verifier checks, not a type the compiler enforces.
export const CHAIN_TAG: string;
export const NEWCOMER_MS: number;
export const SKEW_MS: number;
export const MAX_OPS: number;
export const MAX_ENTRIES: number;
export const CONTACT_QUORUM: number;
export const PERSON_KINDS: readonly string[];
export const PREFIX: Readonly<{ person: string; space: string }>;
export const ID_RE: RegExp;
export const EID_RE: RegExp;

export type Entry = { eid: string; kind: "device" | "code" | "contact" | "owner"; pub?: string; subject?: string; label?: string; since: number; addedBy: string | null; founder?: boolean };
export type State = { id: string; kind: "person" | "space"; seq: number; head: string; ts: number; entries: Entry[] };
export type Ctx = { ownerOps?: (id: string) => Promise<any[] | null>; live?: boolean; liveFrom?: number; seenAt?: (seq: number) => number | undefined; now?: number; skewMs?: number };
export type Pin = { id: string; seq: number; head: string };

export function chainError(code: string, message: string): Error & { code: string };
export function sha256hex(s: string | Uint8Array): Promise<string>;
export function b64u(b: Uint8Array): string;
export function unb64(s: unknown): Uint8Array | null;
export function idOfBytes(bytes: Uint8Array): Promise<string>;
export function eidOf(pub: Uint8Array | string): Promise<string>;
export function canonical(v: unknown): string;
export function messageOf(op: any): Uint8Array;
export function hashOf(op: any): Promise<string>;
export function youngAt(e: Entry, ts: number): boolean;
export function idOfGenesis(body: any): Promise<string>;
export function applyOp(state: State | null, op: any, ctx?: Ctx): Promise<State>;
export function signerKey(state: State, by: string, via: string | undefined, ts: number, ctx?: Ctx, pos?: { seq?: number; head?: string }): Promise<{ pub: string; young: boolean; entry: Entry; signing: Entry }>;
export function viaOf(ownerOps: any[]): Promise<{ via_seq: number; via_head: string }>;
export function verifyWith(pub: string, message: Uint8Array, sig: string, entry?: Entry): Promise<boolean>;
export function verifyChain(ops: any[], ctx?: Ctx): Promise<State>;
export function stateAt(ops: any[], ts: number, ctx?: Ctx): Promise<State | null>;
export function makeGenesis(o: { kind: "person" | "space"; entry: any; code?: any; nonce: string; ts: number; via?: string; viaPos?: { via_seq: number; via_head: string }; sign: (message: Uint8Array) => Promise<Uint8Array> | Uint8Array }): Promise<any>;
export function makeOp(state: State, body: any, o: { by?: string; via?: string; viaPos?: { via_seq: number; via_head: string }; ts: number; sign?: (message: Uint8Array) => Promise<Uint8Array> | Uint8Array }): Promise<any>;
export function approvalMessage(op: any): Uint8Array;
export function alertsSince(ops: any[], afterSeq: number): any[];
export function checkAnswer(pin: Pin | null | undefined, ops: any[]): Promise<{ ok: true; fresh: boolean } | { ok: false; code: "stale" | "fork" | "other_id"; why: string }>;
export function pinOf(s: State): Pin;
