// Types for the platform files: pwa.web.ts (the installed web app) and pwa.native.ts (nothing to do).

/** Where notifications stand on this device, for the Now control. */
export type PushStatus = "on" | "off" | "denied" | "install" | "unsupported";

/** Once, at launch: the service worker, its navigate messages, and push.seen. Returns the unwiring. */
export function startPwa(navigate: (path: string) => void): () => void;
export function pushStatus(): Promise<PushStatus>;
/** Turn notifications on. Call it straight from a tap: the permission prompt comes first. Throws plain words. */
export function enablePush(): Promise<void>;
