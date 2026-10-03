// What a pairing looks like once a long code has been read (DESIGN-wink.md section 4): both screens show
// the same three words, made from both sides' keys, and the person says yes or says they differ.
// No answer pairs nothing. The real session comes from the Wink module (wink.phone.scan and
// wink.pair.server in core/wink, words from relay/client/pairwords.js). Until the app is wired to it,
// openPairing() below is the ONE place that hands out a session, and it hands out the mock.

import type { WinkCode } from "./wink-code.ts";

export type PairingSession = {
  /** The three words both screens show. */
  words(): [string, string, string];
  /** The person says they match. Resolves when the pairing is made; rejects if it was rejected or ended. */
  confirm(): Promise<void>;
  /** The person says they do not match. Nothing is paired. */
  reject(): void;
};

const MOCK_WORDS: [string, string, string][] = [
  ["amber", "river", "lantern"],
  ["cedar", "harbor", "violet"],
  ["maple", "copper", "island"],
];

/** The session the mock store uses: the words depend only on the code, nothing leaves the app. */
export function mockPairingSession(code: Extract<WinkCode, { ok: true }>): PairingSession {
  const seed = code.kind === "ticket" ? code.ticket : code.offer;
  let n = 0;
  for (let i = 0; i < seed.length; i++) n = (n * 31 + seed.charCodeAt(i)) >>> 0;
  const words = MOCK_WORDS[n % MOCK_WORDS.length];
  let state: "open" | "rejected" | "done" = "open";
  return {
    words: () => [...words] as [string, string, string],
    confirm: () => (state === "rejected" ? Promise.reject(new Error("rejected")) : ((state = "done"), Promise.resolve())),
    reject: () => { if (state === "open") state = "rejected"; },
  };
}

/** The one place a session is opened. Swap the body for the Wink module call when the app can reach it. */
export function openPairing(code: Extract<WinkCode, { ok: true }>): PairingSession {
  return mockPairingSession(code);
}

/** "amber, river, lantern" for a line of text. */
export const wordsLine = (w: readonly string[]) => w.join(" ");
