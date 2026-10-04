// What a pairing looks like once a long code has been read (DESIGN-wink.md section 4): both screens show
// the same three words, made from both sides' keys, and the person says yes or says they differ.
// No answer pairs nothing. The real session comes from the Wink module (wink.phone.scan and
// wink.pair.server in core/wink, words from relay/client/pairwords.js). Until the app is wired to it,
// openPairing() below is the ONE place that hands out a session, and it hands out the mock.

import type { WinkCode } from "./wink-code.ts";
import { serverSession } from "../real/pairing.ts";

const realSession = serverSession;

export type PairingSession = {
  /** The three words both screens show. */
  words(): [string, string, string];
  /** Three word sets in a fixed shuffled order, one of them the real words. The person picks the one the other screen shows. */
  choices(): [string, string, string][];
  /** The person's answer: a pick from choices() or all three words typed. True and the pairing is made when they are the real words; false rejects it for good. */
  answer(given: readonly string[]): Promise<boolean>;
  /** The person says they match. Resolves when the pairing is made; rejects if it was rejected or ended. */
  confirm(): Promise<void>;
  /** The person says they do not match. Nothing is paired. */
  reject(): void;
  /** "answer" (default): the person answers here with the words. "watch": the person says yes on the other device and this screen only shows the words until confirm() resolves. */
  kind?: "answer" | "watch";
  /** Real sessions only: resolves when the words are known (the box answered), rejects with the reason in plain words. */
  ready?(): Promise<void>;
};

const MOCK_WORDS: [string, string, string][] = [
  ["amber", "river", "lantern"],
  ["cedar", "harbor", "violet"],
  ["maple", "copper", "island"],
];

/** The session the mock store uses: the words depend only on the code, nothing leaves the app. */
export function mockPairingSession(code: Extract<WinkCode, { ok: true }>): PairingSession {
  const seed = code.kind === "ticket" ? code.ticket : code.kind === "typed" ? code.code : code.offer;
  let n = 0;
  for (let i = 0; i < seed.length; i++) n = (n * 31 + seed.charCodeAt(i)) >>> 0;
  const words = MOCK_WORDS[n % MOCK_WORDS.length];
  let state: "open" | "rejected" | "done" = "open";
  const decoys = [MOCK_WORDS[(n + 1) % MOCK_WORDS.length], MOCK_WORDS[(n + 2) % MOCK_WORDS.length]];
  const order = [words, ...decoys].map((w, i) => ({ w, k: ((n >>> (i * 3)) & 7) + i / 10 })).sort((a, b) => a.k - b.k).map((x) => x.w);
  return {
    words: () => [...words] as [string, string, string],
    choices: () => order.map((w) => [...w]) as [string, string, string][],
    answer: (given) => {
      const ok = state === "open" && given.length === 3 && given.every((g, i) => g.trim().toLowerCase() === words[i]);
      state = ok ? "done" : "rejected";
      return Promise.resolve(ok);
    },
    confirm: () => (state === "rejected" ? Promise.reject(new Error("rejected")) : ((state = "done"), Promise.resolve())),
    reject: () => { if (state === "open") state = "rejected"; },
  };
}

/** The one place a session is opened: the box's own wink tools (src/real/pairing.ts), or the mock in a development build with EXPO_PUBLIC_VYRE_MOCK=1. */
export function openPairing(code: Extract<WinkCode, { ok: true }>): PairingSession {
  if (typeof process !== "undefined" && process.env.EXPO_PUBLIC_VYRE_MOCK === "1") return mockPairingSession(code);
  return realSession(code);
}

/** "amber, river, lantern" for a line of text. */
export const wordsLine = (w: readonly string[]) => w.join(" ");
