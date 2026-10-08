// What the app uses of relay/client/client.js. The relay's JS is checked by its own // @ts-check,
// not under the app's strict tsconfig, so tsc reads these declarations (tsconfig paths) while
// Metro bundles the real file (metro.config.js). Keep in step with relay/client/README.md.
import type { KeyPair, KeyStore, CryptoProvider } from "./webcrypto";

export type About = { kind?: "app" | "web"; release?: string; manifest?: string };
export type Visibility = { hidden(): boolean; on(fn: () => void): () => void };

export const PAIR_BASE: string;
export function parsePairUrl(url: string): { relay: string; route: string; box: Uint8Array; secret: string; name: string } | null;
export function pair(
  offerUrl: string,
  o?: { name?: string; presenceKey?: { public_key: string; alg?: number; storage?: "hardware" | "software" }; about?: About; keyStore?: KeyStore; crypto?: CryptoProvider; WebSocket?: unknown; timeout?: number },
): Promise<{ relay: string; route: string; box: string; name: string; device: string | null; presence: { enrolled: boolean; reason?: string } | null }>;
export type { KeyPair };
export function openChannel(o: unknown): Promise<{ channel: unknown }>;
export function request(ch: unknown, head: unknown, body: Uint8Array, signal?: AbortSignal): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
