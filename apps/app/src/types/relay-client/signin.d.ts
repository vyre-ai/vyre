// What the app uses of relay/client/signin.js: signing this device in by the name an already-signed-in device holds (no code), the other device answers with a prompt and three words.
import type { AddedDevice } from "./phonepair";
export function signInByName(o: {
  name: string | undefined; relay: string; key: { publicKey: string; label?: string; agree?: string; held?: "web" | boolean; enclave?: string; attest?: string }; deviceName?: string; crypto: unknown; keyStore?: unknown;
  WebSocket?: unknown; fetch?: typeof fetch; presenceKey?: unknown; about?: unknown; onWords?: (words: string) => void; onAsked?: () => void; signal?: AbortSignal; pollMs?: number; expectIdentity?: string;
}): Promise<AddedDevice>;
