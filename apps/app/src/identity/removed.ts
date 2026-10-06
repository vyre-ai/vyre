// The server said this device was removed (the relay's "device removed", close code 4401): the device forgets everything it held (wipe.js has the steps and the one rule for what counts), then shows the pair-again
// screen. Once: a second signal while the wipe runs changes nothing. A refused sign-in or an unreachable server never comes here (isRemovedCode).
import { isRemovedCode, wipeAll } from "./wipe.js";
import { afterWipe, deviceSteps } from "./device-wipe";
import { noteRemoved } from "../auth/notice.js";

let running: Promise<void> | null = null;

/** Forget everything this device held, then send the person to pair it again. */
export function deviceRemoved(): Promise<void> {
  return (running ??= (async () => {
    noteRemoved();
    await wipeAll(deviceSteps());
    afterWipe();
  })());
}

/** Call with any error or answer code from a call to the server: wipes when (and only when) it is the relay's removed answer. @param {unknown} code */
export async function ifRemoved(code: unknown): Promise<boolean> {
  if (!isRemovedCode(code)) return false;
  await deviceRemoved();
  return true;
}
