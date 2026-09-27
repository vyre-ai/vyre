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
/** A read, now, never queued. */
export function call<T = unknown>(tool: string, input?: Record<string, unknown>, o?: { presence?: string }): Promise<Result<T>>;
/** A write through the outbox: shown as sending at once, gone on the box's answer. */
export function send<T = unknown>(tool: string, input?: Record<string, unknown>, o?: { presence?: string }): Promise<{ key: string; answered: Promise<Result<T>> }>;
/** Send a write waiting on presence again, with a proof bound to its exact input. */
export function prove(key: string, presence: string): Promise<void>;
export function disconnect(): Promise<void>;
/** Sign in as the person on this box. */
export function signIn(): Promise<void>;
/** End the person session on this box. */
export function signOut(): Promise<void>;
