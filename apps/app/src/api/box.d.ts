// Types for the platform files: box.web.ts and box.native.ts. Screens import "src/api/box".
import type { BoxEvent, Client, Result } from "./client";

/** The box's address and its paths in order (LAN, tailnet, relay). The web defaults to the page's origin. */
export function configure(o: { base?: string; paths?: string[] }): void;
/** The box's host name, which keys its stores on this device. */
export function boxName(): string;
/** Start following the box (once) and resolve the client. */
export function connect(): Promise<Client>;
/** Every event from the box; onReset hears a stream.reset (reload the view). Returns the unsubscribe. */
export function listen(onEvent: (e: BoxEvent) => void, onReset?: (e: BoxEvent) => void): () => void;
/** The box's origin (scheme, host, port) when it is reached directly; "" when only the relay reaches it. */
export function boxOrigin(): string;
/** A WebSocket on whichever path answers (direct or relay): same call for both. It does not move; on close, open another. */
export function socket(path: string): Promise<WebSocket>;
/** A read, now, never queued. */
export function call<T = unknown>(tool: string, input?: Record<string, unknown>, o?: { presence?: string; kernelProof?: string; approval?: string }): Promise<Result<T>>;
/** A write through the outbox: shown as sending at once, gone on the box's answer. */
export function send<T = unknown>(tool: string, input?: Record<string, unknown>, o?: { presence?: string }): Promise<{ key: string; answered: Promise<Result<T>> }>;
/** Send a write waiting on presence again, with a proof bound to its exact input. */
export function prove(key: string, presence: string): Promise<void>;
export function disconnect(): Promise<void>;
/** A hint the page may not outlive (push.seen on hide): keepalive on the web, one call on the phone. Never thrown. */
export function beacon(tool: string, input: Record<string, unknown>): Promise<void>;
/** Sign in as the person on this box. */
export function signIn(): Promise<void>;
/** End the person session on this box. */
export function signOut(): Promise<void>;
/** One POST of JSON to a box route that is not a tool call (the presence challenge), on whichever path answers. */
export function post(path: string, input: Record<string, unknown>): Promise<{ data?: unknown; error?: { code?: string; message?: string } }>;
