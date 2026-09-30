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
  connect: "This page could not open a connection to your server. Start again.",
  mismatch: "The four words did not match, so that was not your server. Close this page and start again.",
});

/** A first guess at an address from the server's own name: lower case letters, digits and hyphens. */
export function suggestName(text) {
  const s = String(text || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/g, "");
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s) ? s : "";
}

/**
 * @typedef {{ stage: "start"|"install"|"found"|"named"|"stopped", installLine: string, code: string, lines: string[],
 *   box: null | { name: string, fingerprint: string, words: string[], handle: string|null },
 *   confirm: "none"|"pending"|"matched",
 *   channel: "none"|"connecting"|"ready"|"failed",
 *   naming: { input: string, check: null | { name: string, valid: boolean, available: boolean, why: string|null, address: string|null }, checking: boolean, claiming: boolean, error: string|null },
 *   named: null | { name: string, address: string|null, recoveryCode: string|null, saved: boolean },
 *   error: null | { code: string, message: string }, expiresAt: number, listening: boolean }} FlowState
 * @typedef {{ createSetupKey: Function, setupCode: Function, resolveSetup: Function, setupWords: Function, mailboxReader: Function }} SetupClient
 * @typedef {{ call: (tool: string, input?: object) => Promise<any>, close: () => void }} BoxChannel
 */

/**
 * @param {{ client: SetupClient, relay: string, connect?: (o: { offer: any, key: any, secret: Uint8Array }) => Promise<BoxChannel>, installUrl?: string, random?: (n: number) => Uint8Array,
 *   now?: () => number, sleep?: (ms: number) => Promise<void>, pollMs?: number, debounceMs?: number, onChange?: (s: FlowState) => void }} o
 */
