// relay/client/setup.js: the app's half of the setup session (a server added with an install line that carries a one-time code).
export function createSetupKey(o?: unknown): Promise<{ privateKey: CryptoKey; spki: Uint8Array }>;
export function setupCode(secret: Uint8Array, spki: Uint8Array, o?: unknown): Promise<string>;
export function resolveSetup(secret: Uint8Array, o: { relay: string; crypto?: unknown }): Promise<{ offer: { relay: string; route: string; box: Uint8Array }; name: string; fingerprint: string; handle: string | null }>;
export function setupHello(o: unknown, c?: unknown): Promise<unknown>;
export function setupWords(boxStatic: Uint8Array, secret: Uint8Array, o?: unknown): Promise<string[]>;
export function mailboxReader(o: { relay: string; secret: Uint8Array; key: { privateKey: CryptoKey; spki: Uint8Array }; wait?: number }): Promise<{ next(wait?: number): Promise<string[]> }>;
