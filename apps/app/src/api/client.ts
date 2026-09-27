// The box client (apps/CONTRACT.md, docs/adr/0029-resilience.md): a thin adapter over the box's
// own resilience code, so the app follows events and delivers writes exactly as the Deck does.
//   - events: core/resilience/stream.js follow(), over the platform's `open` (web.js open on the
//     web, native-open.ts on the phone). It holds the cursor, resumes with Last-Event-ID, backs
//     off 2 s to 60 s, and treats a silent stream as dead.
//   - writes: core/resilience/outbox.js. Every write is queued with an Idempotency-Key that stays
//     the same across retries, shown at once as sending, and leaves only on the box's answer.
//   - reads: one call through the same caller (web.js caller), never queued, never thrown.
// Headers for the person session at another origin (src/auth/person.ts) are added per request,
// since each proof signs that request's method, path and body. The path signed is the box's own
// ("/v1/tools/x"), never the transport's: a relay base carries a route prefix the box never sees.
//
// The engine is imported by relative path, not the @vyre/resilience alias, so the Node tests
// can load this file as it is. The platform pieces come in through createClient (box.web.ts,
// box.native.ts).

import { follow } from "../../../../core/resilience/stream.js";
import { outbox as makeOutbox } from "../../../../core/resilience/outbox.js";
import type { Open, StreamState, VyreEvent } from "../../../../core/resilience/stream.js";
import type { Call, Entry, Store } from "../../../../core/resilience/outbox.js";
import type { backoff } from "../../../../core/resilience/backoff.js";

export type BoxError = { code: string; message: string; methods?: string[]; detail?: Record<string, unknown> };
export type Result<T> = { data: T; error?: undefined } | { data?: undefined; error: BoxError };

/** The event record (CONTRACT.md 1.4). */
export type BoxEvent = {
  id: number;
  at: number;
  type: string;
  source: string;
  project: string | null;
  thread: string | null;
  payload: Record<string, unknown>;
};

/** web.js caller's shape: one tool call with an Idempotency-Key, answered {data} or {error}. */
export type Caller = (base: string, o?: { headers?: Record<string, string>; timeoutMs?: number }) => Call;

/** What a person session adds to a request, and what to do when the box asks for one. */
export type Auth = {
  /**
   * `path` is the path and query relative to the box, e.g. "/v1/tools/x". `proved`: the call
   * already carries the caller's own x-vyre-presence, so the session adds none (and never prompts).
   */
  headers(method: string, path: string, body: string, proved?: boolean): Promise<Record<string, string>>;
  /**
   * A tool call's answer. True: it was refused for presence and the session has a proof it has not
   * tried (a prompt the box turned out to need, or its own proof where a session did not cover the
   * item): the call goes once more, now, with the same Idempotency-Key.
   */
  answered?(method: string, path: string, body: string, result: Result<unknown>): boolean | Promise<boolean>;
  required(): void;
};

export type Cursor = { load(): Promise<number | null> | number | null; save(n: number): void };

export type OutboxChange = {
  pending: Entry[];
  done?: { entry: Entry; data: unknown };
  refused?: { entry: Entry; error: BoxError };
};

export type ClientDeps = {
  /**
   * The box's http(s) address, e.g. "https://harlow.example.ts.net". Over relay/client's paths it
   * only names the box (the relay's base, route included); requests go through `open`/`caller`.
   */
  base: string;
  /** Every path to the box in order of preference (LAN, tailnet, relay). Default: [base]. */
  paths?: string[];
  open: Open;
  caller: Caller;
  outboxStore: Store;
  cursor?: Cursor;
  /** The person session at another origin; null at the box's own origin (the cookie does it). */
  auth?: Auth | null;
  /** Someone asked for a person session: the UI shows a sign-in. */
  onSignIn?: () => void;
  onState?: (s: StreamState) => void;
  /** The stream moved its cursor: an event or a heartbeat, so the box answered just now. */
  onAlive?: (at: number) => void;
  onOutbox?: (c: OutboxChange) => void;
  newKey?: () => string;
  backoff?: () => ReturnType<typeof backoff>;
  stallMs?: number;
  timeoutMs?: number;
};

export type Stream = ReturnType<typeof follow>;

export type Client = {
  /** A read: one call now, never queued. Errors come back as {error}. */
  call<T = unknown>(tool: string, input?: Record<string, unknown>, o?: { presence?: string }): Promise<Result<T>>;
  /**
   * A write: queued in the outbox with an Idempotency-Key, delivered in order, retried until the
   * box answers. `answered` resolves with that answer.
   */
  send<T = unknown>(tool: string, input?: Record<string, unknown>, o?: { presence?: string; key?: string }): Promise<{ key: string; answered: Promise<Result<T>> }>;
  /** An entry waiting on presence: send it again with a proof bound to its exact input. */
  prove(key: string, presence: string): Promise<void>;
  /** Follow the box's events from the saved cursor ("latest" on a first start). One per client. */
  events(onEvent: (e: BoxEvent) => void, o?: { type?: string; onReset?: (e: BoxEvent) => void }): Stream;
  readonly stream: Stream | null;
  readonly pending: Entry[];
  /** The network changed or the app came to the front: try the stream and the outbox now. */
  kick(): void;
  stop(): void;
};

