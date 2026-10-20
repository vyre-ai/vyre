// @ts-check
// Which answer of a re-run read may land (ui/store.ts useStoreQuery). The store re-runs a read on every box event. The old rule let only the newest started read land, so while events
// kept coming (an agent at work, the approvals queue settling) every read was overtaken before it answered and Now showed its placeholder rows for up to a minute. The rule now:
// an answer lands unless a read started after it has already landed, so the screen moves forward with the first answer and never back to an older one.

export function createLanding() {
  let started = 0, landed = 0;
  return {
    /** A read starts: its number. */
    start: () => ++started,
    /** Its answer arrived: true when it may be shown (no later read has landed yet). @param {number} n */
    land(n) {
      if (n <= landed) return false;
      landed = n;
      return true;
    },
  };
}
