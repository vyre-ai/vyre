// The phone's native app has no service worker and gets its notifications another way: nothing here.
import type { PushStatus } from "./pwa.d";

export const startPwa = (_navigate: (path: string) => void): (() => void) => () => {};
export const pushStatus = async (): Promise<PushStatus> => "unsupported";
export async function enablePush(): Promise<void> {}
