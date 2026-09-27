// The box client (apps/CONTRACT.md). Tools are POST /v1/tools/<name> with the JSON input as the
// body; the answer is always {data} or {error}. Events are SSE at /v1/events/stream, resumed with
// Last-Event-ID. The caller is set by the box's listener (tailnet:<login> or a relay device), so
// the client never sends x-vyre-caller, and a native build sends no Origin.

import { createSseParser } from "./sse.js";

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

export type CallOptions = {
  /** An x-vyre-presence proof, e.g. "device key=... ts=... nonce=... sig=...". Bound to this exact input. */
  presence?: string;
  /** Ask the box to open a presence session from this proof (x-vyre-presence-keep: 1). */
  keep?: boolean;
  signal?: AbortSignal;
};

export type CallMeta = { session?: string };

type FetchLike = typeof fetch;

export type ClientConfig = {
  /** "" means same origin (the web app the box serves at /app/). Native sets the box's https URL. */
  baseUrl: string;
  fetch: FetchLike;
};

let config: ClientConfig = { baseUrl: "", fetch: (...a) => globalThis.fetch(...a) };

/** Set the box URL (native) or swap fetch (tests). */
export function configure(next: Partial<ClientConfig>): void {
  config = { ...config, ...next, baseUrl: (next.baseUrl ?? config.baseUrl).replace(/\/+$/, "") };
}

function url(path: string): string {
  return config.baseUrl + path;
}

function isEnvelope(v: unknown): v is Result<unknown> {
  return typeof v === "object" && v !== null && ("data" in v || "error" in v);
}

/**
 * Call one tool. Never throws: a network failure is {error:{code:"network"}}, a body that is not
 * the envelope is {error:{code:"bad_response"}}. A presence session the box opened comes back in meta.
 */
export async function call<T = unknown>(
  tool: string,
  input: Record<string, unknown> = {},
  opts: CallOptions = {},
  meta?: CallMeta,
): Promise<Result<T>> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (opts.presence) headers["x-vyre-presence"] = opts.presence;
  if (opts.keep) headers["x-vyre-presence-keep"] = "1";
  let res: Response;
  try {
    res = await config.fetch(url(`/v1/tools/${encodeURIComponent(tool)}`), {
      method: "POST",
      headers,
      body: JSON.stringify(input),
      signal: opts.signal,
      credentials: "same-origin",
    });
  } catch (e) {
    return { error: { code: "network", message: e instanceof Error ? e.message : String(e) } };
  }
  const session = res.headers.get("x-vyre-presence-session");
  if (session && meta) meta.session = session;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { error: { code: "bad_response", message: `HTTP ${res.status}, not JSON` } };
  }
  if (!isEnvelope(body)) return { error: { code: "bad_response", message: `HTTP ${res.status}, no envelope` } };
  return body as Result<T>;
}

export type EventsOptions = {
  /** Resume after this id. Omitted: "latest" (skip the backlog), as the Deck does. */
  since?: number | "latest";
  /** "*" (default), "thread.*" or an exact type. */
  type?: string;
  /** Reconnect delay in ms after the stream ends or fails. */
  retryMs?: number;
  onError?: (e: unknown) => void;
};

export type Subscription = { close(): void; lastId(): number | null };

/**
 * Subscribe to the box's events. Reads the SSE body through fetch (the web and Node have a
 * streaming body; React Native's fetch does not, so native gets a transport in the spike).
 * Every reconnect sends Last-Event-ID, which the box honours over `since`, so nothing is lost.
 */
export function events(onEvent: (e: BoxEvent) => void, opts: EventsOptions = {}): Subscription {
  let last: number | null = typeof opts.since === "number" ? opts.since : null;
  let closed = false;
  let ctrl: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const retryMs = opts.retryMs ?? 1000;

  async function once(): Promise<void> {
    ctrl = new AbortController();
    const q = new URLSearchParams({ type: opts.type ?? "*" });
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (last !== null) headers["last-event-id"] = String(last);
    else q.set("since", opts.since === undefined ? "latest" : String(opts.since));
    const res = await config.fetch(url(`/v1/events/stream?${q}`), { headers, signal: ctrl.signal, credentials: "same-origin" });
    if (!res.ok || !res.body) throw new Error(`events: HTTP ${res.status}${res.body ? "" : ", no stream"}`);
    const parser = createSseParser((f) => {
      let ev: BoxEvent;
      try {
        ev = JSON.parse(f.data) as BoxEvent;
      } catch (e) {
        opts.onError?.(e);
        return;
      }
      if (f.id !== null && /^\d+$/.test(f.id)) last = Number(f.id);
      onEvent(ev);
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(dec.decode(value, { stream: true }));
    }
  }

  function loop(): void {
    if (closed) return;
    once().then(
      () => schedule(),
      (e: unknown) => {
        if (!closed) opts.onError?.(e);
        schedule();
      },
    );
  }

  function schedule(): void {
    if (!closed) timer = setTimeout(loop, retryMs);
  }

  loop();
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      ctrl?.abort();
    },
    lastId: () => last,
  };
}
