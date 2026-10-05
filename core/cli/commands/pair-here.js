// @ts-check
// `vyre up` on a server that nobody has paired yet: the same pairing the installer shows (scripts/install-box.sh pair_server), in the same words (core/cli/pair-words.js). It shows the QR, the long
// code and the short typed code, takes the typed ack ("Type the code your app shows:") when the app has typed the code, shows who is asking with three sets of three words and takes the pick.
// It calls the daemon's own tools (wink.server.code, wink.code.status, wink.server.confirm, wink.server.pairing, wink.server.pair.answer): no second pairing flow, only a second terminal for it.
import { PAIR_WORDS as W, say as fill } from "../pair-words.js";

const FIVE_MIN = 5 * 60_000;

/**
 * @param {{ tool: (name: string, input?: any) => Promise<any>, io: { ask(q: string): Promise<string>, tty: boolean }, say: (s: string) => void, sleep?: (ms: number) => Promise<void>, now?: () => number, art?: boolean }} d
 * @returns {Promise<{ paired: boolean, why?: string, name?: string }>}
 */
export async function pairHere(d) {
  const { tool, io, say } = d;
  const sleep = d.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const now = d.now || Date.now;
  const made = await tool("wink.server.code", { qr: true });
  if (made.error || !made.data || !made.data.qr) { say(`  Pairing could not start: ${(made.error && made.error.message) || "the pairing is not ready on this server"}.`); return { paired: false, why: "not_ready" }; }
  const m = made.data;
  const minutes = (/** @type {number} */ exp) => Math.max(1, Math.round((Number(exp) - now()) / 60_000));
  /** @type {string} */ let shown = m.code || "";
  const tries = m.code_tries || 3;
  say("");
  say(W.intro); say(W.introPaste);
  if (m.art) say(String(m.art).replace(/\n$/, ""));
  say(fill(W.longCode, { long: m.qr })); say(W.longLife);
  if (m.code) { say(fill(W.typed, { code: m.code })); say(fill(W.typedLife, { minutes: minutes(m.code_expires || m.expires), tries })); }
  if (!io.tty) { say("  Finish setting up on your device once it has paired."); return { paired: false, why: "no_terminal" }; }
  const end = now() + (m.code ? 2 * FIVE_MIN : FIVE_MIN);
  while (now() < end) {
    if (m.code) {
      const cs = await tool("wink.code.status", {});
      const c = cs && cs.data;
      if (c && c.code && c.code !== shown) { say(fill(shown ? W.closed : "", { tries })); say(fill(W.newCode, { code: c.code, minutes: minutes(c.expires) })); shown = c.code; }
      if (c && c.state === "found" && c.offer) {
        say(W.typedFound);
        const typed = await io.ask(W.prompt);
        const r = await tool("wink.server.confirm", { offer: c.offer, typed });
        if (r.data && r.data.ok) say(W.matched);
        else {
          say(W.wrong);
          // a wrong ack closes the code and a fresh one replaces it with no tap: show it
          for (let i = 0; i < 6; i++) { await sleep(500); const n = await tool("wink.code.status", {}); if (n.data && n.data.code && n.data.code !== shown) { say(fill(W.newCode, { code: n.data.code, minutes: minutes(n.data.expires) })); shown = n.data.code; break; } }
        }
        continue;
      }
    }
    const q = await tool("wink.server.pairing", {});
    const a = q.data;
    if (a && a.asking) {
      say("");
      say(fill(W.asking, { name: a.name || "Someone" }));
      (a.choices || []).forEach((/** @type {string} */ w, /** @type {number} */ i) => say(`    ${i + 1}) ${w}`));
      const pick = Number(await io.ask(W.pickPrompt));
      if (![1, 2, 3].includes(pick)) { await tool("wink.server.pair.answer", { yes: false }); say(W.refused); return { paired: false, why: "refused" }; }
      const r = await tool("wink.server.pair.answer", { yes: true, pick });
      if (r.data && r.data.yes) { say("  Paired."); return { paired: true, ...(a.name ? { name: String(a.name) } : {}) }; }
      say(W.wrongWords);
      return { paired: false, why: "wrong_words" };
    }
    await sleep(2000);
  }
  say(W.ranOut);
  return { paired: false, why: "expired" };
}
