// @ts-check
// Whether a server install has finished: every poll path reads wink.install.status; a person's screen may also call wink.install.complete.

import { isPerson } from "./caller.js";

/** @param {any} st */
export function installOwnedFromStatus(st) {
  return Boolean(st && !st.__error && (st.owned || st.locked));
}

/**
 * @param {{ tryCall: (name: string, input?: any) => Promise<any>, meta?: { caller?: string } }} io
 */
export async function resolveInstallOnline({ tryCall, meta }) {
  let online = installOwnedFromStatus(await tryCall("wink.install.status", {}));
  if (!online && isPerson(meta && meta.caller)) {
    const done = await tryCall("wink.install.complete", {});
    // complete started the pairing, or this computer is the server (owned: true). Started is not done: Ready is the server saying it is owned, read again below.
    if (done && !done.__error && done.ok && done.owned === true) online = true;
    if (!online) online = installOwnedFromStatus(await tryCall("wink.install.status", {}));
  }
  return online;
}
