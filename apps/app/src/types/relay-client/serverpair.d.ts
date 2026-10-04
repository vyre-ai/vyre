// relay/client/serverpair.js: a device with no box pairs a fresh server (tailnet's; the app calls it, it calls no wink tool).
export function parseServerPayload(s: string): { seed: Uint8Array; relay: string } | null;
export function pairServer(o: {
  payload: string;
  owner: { id: string; name?: string; kind?: "identity" | "space"; vyre?: string; pin?: { id: string; seq: number; head: string } };
  name?: string;
  proof?: { eid: string; sig: string; esig?: string };
  deviceKind?: "phone" | "computer" | "web"; keyStorage?: "hardware" | "software";
  signIdentity?: (message: Uint8Array) => Promise<{ eid: string; sig: string; esig?: string }> | { eid: string; sig: string; esig?: string };
  crypto?: unknown; keyStore?: unknown; WebSocket?: unknown; relay?: string;
  about?: { kind?: "app" | "web"; release?: string; manifest?: string };
  presenceKey?: unknown; passkey?: unknown;
  onWords?: (words: string) => void; signal?: AbortSignal; pollMs?: number; timeoutMs?: number;
}): Promise<{ paired: true; relay: string; route: string; box: string; device: string; name: string; owner: unknown }>;
