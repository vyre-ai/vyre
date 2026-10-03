// kernel/door/stream.js: the incremental scanner for a model reply that streams (K3, the door's `stream`). Text is held back just long enough that a value
// split across chunks is seen whole before any part of it leaves: nothing is released while the last `hold` characters could still be the start of a
// value. A sealed-looking value begins with a digit or a digit word and is at most RUN_MAX characters; a ledgered value is at most its longest form
// (three raw characters per normalised one covers separators). So with no number in the tail and nothing in the ledger, nothing is held and each chunk
// passes straight through; a number holds back only from its first digit; a non-empty ledger holds back its longest form. On a hit the caller cuts.
export const RUN_MAX = 160;
const RISKY = /\d|[０-９]|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|oh)\b/gi;

/**
 * @param {{ ledger: import("../seal/ledger.js").Ledger, detect: (text: string) => Promise<{ found: { class: string }[] }> }} o
 */
export function createStreamScanner({ ledger, detect }) {
  let buf = "", seen = "";
  const ledgerHold = () => { let m = 0; for (const l of ledger.chain()) for (const s of ["a", "b"]) for (const k of l.by[s].keys()) m = Math.max(m, k); return m ? 3 * m + 8 : 0; };
  /** How many trailing characters must stay unreleased. */
  const hold = () => {
    let h = ledgerHold();
    const from = Math.max(0, buf.length - RUN_MAX), tail = buf.slice(from);
    RISKY.lastIndex = 0; const m = RISKY.exec(tail);
    if (m) h = Math.max(h, tail.length - m.index);
    return Math.min(h, buf.length);
  };
  // Only windows that end in the new chunk can be new, so each check looks at the chunk plus the characters just before it: as many as the longest form needs.
  async function verdict(chunk) {
    const hit = ledger.check(seen.slice(-ledgerHold()) + chunk);
    if (hit?.too_big) return { code: "budget", class: "scan" };
    if (hit?.hit) return { code: "ledger_hit", class: hit.hit };
    const win = seen.slice(-RUN_MAX) + chunk; RISKY.lastIndex = 0;
    if (RISKY.test(win)) { const r = await detect(win); if (r.found.length) return { code: "sealed_shape", class: r.found[0].class }; }
    return null;
  }
  return {
    /** @returns {Promise<{ text: string } | { cut: { code: string, class: string } }>} */
    async push(chunk) {
      const bad = await verdict(chunk); if (bad) return { cut: bad };
      buf += chunk; seen = (seen + chunk).slice(-Math.max(RUN_MAX, ledgerHold()));
      const upto = buf.length - hold(), out = upto > 0 ? buf.slice(0, upto) : "";
      buf = buf.slice(out.length);
      return { text: out };
    },
    /** The reply is complete: whatever is still held was scanned as it arrived, and is released. */
    async end() { const out = buf; buf = ""; return { text: out }; },
  };
}
