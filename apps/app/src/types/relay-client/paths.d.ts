// What the app uses of relay/client/paths.js (see client.d.ts for why this file exists).
import type { Visibility } from "./client";

export type PathResponse = {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array>;
  text(): Promise<string>;
  json(): Promise<any>;
};
export type PathFetch = (
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; cache?: RequestCache },
) => Promise<PathResponse>;

export type Paths = {
  onstate: (s: { kind: string; index: number; state: string }) => void;
  readonly current: "direct" | "relay";
  readonly index: number;
  fetch: PathFetch;
  events(path: string, o: { onEvent: (e: { id: string; event: string; data: string }) => void; lastEventId?: string }): { readonly lastEventId: string | null; reopen(): void; close(): void };
  socket(path: string): any;
  probe(): Promise<void>;
  close(): void;
};

export function createPaths(o: {
  paths: Array<{ kind: "direct"; base: string } | ({ kind: "relay" } & Record<string, any>)>;
  fetch?: typeof globalThis.fetch;
  WebSocket?: unknown;
  visibility?: Visibility;
  directTimeout?: number;
  probeMs?: number;
  probePath?: string;
  onstate?: (s: { kind: string; index: number; state: string }) => void;
  report?: boolean;
}): Paths;
