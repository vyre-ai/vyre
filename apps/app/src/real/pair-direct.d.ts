// The types of pair-direct.js (plain JS so Node tests it; the relay client it uses is not type-checked into the app).
export function pairToMessage(box: string, device: string): Uint8Array;
export function seedOf(ticket: string, relay: string): Uint8Array;
export function callOverChannel(paired: unknown, tool: string, input: unknown, pairOptions?: unknown): Promise<unknown>;
export function pairServerDirect(o: {
  ticket: string; relay: string; deviceName: string;
  identity: { id: string; name: string; eid: string; sign: (m: Uint8Array) => Promise<Uint8Array> };
  onWords?: (words: string) => void; pairOptions?: unknown;
  finish?: (o: unknown) => Promise<unknown>; call?: (paired: unknown, tool: string, input: unknown) => Promise<unknown>;
  now?: () => number; sleep?: (ms: number) => Promise<void>; pollMs?: number; random?: (n: number) => Uint8Array;
}): Promise<{ paired: any }>;
