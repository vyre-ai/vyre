// What the app uses of relay/client/browserjoin.js: a browser with no box joins an identity from the long code a phone shows ("Add a device"). Only the long code; the short typed code is off.
import type { AddedDevice } from "./phonepair.js";
export function joinFromPhone(o: {
  payload: string;
  key: { publicKey: string; agree: string; label?: string };
  name?: string; crypto?: unknown; keyStore?: unknown; WebSocket?: unknown; about?: unknown; presenceKey?: { public_key: string; alg?: number; storage?: "hardware" | "software" };
  onWords?: (words: string) => void; signal?: AbortSignal; pollMs?: number; timeoutMs?: number;
}): Promise<AddedDevice>;
