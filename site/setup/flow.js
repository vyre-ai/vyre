// @ts-check
// flow: the setup page's controller. No DOM and no imports: the relay client is handed in, so the same
// file runs in the browser (page.js) and under node --test.
//
// What it does today: make the page's key and a code (tailnet plan 3.6b), show the install line, follow the
// install as the box sends it, and say "found" once the relay holds the box's own sealed offer, with the four
// check words. Where the page is in the flow comes only from things the relay and the box signed: never from the
// text of a progress line. A line is somebody's words on a screen (anyone who saw the code could post one),
// so it is kept as plain text to display and nothing else.

/** How long a code lives, as the box counts it (core/relay/wire.js SETUP_TTL). */
export const TTL_MS = 60 * 60_000;
/** The most progress lines kept on the page, and how long one may be. */
export const MAX_LINES = 300;
export const MAX_LINE = 400;

/** Every message the page shows for a failure, by code. Plain words; none comes from the network. */
export const MESSAGES = Object.freeze({
  contested: "Two servers used this code. Start again.",
  expired: "This code has expired. Start again.",
  bad_line: "A progress line did not check out, so this page stopped listening. Start again.",
  out_of_order: "The progress lines arrived out of order, so this page stopped listening. Start again.",
  bad_record: "The answer for this code did not check out. Start again.",
  unauthorized: "The relay would not give this page the progress. Start again.",
  key: "This browser could not make the key the setup needs. Try a current Chrome, Safari, Edge or Firefox.",
  relay: "This page could not reach Vyre's relay. Check your connection, then start again.",
});

/**
 * @typedef {{ stage: "start"|"install"|"found"|"stopped", installLine: string, code: string, lines: string[],
 *   box: null | { name: string, fingerprint: string, words: string[], handle: string|null },
 *   error: null | { code: string, message: string }, expiresAt: number, listening: boolean }} FlowState
 * @typedef {{ createSetupKey: Function, setupCode: Function, resolveSetup: Function, setupWords: Function, mailboxReader: Function }} SetupClient
 */

/**
 * @param {{ client: SetupClient, relay: string, installUrl?: string, random?: (n: number) => Uint8Array,
 *   now?: () => number, sleep?: (ms: number) => Promise<void>, pollMs?: number, onChange?: (s: FlowState) => void }} o
 */
export function createFlow(o) {
  const now = o.now || Date.now;
  const sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const random = o.random || (n => globalThis.crypto.getRandomValues(new Uint8Array(n)));
  const installUrl = o.installUrl || "https://vyre.run/i";
  const pollMs = o.pollMs ?? 3000;
  /** @type {FlowState} */
  let state = { stage: "start", installLine: "", code: "", lines: [], box: null, error: null, expiresAt: 0, listening: false };
  let run = 0;
  const emit = () => o.onChange?.(state);
  const set = patch => { state = { ...state, ...patch }; emit(); };
  const fail = code => { run++; set({ stage: "stopped", listening: false, error: { code, message: MESSAGES[code] || MESSAGES.relay } }); };

  /** The install line, exactly as it must be run: the variable goes on sh, the reader of the script. */
  const lineFor = code => `curl -fsSL ${installUrl} | VYRE_CODE=${code} sh`;

  async function begin() {
    const mine = ++run;
    let key, secret, code;
    try {
      key = await o.client.createSetupKey();
      secret = random(16);
      code = await o.client.setupCode(secret, key.spki);
    } catch { return fail("key"); }
    if (mine !== run) return;
    set({ stage: "install", installLine: lineFor(code), code, lines: [], box: null, error: null, expiresAt: now() + TTL_MS, listening: true });
    followMailbox(mine, key, secret);
    waitForBox(mine, secret);
    // The hour is the box's; the page stops listening when it is over.
    (async () => {
      while (mine === run && state.stage === "install") {
        const left = state.expiresAt - now();
        if (left <= 0) return fail("expired");
        await sleep(Math.min(left, 60_000));
      }
    })();
  }

  /** The progress lines, as plain text. Never read for meaning. */
  async function followMailbox(mine, key, secret) {
    let reader;
    try { reader = await o.client.mailboxReader({ relay: o.relay, secret, key }); } catch { return fail("relay"); }
    let quiet = 0;
    while (mine === run && state.listening) {
      try {
        const got = await reader.next();
        if (mine !== run) return;
        if (got.length) set({ lines: [...state.lines, ...got.map(t => String(t).slice(0, MAX_LINE))].slice(-MAX_LINES) });
        quiet = 0;
      } catch (e) {
        const code = /** @type {any} */ (e).code;
        if (code === "contested" || code === "bad_line" || code === "out_of_order" || code === "unauthorized") return fail(code);
        // Not up yet, or a busy relay: wait and ask again, up to the hour.
        quiet++;
        await sleep(code === "rate_limited" ? 15_000 : Math.min(3000 * quiet, 15_000));
      }
    }
  }

  /** The box's own sealed offer appearing at the code's locator is the one sign that this is the server. */
  async function waitForBox(mine, secret) {
    while (mine === run && state.stage === "install") {
      try {
        const r = await o.client.resolveSetup(secret, { relay: o.relay });
        if (mine !== run) return;
        const words = await o.client.setupWords(r.offer.box, secret);
        return set({ stage: "found", box: { name: r.name, fingerprint: r.fingerprint, words, handle: r.handle }, error: null });
      } catch (e) {
        const code = /** @type {any} */ (e).code;
        if (code === "contested" || code === "bad_record") return fail(code);
        // ticket_gone: no offer yet. Anything else (a busy relay, a dropped connection): try again shortly.
        await sleep(code === "rate_limited" ? 15_000 : pollMs);
      }
    }
  }

  return {
    get state() { return state; },
    /** Start (or start again): a new key and a new code; the old one is forgotten. */
    begin,
    /** Stop listening (the page is closing). */
    stop() { run++; set({ listening: false }); },
  };
}
