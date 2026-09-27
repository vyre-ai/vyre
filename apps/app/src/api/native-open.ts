// The event stream's transport on the phone: one GET over XMLHttpRequest, with the same Open
// contract as core/resilience/web.js open (stream.js follow() drives both). React Native's fetch
// has no streaming body, but its XHR reports progress with responseText growing as bytes arrive,
// so each onprogress hands on only the new part. No dependency.
//
// responseText keeps every byte of one response, so a long-lived stream is ended after `maxBytes`
// (8 MB by default, days of heartbeats); follow() reconnects from its cursor and nothing is lost.

import type { Open } from "@vyre/resilience/stream.js";

type XhrLike = {
  readyState: number;
  status: number;
  responseText: string;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body?: null): void;
  abort(): void;
  onreadystatechange: (() => void) | null;
  onprogress: (() => void) | null;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  ontimeout: (() => void) | null;
  onabort: (() => void) | null;
};

export type XhrCtor = new () => XhrLike;

const HEADERS_RECEIVED = 2;

/** An Open over XMLHttpRequest. Tests pass a fake constructor. */
export function createOpen(o: { XHR?: XhrCtor; maxBytes?: number } = {}): Open {
  const maxBytes = o.maxBytes ?? 8 * 1024 * 1024;
  return ({ base, path, headers, signal }) =>
    new Promise((resolve, reject) => {
      if (!/^https?:/i.test(base)) return reject(new Error(`the phone reaches the box over http(s), not ${base.split(":")[0]}:`));
      const Ctor = o.XHR ?? (globalThis as unknown as { XMLHttpRequest?: XhrCtor }).XMLHttpRequest;
      if (!Ctor) return reject(new Error("this runtime has no XMLHttpRequest"));
      const xhr = new Ctor();

      const queue: string[] = [];
      let seen = 0;
      let ended = false;
      let failed: Error | null = null;
      let wake: (() => void) | null = null;
      let answered = false;

      const poke = () => {
        const w = wake;
        wake = null;
        w?.();
      };
      const take = () => {
        const t = xhr.responseText ?? "";
        if (t.length > seen) {
          queue.push(t.slice(seen));
          seen = t.length;
          if (seen >= maxBytes) xhr.abort();
        }
        poke();
      };
      const finish = (e: Error | null) => {
        if (ended) return;
        ended = true;
        failed = e;
        signal.removeEventListener("abort", onAbort);
        if (!answered) {
          answered = true;
          if (e) reject(e);
          else resolve({ status: xhr.status, chunks: chunks() });
        }
        poke();
      };
      const onAbort = () => {
        xhr.abort();
        finish(null);
      };

      async function* chunks(): AsyncGenerator<string> {
        try {
          for (;;) {
            while (queue.length) yield queue.shift() as string;
            if (ended) {
              if (failed) throw failed;
              return;
            }
            await new Promise<void>((r) => (wake = r));
          }
        } finally {
          if (!ended) {
            xhr.abort();
            finish(null);
          }
        }
      }

      // Set before send(): React Native only streams progress to an XHR that listens for it.
      xhr.onreadystatechange = () => {
        if (xhr.readyState >= HEADERS_RECEIVED && !answered) {
          answered = true;
          resolve({ status: xhr.status, chunks: chunks() });
        }
      };
      xhr.onprogress = take;
      xhr.onload = () => {
        take();
        finish(null);
      };
      xhr.onerror = () => finish(new Error("the stream failed"));
      xhr.ontimeout = () => finish(new Error("the stream timed out"));
      xhr.onabort = () => finish(null);

      if (signal.aborted) return reject(new Error("aborted"));
      signal.addEventListener("abort", onAbort);
      xhr.open("GET", base.replace(/\/+$/, "") + path);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.send(null);
    });
}

export const open: Open = createOpen();
