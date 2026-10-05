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
  browser: "This browser is too old for the setup. It needs Chrome 133 or newer, Safari 17 or newer, Edge 133 or newer or Firefox 130 or newer.",
  key: "This browser could not make the key the setup needs. Try a current Chrome, Safari, Edge or Firefox.",
  relay: "This page could not reach Vyre's relay. Check your connection, then start again.",
  connect: "This page could not open a connection to your server. Start again.",
  mismatch: "The four words did not match, so that was not your server. Close this page and start again.",
});

/** The ten steps of the one flow, in order. `where` groups them on the timeline; `optional` ones carry a tag and a Skip. */
export const STEPS = Object.freeze([
  { id: "install", title: "Install", where: "On your server", optional: false },
  { id: "words", title: "Check the words", where: "On your server", optional: false },
  { id: "address", title: "Choose your address", where: "In your browser", optional: false },
  { id: "network", title: "Your network", where: "In your browser", optional: false },
  { id: "ai", title: "Sign in to your AI", where: "In your browser", optional: false },
  { id: "phone", title: "Add your phone", where: "In your browser", optional: true },
  { id: "passkey", title: "Create your passkey", where: "At your address", optional: false },
  { id: "assistant", title: "You and your assistant", where: "At your address", optional: false },
  { id: "computers", title: "Your computers", where: "At your address", optional: true },
  { id: "history", title: "Your history", where: "At your address", optional: true },
]);

/** The step the person is on, 1 to 10 (0 before the setup begins). Taken only from the flow's own stage, never from a progress line. @param {FlowState} s */
export function stepNumber(s) {
  switch (s.stage) {
    case "start": return 0;
    case "install": return 1;
    case "found": return s.confirm === "pending" ? 2 : 3;
    case "named": return 3;
    case "network": return 4;
    case "ai": return 5;
    case "devices": return 6;
    case "claim": return 7;
    case "done": return 8;
    default: return s.stoppedAt || 0;
  }
}

/** Every step with where it stands: done, current, skipped, failed or todo. Pure, so the same list draws on the page and (from the server) at the person's address. @param {FlowState} s */
export function stepList(s) {
  const at = stepNumber(s), stopped = s.stage === "stopped";
  return STEPS.map((st, i) => {
    const n = i + 1;
    const skipped = s.skipped.includes(st.id) && n < at;
    const status = stopped && n === at ? "failed" : skipped ? "skipped" : n < at ? "done" : n === at && s.stage !== "start" ? "current" : "todo";
    return { ...st, n, status };
  });
}

/** A first guess at an address from the server's own name: lower case letters, digits and hyphens. */
export function suggestName(text) {
  const s = String(text || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/g, "");
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s) ? s : "";
}

/**
 * @typedef {{ machine: "linux"|"mac", stage: "start"|"install"|"found"|"named"|"network"|"ai"|"devices"|"claim"|"done"|"stopped", installLine: string, code: string, lines: string[],
 *   box: null | { name: string, fingerprint: string, words: string[], handle: string|null },
 *   confirm: "none"|"pending"|"matched",
 *   channel: "none"|"connecting"|"ready"|"failed",
 *   naming: { input: string, check: null | { name: string, valid: boolean, available: boolean, why: string|null, address: string|null }, checking: boolean, claiming: boolean, error: string|null },
 *   named: null | { name: string, address: string|null, recoveryCode: string|null, saved: boolean },
 *   domain: { open: boolean, input: string, checking: boolean, error: string|null,
 *     result: null | { domain: string, ok: boolean, cname: { host: string, expected: string, found: string[], ok: boolean }, caa: { present: boolean, ok: boolean|null, optional: boolean } } },
 *   network: { status: null | { state: "connected"|"relayed"|"offline"|"joining"|"unknown", path: string|null }, busy: boolean, error: string|null },
 *   ai: { accounts: { id: string, provider: string, flow: string|null, step: "starting"|"code"|"url"|"waiting"|"done"|"failed", url: string|null, code: string|null, paste: boolean, error: string|null }[], keyKind: null|"openai-compatible"|"anthropic-compatible"|"openrouter", keyBusy: boolean },
 *   devices: { phone: "idle"|"minting"|"showing"|"paired"|"expired"|"failed", expiresAt: number, error: string|null, paired: string|null },
 *   claim: { phase: "idle"|"minting"|"ready"|"expired"|"failed", url: string|null, expiresAt: number, error: string|null },
 *   skipped: string[], stoppedAt: number, activity: string[],
 *   error: null | { code: string, message: string }, expiresAt: number, listening: boolean }} FlowState
 * @typedef {{ createSetupKey: Function, setupCode: Function, resolveSetup: Function, setupWords: Function, mailboxReader: Function }} SetupClient
 * @typedef {{ call: (tool: string, input?: object) => Promise<any>, close: () => void }} BoxChannel
 */

