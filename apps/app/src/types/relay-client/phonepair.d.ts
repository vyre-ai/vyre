// What the app uses of relay/client/phonepair.js: adding this device to an identity from a device that already holds it, by the QR/long code (`payload`) or a typed code (`code`, `relay`).
export type AddedDevice = { paired: true; enrolled: boolean; reason?: string; relay: string; route: string; box: string; device: string; name: string; identity?: { id?: string; vyre?: string } };
export function addThisDevice(o: {
  payload?: string; code?: string; relay?: string;
  key: { publicKey: string; label?: string; agree?: string; held?: "web" | boolean; enclave?: string; attest?: string }; presenceKey?: { public_key: string; alg?: number; storage?: "hardware" | "software" }; name?: string; crypto?: unknown; keyStore?: unknown; about?: unknown;
  onWords?: (words: string) => void; onAck?: (ack: string) => void; signal?: AbortSignal; pollMs?: number; timeoutMs?: number;
}): Promise<AddedDevice>;
