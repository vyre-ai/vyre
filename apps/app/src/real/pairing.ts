// The real PairingSession: the box's own wink tools behind the one interface the pairing screens already use.
//  - serverSession: this app adds a SERVER or storage device. wink.pair.server with the code the server printed, then wink.pair.status
//    until the three words show; the person says yes AT THE SERVER, so confirm() only waits for `done`.
//  - phoneAnswerSession: this device shows a code for a phone or computer (wink.phone.open); when it asks (wink.phone.pairing) the person
//    types the three words the new device shows and wink.phone.pair.answer checks them. No set of three is offered, so nothing is a pick.
// The box is imported on first use so the pure parts stay runnable in Node.

import type { PairingSession } from "../api/pairing-session";
import type { WinkCode } from "../api/wink-code";
import { added, pairPhase, payloadOf, targetsOf } from "../../screens/devices/real.js";

const box = () => import("./box");
const POLL_MS = 2000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Target = { id: string; kind: "identity" | "space"; label?: string };

export function serverSession(code: Extract<WinkCode, { ok: true }>, target?: Target): PairingSession {
  let stopped = false;
  let words: [string, string, string] = ["", "", ""];
  let pairing = "";
  let finished = false;
  /** Poll until the screen has something to do, or the pairing is over. */
  const until = async (want: "words" | "done"): Promise<void> => {
    const { tool } = await box();
    for (;;) {
      if (stopped) throw new Error("rejected");
      const p = pairPhase(await tool("wink.pair.status", { pairing }));
      if (p.phase === "fail") throw new Error(p.say);
      if (p.phase === "done") { finished = true; return; }
      if (p.phase === "words") { words = p.words!; if (want === "words") return; }
      await sleep(POLL_MS);
    }
  };
  return {
    kind: "watch",
    async ready() {
      const { tool, BoxError } = await box();
      let t = target;
      if (!t) {
        const first = targetsOf(await tool("wink.pair.targets"))[0];
        if (!first) throw new BoxError("no_target", "There is no identity here to pair to.");
        t = { id: first.id, kind: first.kind, label: first.label };
      }
      // The claimed Vyre name goes with the pairing so a server that has never seen the person can show it once the directory confirms it (windows, 5 Oct). Only a label, never a key.
      const me = await tool<{ exists?: boolean; label?: string }>("spaces.identity.status").catch(() => null);
      const vyre = me?.exists && typeof me.label === "string" && me.label ? me.label : "";
      const r = await tool<{ pairing: string }>("wink.pair.server", { payload: payloadOf(code), target: { id: t.id, kind: t.kind }, kind: "server", ...(vyre ? { owner: { vyre } } : {}) });
      pairing = r.pairing;
      await until("words");
    },
    words: () => words,
    choices: () => [],
    answer: async () => false,
    async confirm() { if (!finished) await until("done"); },
    reject() { stopped = true; },
  };
}

/** The computer's side of adding a phone: the three words typed from the phone are the answer. */
export function phoneAnswerSession(words: [string, string, string]): PairingSession {
  let over = false;
  return {
    kind: "answer",
    words: () => words,
    choices: () => [],
    async answer(given) {
      const { tool } = await box();
      const ok = added(await tool("wink.phone.pair.answer", { yes: true, words: given.join(" ") }));
      over = true;
      return ok;
    },
    confirm: () => (over ? Promise.resolve() : Promise.reject(new Error("rejected"))),
    reject() { void box().then(({ tool }) => tool("wink.phone.pair.answer", { yes: false })).catch(() => {}); },
  };
}