/**
 * @param {{ client: SetupClient, relay: string, pinRelay?: boolean, connect?: (o: { offer: any, key: any, secret: Uint8Array }) => Promise<BoxChannel>, installUrl?: string, random?: (n: number) => Uint8Array,
 *   now?: () => number, sleep?: (ms: number) => Promise<void>, pollMs?: number, debounceMs?: number, signinHosts?: string[]|null, signClaim?: (o: { privateKey: any, route: string, challenge: string, host: string }) => Promise<string>, onChange?: (s: FlowState) => void }} o
 */
export function createFlow(o) {
  const now = o.now || Date.now;
  const sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const random = o.random || (n => globalThis.crypto.getRandomValues(new Uint8Array(n)));
  const installUrl = o.installUrl || "https://vyre.run/i";
  const pollMs = o.pollMs ?? 3000;
  const debounceMs = o.debounceMs ?? 350;
  /** @type {FlowState} */
  const blankNet = () => ({ status: null, busy: false, error: null });
  const blankAi = () => ({ accounts: [], keyKind: null, keyBusy: false });
  const blankClaim = () => ({ phase: "idle", url: null, expiresAt: 0, error: null });
  const blankDevices = () => ({ phone: "idle", expiresAt: 0, error: null, paired: null });
  const blankDomain = () => ({ open: false, input: "", checking: false, error: null, result: null });
  const blankNaming = () => ({ input: "", check: null, checking: false, claiming: false, error: null });
  let state = { machine: "linux", stage: "start", installLine: "", code: "", lines: [], box: null, confirm: "none", channel: "none", naming: blankNaming(), named: null, domain: blankDomain(), network: blankNet(), ai: blankAi(), devices: blankDevices(), claim: blankClaim(), skipped: [], stoppedAt: 0, activity: [], error: null, expiresAt: 0, listening: false };
  let run = 0;
  /** @type {BoxChannel|null} */
  let chan = null;
  /** What openBox needs once the person has compared the words. @type {null | { mine: number, offer: any, key: any, secret: Uint8Array, name: string }} */
  let pending = null;
  let checkSeq = 0;
  /** The pairing ticket, held here only so the ring can be drawn from it: never in state, the DOM or a log. */
  let ticket = null;
  /** The page key and the box's offer, kept for signing the claim token. @type {null | { key: any, route: string }} */
  let sess = null;
  const closeChan = () => { try { chan?.close(); } catch { /* gone */ } chan = null; };
  const emit = () => o.onChange?.(state);
  /** What the page itself saw happen, in its own fixed words (never text from the network): one line per step as it moves. */
  const seen = (a, b) => {
    const out = [];
    if (a.confirm !== "matched" && b.confirm === "matched") out.push("The four words matched.");
    if (a.channel !== "ready" && b.channel === "ready") out.push("Connected to your server.");
    if (a.stage !== "named" && b.stage === "named" && b.named) out.push(`Claimed ${b.named.name}.vyre.run.`);
    if (!a.network.status && b.network.status) out.push(b.network.status.state === "relayed" ? "Your server is reachable through the relay." : b.network.status.state === "connected" ? "Your server is reachable directly." : "Looked at your server's network.");
    for (const acc of b.ai.accounts) { const was = a.ai.accounts.find(x => x.id === acc.id); if (acc.step === "done" && (!was || was.step !== "done")) out.push(`${acc.provider === "claude" ? "Claude" : acc.provider === "codex" ? "ChatGPT (Codex)" : "Grok"} signed in.`); }
    if (b.skipped.includes("ai") && !a.skipped.includes("ai")) out.push("Skipped the AI sign-in. One can be added later in Settings.");
    if (a.devices.phone !== "paired" && b.devices.phone === "paired") out.push("Your phone paired.");
    if (b.skipped.includes("phone") && !a.skipped.includes("phone")) out.push("Skipped adding a phone.");
    if (a.claim.phase !== "ready" && b.claim.phase === "ready") out.push("Made a one-time link to your server.");
    if (a.stage !== "done" && b.stage === "done") out.push("Passkey made. Setup carries on at your address.");
    return out;
  };
  const set = patch => { const prev = state; state = { ...state, ...patch }; const more = seen(prev, state); if (more.length) state = { ...state, activity: [...state.activity, ...more].slice(-MAX_LINES) }; emit(); };
  const fail = code => { const at = stepNumber(state); run++; closeChan(); pending = null; ticket = null; sess = null; set({ stage: "stopped", stoppedAt: at || state.stoppedAt, listening: false, error: { code, message: MESSAGES[code] || MESSAGES.relay } }); };

  /** The install line, exactly as it must be run: the variable goes on sh, the reader of the script. */
  const lineFor = code => `curl -fsSL ${installUrl} | VYRE_CODE=${code} sh`;

  /** @param {"linux"|"mac"} [machine] where Vyre will live; left out, the last choice stands (Start again keeps it). */
  async function begin(machine) {
    const mine = ++run;
    if (machine === "linux" || machine === "mac") state = { ...state, machine };
    let key, secret, code;
    // A browser with no X25519 would only fail later, at the connection, with a message about the server.
    if (o.supported && !(await Promise.resolve(o.supported()).catch(() => false))) return fail("browser");
    try {
      key = await o.client.createSetupKey();
      secret = random(16);
      code = await o.client.setupCode(secret, key.spki);
    } catch { return fail("key"); }
    if (mine !== run) return;
    closeChan(); checkSeq++; pending = null; ticket = null; sess = null;
    set({ stage: "install", installLine: lineFor(code), code, lines: [], box: null, confirm: "none", channel: "none", naming: blankNaming(), named: null, domain: blankDomain(), network: blankNet(), ai: blankAi(), devices: blankDevices(), claim: blankClaim(), skipped: [], stoppedAt: 0, activity: [], error: null, expiresAt: now() + TTL_MS, listening: true });
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
    sess = { key: p.key, route: p.offer.route };
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
    // The page talks to the box only through the relay it was built for. An offer naming any other host (a private address or a name that
    // resolves to one) would make the browser ask for Local Network Access and hang on its prompt; it is refused before anything connects.
    if (o.pinRelay) {
      const hostOf = u => { try { return new URL(String(u).replace(/^ws/, "http")).host; } catch { return null; } };
      if (hostOf(offer.relay) === null || hostOf(offer.relay) !== hostOf(o.relay)) { set({ channel: "failed", error: { code: "connect", message: MESSAGES.connect } }); return; }
    }
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

  // ---- Own domain: an optional step after the address is claimed. The box reads the DNS live; this only shows what it found ----

  const DOMAIN_SHAPE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
  const tidy = t => String(t || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/.]+$/, "").slice(0, 100);
  const domainOk = ok => state.stage === "named" && state.named && (!state.named.recoveryCode || state.named.saved) && ok !== false;

  /** Show or hide the own-domain form. */
  function openDomain(open = true) {
    if (!domainOk()) return;
    set({ domain: { ...state.domain, open: Boolean(open), error: null } });
  }

  /** Ask the box to look up the records for a domain of the person's own. Asking again after adding them is the way to see them arrive. @param {string} [text] */
  async function checkDomain(text) {
    if (!chan || !domainOk() || state.domain.checking) return;
    const domain = tidy(text ?? state.domain.input);
    if (!DOMAIN_SHAPE.test(domain)) return set({ domain: { ...state.domain, input: domain, error: "That does not look like a domain, for example harlowlegal.com.", result: null } });
    const mine = run;
    set({ domain: { ...state.domain, input: domain, checking: true, error: null } });
    try {
      const r = await chan.call("names.domain.check", { domain });
      if (mine !== run) return;
      const list = v => (Array.isArray(v) ? v : []).slice(0, 5).map(x => String(x).slice(0, 253));
      const c = (r && r.cname) || {}, a = (r && r.caa) || {};
      set({ domain: { ...state.domain, checking: false, error: null, result: { domain: String(r.domain || domain).slice(0, 253), ok: r.ok === true,
        cname: { host: String(c.host || `_acme-challenge.${domain}`).slice(0, 300), expected: String(c.expected || "").slice(0, 253), found: list(c.found), ok: c.ok === true },
        caa: { present: a.present === true, ok: a.ok === true ? true : a.ok === false ? false : null, optional: true } } } });
    } catch (e) {
      if (mine !== run) return;
      set({ domain: { ...state.domain, checking: false, result: null, error: String(/** @type {Error} */ (e).message).slice(0, 200) } });
    }
  }

  /** Forget the typed domain's answer as soon as the text changes: an old "in place" must never sit beside a new name. @param {string} text */
  function setDomain(text) {
    if (state.stage !== "named") return;
    set({ domain: { ...state.domain, input: String(text || "").slice(0, 100), result: null, error: null } });
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

  /** A link the box hands back is followed only if it is a plain https address with no login in it. @param {unknown} u @param {(host: string) => boolean} [okHost] */
  function safeUrl(u, okHost) {
    try {
      const x = new URL(String(u));
      if (x.protocol !== "https:" || x.username || x.password || x.href.length > 600 || /^[\d.]+$|^\[/.test(x.hostname)) return null;
      return !okHost || okHost(x.hostname) ? x.href : null;
    } catch { return null; }
  }

  // ---- Your network: built in, so there is nothing to connect; the page only shows how the server is reachable ----

  /** After the recovery code is saved: on to the network step, which reads the server's status once. */
  function continueToNetwork() {
    if (state.stage !== "named" || !state.named || (state.named.recoveryCode && !state.named.saved)) return;
    set({ stage: "network", network: blankNet() });
    readNetwork(run);
  }

  /** Read how the server is reachable: network.wink.status, the one network tool this channel may call. Said in fixed words, never in text from the network. */
  async function readNetwork(mine) {
    if (!chan || state.stage !== "network" || state.network.busy) return;
    set({ network: { ...state.network, busy: true, error: null } });
    try {
      const st = await chan.call("network.wink.status");
      if (mine !== run) return;
      const rows = st && Array.isArray(st.spaces) ? st.spaces : [];
      const first = rows[0] || null;
      const ok = first && ["connected", "relayed", "offline", "joining"].includes(first.state) ? first.state : st && st.relay && (st.relay.ok || st.relay.connected) ? "relayed" : "unknown";
      set({ network: { status: { state: /** @type {any} */ (ok), path: first && first.path ? String(first.path).slice(0, 20) : null }, busy: false, error: null } });
    } catch (e) { if (mine === run) set({ network: { ...state.network, busy: false, error: String(/** @type {Error} */ (e).message).slice(0, 200) } }); }
  }

  /** On to the AI sign-in, once the page has looked at the network (an answer or an error: it never blocks the setup). */
  function continueToAi() {
    if (state.stage !== "network" || (!state.network.status && !state.network.error)) return;
    set({ stage: "ai" });
  }

  /** One signed-in AI is enough: on to the phone. */
  function continueToDevices() {
    if (state.stage !== "ai" || !state.ai.accounts.some(a => a.step === "done")) return;
    set({ stage: "devices", devices: blankDevices() });
  }

  /** "Skip for now": no AI yet. It stays on the list as skipped, and one can be added later in Settings. */
  function skipAi() {
    if (state.stage !== "ai" || state.ai.accounts.some(a => a.step === "done")) return;
    set({ stage: "devices", devices: blankDevices(), skipped: [...state.skipped, "ai"] });
  }

  // ---- Sign in to your AI: each provider's own login, one is enough to go on ----

  /** @param {string} provider "claude" | "codex" | "grok" */
  async function startAi(provider) {
    if (!chan || state.stage !== "ai") return;
    const mine = run;
    const id = `${provider}-${state.ai.accounts.length + 1}`;
    const row = { id, provider, flow: null, step: /** @type {const} */ ("starting"), url: null, code: null, paste: false, error: null };
    set({ ai: { ...state.ai, accounts: [...state.ai.accounts.filter(a => a.provider !== provider || a.step === "done"), row] } });
    const upd = patch => { if (mine === run) set({ ai: { ...state.ai, accounts: state.ai.accounts.map(a => (a.id === id ? { ...a, ...patch } : a)) } }); };
    try {
      const r = await chan.call("sessions.accounts.signin", { provider });
      const hosts = o.signinHosts;
      const url = r && r.url ? safeUrl(r.url, hosts ? h => hosts.some(x => h === x || h.endsWith(`.${x}`)) : undefined) : null;
      upd({ flow: String(r.flow), step: r.step === "url" ? "url" : "code", url, code: r.code ? String(r.code).slice(0, 80) : null, paste: Boolean(r.paste || r.step === "url") });
      // A link that is not a plain https address is not shown and the sign-in is not followed.
      if (r.url && !url) return upd({ step: "failed", url: null, code: null, error: "The box gave a sign-in link that is not a plain https address, so it was not shown." });
    } catch (e) { return upd({ step: "failed", error: String(/** @type {Error} */ (e).message).slice(0, 200) }); }
    // A login that hands back a code to type at the provider finishes on its own; one that wants a code pasted back waits for it.
    while (mine === run) {
      const a = state.ai.accounts.find(x => x.id === id);
      if (!a || a.step === "done" || a.step === "failed") return;
      if (!a.paste) {
        await sleep(pollMs);
        if (mine !== run) return;
        try {
          const r = await chan.call("sessions.accounts.signin", { flow: a.flow });
          if (r && r.step === "done") return upd({ step: "done", error: null });
          if (r && r.step === "failed") return upd({ step: "failed", error: String((r.message || r.why || r.error || "the sign-in did not finish")).slice(0, 200) });
        } catch (e) { return upd({ step: "failed", error: String(/** @type {Error} */ (e).message).slice(0, 200) }); }
      } else await sleep(200);
    }
  }

  // ---- an API key instead of a login: one of three kinds, checked and stored by the box, never shown again ----

  const KEY_KINDS = /** @type {const} */ (["openai-compatible", "anthropic-compatible", "openrouter"]);

  /** Open (or close) the form for one kind of key. @param {string} kind */
  function openAiKey(kind) {
    if (!chan || state.stage !== "ai" || state.ai.keyBusy || !KEY_KINDS.includes(/** @type {any} */ (kind))) return;
    set({ ai: { ...state.ai, keyKind: state.ai.keyKind === kind ? null : /** @type {any} */ (kind) } });
  }

  /**
   * Send a key to the box, which checks it with one small call, puts it in its vault and makes an account bound to its address. The key is held only for this call:
   * it is never put in the state, an error never carries it, and the form closes on success.
   * @param {{ kind: string, key: string, base_url?: string, model?: string }} f
   */
  async function submitAiKey(f) {
    if (!chan || state.stage !== "ai" || state.ai.keyBusy || !KEY_KINDS.includes(/** @type {any} */ (f.kind))) return;
    const mine = run;
    const id = `key-${f.kind}-${state.ai.accounts.length + 1}`;
    const key = String(f.key || "").trim();
    const row = { id, provider: f.kind, flow: null, step: /** @type {const} */ ("waiting"), url: null, code: null, paste: false, error: null };
    if (key.length < 12 || key.length > 400 || /\s/.test(key)) { set({ ai: { ...state.ai, accounts: [...state.ai.accounts.filter(a => a.provider !== f.kind || a.step === "done"), { ...row, step: "failed", error: "That does not look like an API key." }] } }); return; }
    set({ ai: { ...state.ai, keyBusy: true, accounts: [...state.ai.accounts.filter(a => a.provider !== f.kind || a.step === "done"), row] } });
    const upd = (/** @type {any} */ patch, /** @type {any} */ extra = {}) => { if (mine === run) set({ ai: { ...state.ai, ...extra, accounts: state.ai.accounts.map(a => (a.id === id ? { ...a, ...patch } : a)) } }); };
    try {
      const input = { kind: f.kind, key, ...(f.base_url && String(f.base_url).trim() ? { base_url: String(f.base_url).trim().slice(0, 300) } : {}), ...(f.model && String(f.model).trim() ? { model: String(f.model).trim().slice(0, 100) } : {}) };
      await chan.call("sessions.accounts.key", input);
      upd({ step: "done", error: null }, { keyBusy: false, keyKind: null });
    } catch (e) { upd({ step: "failed", error: String(/** @type {Error} */ (e).message).split(key).join("[key]").slice(0, 200) }, { keyBusy: false }); }
  }

  /** A code the person pasted back from the provider's page. @param {string} id @param {string} code */
  async function submitAiCode(id, code) {
    const a = state.ai.accounts.find(x => x.id === id);
    const text = String(code || "").trim();
    if (!chan || !a || !a.flow || !a.paste || !text || text.length > 400) return;
    const mine = run;
    const upd = patch => { if (mine === run) set({ ai: { ...state.ai, accounts: state.ai.accounts.map(x => (x.id === id ? { ...x, ...patch } : x)) } }); };
    upd({ step: "waiting", error: null });
    try {
      const r = await chan.call("sessions.accounts.signin", { flow: a.flow, code: text });
      if (r && r.step === "failed") return upd({ step: "failed", paste: false, error: String(r.message || r.why || r.error || "that code did not work").slice(0, 200) });
      // Signed in, or still finishing: ask until it says.
      for (let i = 0; i < 40 && mine === run; i++) {
        const s2 = await chan.call("sessions.accounts.signin", { flow: a.flow });
        if (s2 && s2.step === "done") return upd({ step: "done", paste: false });
        if (s2 && s2.step === "failed") return upd({ step: "failed", paste: false, error: String(s2.message || s2.why || s2.error || "the sign-in did not finish").slice(0, 200) });
        await sleep(pollMs);
      }
    } catch (e) { upd({ step: "failed", paste: false, error: String(/** @type {Error} */ (e).message).slice(0, 200) }); }
  }

  // ---- Devices: this page makes no pairing ticket. The first device pairs through the install terminal's own gated flow (a QR or a long code, then three words), and
  // everything after that is set up on the person's device, never here (the user's ruling, 4 Oct 2026; one pairing path). `addPhone` stays so the screen's button table is
  // unchanged, and does nothing.
  async function addPhone() { /* no ticket is made here */ }

  // ---- Arrive and claim: a one-time link to the person's own address, where the passkey is made ----

  /** From devices, whatever happened there (a phone can be added later): on to claiming. */
  function continueToClaim() {
    if (state.stage !== "devices" || state.devices.phone === "minting") return;
    set({ stage: "claim", claim: blankClaim(), skipped: state.devices.phone === "paired" ? state.skipped : [...state.skipped, "phone"] });
    // The box ends the setup session itself when the first owner enrols, and says so only by answering 401 setup_over or closing
    // the channel (4401). A session that ends before the hour is up was claimed (or replaced); at the hour it expired.
    const mine = run;
    const ended = () => {
      if (mine !== run || (state.stage !== "claim" && state.stage !== "devices")) return;
      if (now() >= state.expiresAt) return fail("expired");
      closeChan();
      set({ stage: "done", listening: false });
    };
    if (chan && typeof chan.onClose === "function") chan.onClose(ended);
    (async () => {
      while (mine === run && state.stage === "claim") {
        await sleep(Math.max(pollMs, 1000));
        if (mine !== run || state.stage !== "claim" || !chan) return;
        try { await chan.call("relay.setup.status"); }
        catch (e) { const code = /** @type {any} */ (e).code, status = /** @type {any} */ (e).status; if (code === "setup_over" || status === 401) return ended(); }
      }
    })();
  }

  /** A fresh link: the box's challenge, signed here with the page key, in the fragment of the person's own address. Good for two minutes. */
  async function mintClaim() {
    if (!chan || !sess || !o.signClaim || state.stage !== "claim" || state.claim.phase === "minting" || !state.named) return;
    const mine = run;
    set({ claim: { ...state.claim, phase: "minting", error: null } });
    try {
      const host = `${state.named.name}.vyre.run`;
      const r = await chan.call("relay.setup.claim-token", { host });
      const token = await o.signClaim({ privateKey: sess.key.privateKey, route: String(r.route || sess.route), challenge: String(r.challenge), host });
      if (mine !== run) return;
      // Fragment only: the token and the page key's public half, which the box's passkey page (/onboard/passkey, not the Deck at /) hands to relay.setup.claim.
      const spki = btoa(String.fromCharCode(...sess.key.spki)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      set({ claim: { phase: "ready", url: `https://${host}/onboard/passkey#claim=${token}&spki=${spki}`, expiresAt: Number(r.exp) || now() + 120_000, error: null } });
      // The two minutes run out; the link stops being shown then.
      (async () => { while (mine === run && state.claim.phase === "ready") { const left = state.claim.expiresAt - now(); if (left <= 0) return set({ claim: { ...state.claim, phase: "expired", url: null } }); await sleep(Math.min(left, 5000)); } })();
    } catch (e) { if (mine === run) set({ claim: { ...state.claim, phase: "failed", url: null, error: String(/** @type {Error} */ (e).message).slice(0, 200) } }); }
  }

  return {
    get state() { return state; },
    setName, claim, confirmWords, denyWords, markSaved, openDomain, setDomain, checkDomain,
    continueToClaim, mintClaim, continueToDevices, addPhone, currentTicket: () => null,
    continueToAi, continueToNetwork, readNetwork: () => readNetwork(run), skipAi, startAi, submitAiCode, openAiKey, submitAiKey,
    /** Start (or start again): a new key and a new code; the old one is forgotten. */
    begin,
    /** Stop listening (the page is closing). */
    stop() { run++; closeChan(); set({ listening: false }); },
  };
}
