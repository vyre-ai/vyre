// What the app uses of relay/client/wsbridge.js (see client.d.ts for why this file exists).
export type WsBridge = { fromPage(raw: unknown): void; closeAll(): void; readonly open: number };
export function createWsBridge(o: { open: (path: string) => any; post: (message: any) => void; allowed?: readonly RegExp[]; maxSockets?: number }): WsBridge;
export function webviewShim(): string;