const PERSON = "person_session_required";

/** An idempotency key: a UUID where the runtime has one (Hermes does not), else 128 random bits. */
export function newKey(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export async function createClient(d: ClientDeps): Promise<Client> {
  const base = d.base.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw new Error("the box's address must be an http(s) URL");
  const paths = d.paths?.length ? d.paths : [base];
  const auth = d.auth ?? null;
  const timeoutMs = d.timeoutMs ?? 15_000;
  /** Presence proofs for queued entries, by key; each is bound to that entry's exact input. */
  const presence = new Map<string, string>();

  function sessionRequired(): void {
    auth?.required();
    d.onSignIn?.();
  }

  /**
   * One tool call, with this request's person headers. A presence refusal the session can answer
   * (auth.answered) goes once more at once; a second refusal is the box's last word.
   */
  async function once(tool: string, input: unknown, key: string, extra: Record<string, string>) {
    const path = "/v1/tools/" + encodeURIComponent(tool);
    const body = JSON.stringify(input ?? {});
    const proved = Boolean(extra["x-vyre-presence"]);
    const attempt = async () => {
      const headers = { ...(auth ? await auth.headers("POST", path, body, proved) : {}), ...extra };
      return (await d.caller(base, { headers, timeoutMs })(tool, input, key)) as Result<unknown>;
    };
    let r = await attempt();
    if (auth?.answered && (await auth.answered("POST", path, body, r)) && !proved) {
      r = await attempt();
      await auth.answered("POST", path, body, r);
    }
    return r;
  }

  // The outbox's call. A 401 for the person keeps the entry (a retry code) while the person signs
  // in: the write was refused before it ran, so it is not lost and not run twice.
  const call: Call = async (tool, input, key) => {
    const p = presence.get(key);
    const r = await once(tool, input, key, p ? { "x-vyre-presence": p } : {});
    if (r.error?.code === PERSON) {
      sessionRequired();
      return { error: { code: "offline", message: "waiting for you to sign in to the box" } };
    }
    return r;
  };

  const ob = await makeOutbox({
    store: d.outboxStore,
    call,
    newKey: d.newKey ?? newKey,
    backoff: d.backoff?.(),
    onChange: (c) => {
      const answered = c.done?.entry.key ?? c.refused?.entry.key;
      if (answered) presence.delete(answered);
      d.onOutbox?.(c as OutboxChange);
    },
  });

  // The stream's transport, with the person headers on each GET (the health probe included).
  const open: Open = async (req) => {
    const h = auth ? await auth.headers("GET", req.path, "") : {};
    const r = await d.open({ ...req, headers: { ...req.headers, ...h } });
    // web.js open drops the body of an error, so any 401 on the stream with a token is taken as
    // the session lapsing; without auth a 401 is the box's to explain and the stream backs off.
    if (r.status === 401 && auth) sessionRequired();
    return r;
  };

  let stream: Stream | null = null;

  return {
    async call<T>(tool: string, input: Record<string, unknown> = {}, o: { presence?: string } = {}) {
      const r = await once(tool, input, "", o.presence ? { "x-vyre-presence": o.presence } : {});
      if (r.error?.code === PERSON) sessionRequired();
      return r as Result<T>;
    },
    async send<T>(tool: string, input: Record<string, unknown> = {}, o: { presence?: string; key?: string } = {}) {
      const key = o.key ?? (d.newKey ?? newKey)();
      if (o.presence) presence.set(key, o.presence);
      const r = await ob.add(tool, input, { key });
      return { key: r.key, answered: r.answered as Promise<Result<T>> };
    },
    async prove(key: string, proof: string) {
      presence.set(key, proof);
      await ob.retry();
    },
    events(onEvent, o = {}) {
      if (stream) throw new Error("this client already follows the box; stop() it first");
      const start = (cursor: number | null): Stream =>
        follow({
          paths,
          open,
          onEvent: (e: VyreEvent) => onEvent(e as BoxEvent),
          onReset: o.onReset ? (e: VyreEvent) => o.onReset?.(e as BoxEvent) : undefined,
          onState: d.onState,
          cursor,
          save: (n: number) => {
            d.onAlive?.(Date.now());
            d.cursor?.save(n);
          },
          type: o.type ?? "*",
          backoff: d.backoff?.(),
          stallMs: d.stallMs,
        });
      const loaded = d.cursor?.load() ?? null;
      if (loaded instanceof Promise) {
        // Hand back a stream now; it starts once the saved cursor is read.
        let started: Stream | null = null;
        let stopped = false;
        const proxy: Stream = {
          get cursor() { return started ? started.cursor : null; },
          get path() { return started ? started.path : paths[0]; },
          pause: () => started?.pause(),
          resume: () => started?.resume(),
          kick: () => started?.kick(),
          stop: () => { stopped = true; started?.stop(); },
        };
        loaded.then((c) => c, () => null).then((c) => { if (!stopped) started = start(c); });
        stream = proxy;
        return proxy;
      }
      return (stream = start(loaded));
    },
    get stream() { return stream; },
    get pending() { return ob.pending; },
    kick() {
      stream?.kick();
      void ob.kick();
    },
    stop() {
      stream?.stop();
      stream = null;
      ob.stop();
    },
  };
}