export function createFlow(o) {
  const now = o.now || Date.now;
  const sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const random = o.random || (n => globalThis.crypto.getRandomValues(new Uint8Array(n)));
  const installUrl = o.installUrl || "https://vyre.run/i";
  const pollMs = o.pollMs ?? 3000;
  const debounceMs = o.debounceMs ?? 350;
  /** @type {FlowState} */
  const blankNaming = () => ({ input: "", check: null, checking: false, claiming: false, error: null });
  let state = { stage: "start", installLine: "", code: "", lines: [], box: null, confirm: "none", channel: "none", naming: blankNaming(), named: null, error: null, expiresAt: 0, listening: false };
  let run = 0;
  /** @type {BoxChannel|null} */
  let chan = null;
  /** What openBox needs once the person has compared the words. @type {null | { mine: number, offer: any, key: any, secret: Uint8Array, name: string }} */
  let pending = null;
  let checkSeq = 0;
  const closeChan = () => { try { chan?.close(); } catch { /* gone */ } chan = null; };
  const emit = () => o.onChange?.(state);
  const set = patch => { state = { ...state, ...patch }; emit(); };
  const fail = code => { run++; closeChan(); pending = null; set({ stage: "stopped", listening: false, error: { code, message: MESSAGES[code] || MESSAGES.relay } }); };

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
    closeChan(); checkSeq++; pending = null;
    set({ stage: "install", installLine: lineFor(code), code, lines: [], box: null, confirm: "none", channel: "none", naming: blankNaming(), named: null, error: null, expiresAt: now() + TTL_MS, listening: true });
    followMailbox(mine, key, secret);
    waitForBox(mine, key, secret);
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
  async function waitForBox(mine, key, secret) {
    while (mine === run && state.stage === "install") {
      try {
        const r = await o.client.resolveSetup(secret, { relay: o.relay });
        if (mine !== run) return;
        const words = await o.client.setupWords(r.offer.box, secret);
        // Anyone who saw the code could have put a sealed offer here first, so the page goes no further
        // (no connection, no name form) until the person says the four words match their own terminal.
        pending = { mine, offer: r.offer, key, secret, name: r.name };
        return set({ stage: "found", confirm: "pending", box: { name: r.name, fingerprint: r.fingerprint, words, handle: r.handle }, error: null });
      } catch (e) {
        const code = /** @type {any} */ (e).code;
        if (code === "contested" || code === "bad_record") return fail(code);
        // ticket_gone: no offer yet. Anything else (a busy relay, a dropped connection): try again shortly.
        await sleep(code === "rate_limited" ? 15_000 : pollMs);
      }
    }
  }

  /** "These match my server's terminal": now, and only now, the connection opens. */
  function confirmWords() {
    const p = pending;
    if (!p || p.mine !== run || state.stage !== "found" || state.confirm !== "pending") return;
    pending = null;
    set({ confirm: "matched" });
    return openBox(p.mine, p.offer, p.key, p.secret, p.name);
  }
  /** "They don't match": not this server. Nothing was opened, nothing is kept. */
  function denyWords() {
    if (state.stage !== "found" || state.confirm !== "pending") return;
    pending = null;
    fail("mismatch");
  }

  /** Open the page's own connection to the server it found, then offer a first name. */
  async function openBox(mine, offer, key, secret, boxName) {
    if (!o.connect) return;
    set({ channel: "connecting" });
    let c;
    try { c = await o.connect({ offer, key, secret }); } catch { if (mine === run) set({ channel: "failed", error: { code: "connect", message: MESSAGES.connect } }); return; }
    if (mine !== run) { try { c.close(); } catch { /* gone */ } return; }
    chan = c;
    set({ channel: "ready", error: null });
    const guess = suggestName(boxName);
    if (guess) await setName(guess);
  }

  /** The name being typed: checked live, and only the newest answer counts. */
  async function setName(text) {
    const input = String(text).toLowerCase().slice(0, 40);
    set({ naming: { ...state.naming, input, check: null, checking: Boolean(input), error: null } });
    if (!input || !chan) return;
    const mine = run, seq = ++checkSeq;
    await sleep(debounceMs);
    if (seq !== checkSeq || mine !== run || !chan) return;
    try {
      const r = await chan.call("names.check", { name: input });
      if (seq !== checkSeq || mine !== run) return;
      set({ naming: { ...state.naming, checking: false, check: { name: String(r.name || input), valid: Boolean(r.valid), available: Boolean(r.available), why: r.why ? String(r.why).slice(0, 200) : null, address: r.address ? String(r.address).slice(0, 200) : null } } });
    } catch (e) {
      if (seq !== checkSeq || mine !== run) return;
      set({ naming: { ...state.naming, checking: false, error: String(/** @type {Error} */ (e).message).slice(0, 200) } });
    }
  }

  /** "I saved it": the warning about closing the page before the code is safe goes away. */
  function markSaved() {
    if (state.named) set({ named: { ...state.named, saved: true } });
  }

  /** Claim the name that was just checked as free. The recovery code comes back once and is kept only in this state. */
  async function claim() {
    const n = state.naming;
    if (!chan || !n.check || !n.check.available || n.claiming || state.stage !== "found") return;
    const mine = run;
    set({ naming: { ...n, claiming: true, error: null } });
    try {
      const r = await chan.call("names.claim", { name: n.check.name });
      if (mine !== run) return;
      if (r && r.phase === "failed") return set({ naming: { ...state.naming, claiming: false, error: String(r.why || "the name could not be claimed").slice(0, 200) } });
      set({ stage: "named", naming: { ...state.naming, claiming: false }, named: { name: n.check.name, address: (r && r.address) || n.check.address, recoveryCode: r && r.recoveryCode ? String(r.recoveryCode) : null, saved: false } });
    } catch (e) {
      if (mine !== run) return;
      set({ naming: { ...state.naming, claiming: false, error: String(/** @type {Error} */ (e).message).slice(0, 200) } });
    }
  }

  return {
    get state() { return state; },
    setName, claim, confirmWords, denyWords, markSaved,
    /** Start (or start again): a new key and a new code; the old one is forgotten. */
    begin,
    /** Stop listening (the page is closing). */
    stop() { run++; closeChan(); set({ listening: false }); },
  };
}
