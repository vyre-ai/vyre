// The standing answer: while the person's yes stands, a team server that wants their private notes unlocked (memory.unlock-asked) is answered by this phone with no prompt (grant.js answerAsk).
// Nothing is answered for a server that is not pinned (pins.ts), and a failure is silent: the server asks again at its next start, and the planner's own tools still work.
import { listen } from "../api/box";
import { tool } from "../real/box";
import { getAgreeKey } from "../crypto/agree-key";
import { answerAsk } from "./grant.js";
import { pins } from "./pins";

let started = false;
let busy = false;

export function startUnlockAnswerer(): void {
  if (started) return;
  started = true;
  listen((e) => {
    if (e.type !== "memory.unlock-asked" || busy) return;
    busy = true;
    void (async () => {
      try {
        const [granted, agree] = [await pins.all(), await getAgreeKey()];
        if (!granted.size || !agree) return;
        await answerAsk({ call: (t, i) => tool(t, i ?? {}), agree, granted });
      } catch { /* the server asks again */ } finally { busy = false; }
    })();
  });
}
