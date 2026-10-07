// The one box connection for the whole app: a client from client.ts, fed into the connection
// store (src/state/connection.ts), with one event stream shared by every screen. The platform
// files (box.web.ts, box.native.ts) pass in what differs: transport, storage, lifecycle, sign-in.

import { connection } from "../state/connection";
import { createClient, newKey, type BoxEvent, type Client, type ClientDeps, type Result } from "./client";

export type Platform = Omit<ClientDeps, "onState" | "onAlive" | "onOutbox" | "onSignIn"> & {
  /** Wire app lifecycle and network changes to the client; returns the unwiring. */
  lifecycle?: (c: Client) => () => void;
  /** Runs once before the first request, e.g. finishing a sign-in hop. */
  before?: () => Promise<void>;
  /** A WebSocket on the path that answers (direct or the relay), for a ticketed stream path like /v1/streams/stream/session?ticket=. */
  socket?: (path: string) => unknown;
};

const listeners = new Set<(e: BoxEvent) => void>();
const resets = new Set<(e: BoxEvent) => void>();

/** A device paired to its server over the relay (device-first install) reaches it over the peer wire: every call and write goes there, answered in the same shapes. */
export type PeerRoute = { wanted(): boolean; call(tool: string, input: Record<string, unknown>): Promise<unknown> };

export function makeBox(platform: () => Promise<Platform>, peer?: PeerRoute) {
  const viaPeer = async <T>(tool: string, input: Record<string, unknown>): Promise<Result<T>> => {
    try { return { data: (await peer!.call(tool, input)) as T }; }
    catch (e) { const x = e as { code?: string; message?: string }; return { error: { code: x.code ?? "error", message: x.message ?? "" } as never }; }
  };
  let clientP: Promise<Client> | null = null;
  let unwire: (() => void) | null = null;
  let socketOn: ((path: string) => unknown) | null = null;

  async function start(): Promise<Client> {
    const p = await platform();
    await p.before?.();
    socketOn = p.socket ?? null;
    connection.paths(p.paths?.length ?? 1);
    const c = await createClient({
      ...p,
      onState: (s) => connection.stream(s),
      onAlive: (at) => connection.alive(at),
      onOutbox: (ch) => connection.outbox(ch),
      onSignIn: () => connection.signIn(true),
    });
    c.events(
      (e) => {
        for (const f of listeners) f(e);
      },
      {
        onReset: (e) => {
          for (const f of resets) f(e);
        },
      },
    );
    unwire = p.lifecycle?.(c) ?? null;
    return c;
  }

  const client = () => (clientP ??= start().catch((e) => {
    clientP = null;
    throw e;
  }));

  return {
    /** Start following the box (once) and resolve the client. */
    connect: client,
    /** Every event from the box. Returns the unsubscribe. */
    listen(onEvent: (e: BoxEvent) => void, onReset?: (e: BoxEvent) => void): () => void {
      listeners.add(onEvent);
      if (onReset) resets.add(onReset);
      return () => {
        listeners.delete(onEvent);
        if (onReset) resets.delete(onReset);
      };
    },
    /** A WebSocket on whichever path answers (direct or relay): the same call for both. It does not move; on close, open another. */
    async socket(path: string): Promise<unknown> {
      await client();
      if (!socketOn) throw new Error("this box connection has no sockets");
      return socketOn(path);
    },
    /** A read, now. */
    async call<T = unknown>(tool: string, input: Record<string, unknown> = {}, o?: { presence?: string; kernelProof?: string; approval?: string }): Promise<Result<T>> {
      if (peer?.wanted()) return viaPeer<T>(tool, input);
      return (await client()).call<T>(tool, input, o);
    },
    /** A write: on screen as sending at once, delivered by the outbox, gone on the box's answer. */
    async send<T = unknown>(tool: string, input: Record<string, unknown> = {}, o: { presence?: string } = {}) {
      if (peer?.wanted()) { const r = await viaPeer<T>(tool, input); return { key: newKey(), answered: Promise.resolve(r) } as never; }
      const key = newKey();
      connection.sending({ key, tool, input, at: Date.now() });
      return (await client()).send<T>(tool, input, { ...o, key });
    },
    async prove(key: string, presence: string) {
      return (await client()).prove(key, presence);
    },
    async disconnect() {
      if (!clientP) return;
      const c = await clientP.catch(() => null);
      unwire?.();
      unwire = null;
      c?.stop();
      clientP = null;
    },
  };
}
