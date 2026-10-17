// What a pairing looks like once a long code has been read (DESIGN-wink.md section 4): both screens show
// the same three words, made from both sides' keys, and the person says yes or says they differ.
// No answer pairs nothing. The real session comes from the Wink module (wink.pair.server in core/wink,
// words from relay/client/pairwords.js), made by serverSession in src/real/pairing.ts.

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
