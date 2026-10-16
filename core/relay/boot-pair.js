// @ts-check
// The install line's boot. A 43-character setup code starts the setup session, as before.
// An install code (199 characters) starts that session from the embedded setup material, then redeems the code so the server adopts its owner.
// The code is never logged.

import { PAIR_CODE_LEN, verifyPairCode } from "../../lib/pair-code.js";

/**
 * @param {{ code: string, at: number, beginSetup: (code: string) => Promise<unknown>, redeem: (code: string) => Promise<any>, log: (m: string) => void, nap: (ms: number) => Promise<void>, stopping: () => boolean, ttl: number, retryMs: number, setFailure: (why: string, retrying?: boolean) => void, clearFailure: () => void }} o
 */
export function armInstallBoot(o) {
  void run();
  async function run() {
    const pair = o.code.length === PAIR_CODE_LEN ? verifyPairCode(o.code) : null;
    if (o.code.length === PAIR_CODE_LEN && (!pair || !pair.ok)) {
      const why = pair && !pair.ok ? pair.message : "that install code does not look right. Make a new install line in the app";
      o.setFailure(why, false);
      o.log(`relay: the install code was not used: ${why}`);
      return;
    }
    const setup = pair && pair.ok ? pair.setup : o.code;
    let wait = o.retryMs;
    let setupDone = false;
    for (;;) {
      try {
        if (!setupDone) { await o.beginSetup(setup); setupDone = true; }
        if (pair && pair.ok) {
          const r = await o.redeem(o.code);
          if (r && r.error) {
            const code = String(r.error.code || "");
            if (code === "locked" || code === "already_adopted") { o.clearFailure(); return; }
            throw Object.assign(new Error(String(r.error.message || "the install code was not accepted")), { code });
          }
        }
        o.clearFailure();
        return;
      } catch (err) {
        const e = /** @type {any} */ (err);
        const final = !e || e.code === "denied" || e.code === "expired" || e.code === "bad_input" || e.code === "unsupported" || o.stopping() || Date.now() - o.at + wait > o.ttl;
        o.log(`relay: setup code not used${final ? "" : " yet, trying again"}: ${e && e.message}`);
        if (final) { o.setFailure(`the relay or this box refused the setup code: ${e && e.message}`, false); return; }
        o.setFailure(`the relay is busy or not answering (${e && e.message}); trying again`, true);
        await o.nap(wait); wait = Math.min(wait * 2, 60_000);
      }
    }
  }
}
