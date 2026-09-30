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
 * @typedef {{ stage: "start"|"install"|"found"|"named"|"tailscale"|"ai"|"devices"|"claim"|"done"|"stopped", installLine: string, code: string, lines: string[],
 *   box: null | { name: string, fingerprint: string, words: string[], handle: string|null },
 *   confirm: "none"|"pending"|"matched",
 *   channel: "none"|"connecting"|"ready"|"failed",
 *   naming: { input: string, check: null | { name: string, valid: boolean, available: boolean, why: string|null, address: string|null }, checking: boolean, claiming: boolean, error: string|null },
 *   named: null | { name: string, address: string|null, recoveryCode: string|null, saved: boolean },
 *   domain: { open: boolean, input: string, checking: boolean, error: string|null,
 *     result: null | { domain: string, ok: boolean, cname: { host: string, expected: string, found: string[], ok: boolean }, caa: { present: boolean, ok: boolean|null, optional: boolean } } },
 *   tailscale: { status: null | { state: string, login: string|null, tailnet: string|null, tailnetKind: string|null, ip: string|null }, loginUrl: string|null, busy: boolean, error: string|null,
 *     address: null | { phase: string, why: string|null } },
 *   ai: { accounts: { id: string, provider: string, flow: string|null, step: "starting"|"code"|"url"|"waiting"|"done"|"failed", url: string|null, code: string|null, paste: boolean, error: string|null }[] },
 *   devices: { phone: "idle"|"minting"|"showing"|"paired"|"expired"|"failed", expiresAt: number, error: string|null, paired: string|null },
 *   claim: { phase: "idle"|"minting"|"ready"|"expired"|"failed", url: string|null, expiresAt: number, error: string|null },
 *   error: null | { code: string, message: string }, expiresAt: number, listening: boolean }} FlowState
 * @typedef {{ createSetupKey: Function, setupCode: Function, resolveSetup: Function, setupWords: Function, mailboxReader: Function }} SetupClient
 * @typedef {{ call: (tool: string, input?: object) => Promise<any>, close: () => void }} BoxChannel
 */

/**
 * @param {{ client: SetupClient, relay: string, connect?: (o: { offer: any, key: any, secret: Uint8Array }) => Promise<BoxChannel>, installUrl?: string, random?: (n: number) => Uint8Array,
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
  const blankTs = () => ({ status: null, loginUrl: null, busy: false, error: null, address: null });
  const blankAi = () => ({ accounts: [] });
  const blankClaim = () => ({ phase: "idle", url: null, expiresAt: 0, error: null });
  const blankDevices = () => ({ phone: "idle", expiresAt: 0, error: null, paired: null });
  const blankDomain = () => ({ open: false, input: "", checking: false, error: null, result: null });
  const blankNaming = () => ({ input: "", check: null, checking: false, claiming: false, error: null });
  let state = { stage: "start", installLine: "", code: "", lines: [], box: null, confirm: "none", channel: "none", naming: blankNaming(), named: null, domain: blankDomain(), tailscale: blankTs(), ai: blankAi(), devices: blankDevices(), claim: blankClaim(), error: null, expiresAt: 0, listening: false };
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
  const set = patch => { state = { ...state, ...patch }; emit(); };
  const fail = code => { run++; closeChan(); pending = null; ticket = null; sess = null; set({ stage: "stopped", listening: false, error: { code, message: MESSAGES[code] || MESSAGES.relay } }); };

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
    closeChan(); checkSeq++; pending = null; ticket = null; sess = null;
    set({ stage: "install", installLine: lineFor(code), code, lines: [], box: null, confirm: "none", channel: "none", naming: blankNaming(), named: null, domain: blankDomain(), tailscale: blankTs(), ai: blankAi(), devices: blankDevices(), claim: blankClaim(), error: null, expiresAt: now() + TTL_MS, listening: true });
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

  // ---- Tailscale: the box joins, and the address is published once it has a tailnet address ----

  /** A link the box hands back is followed only if it is a plain https address with no login in it. @param {unknown} u @param {(host: string) => boolean} [okHost] */
  function safeUrl(u, okHost) {
    try {
      const x = new URL(String(u));
      if (x.protocol !== "https:" || x.username || x.password || x.href.length > 600 || /^[\d.]+$|^\[/.test(x.hostname)) return null;
      return !okHost || okHost(x.hostname) ? x.href : null;
    } catch { return null; }
  }
  const isTailscaleHost = h => h === "tailscale.com" || h.endsWith(".tailscale.com");

  /** After the recovery code is saved: on to the AI sign-in. */
  function continueToAi() {
    if (state.stage !== "named" || !state.named || (state.named.recoveryCode && !state.named.saved)) return;
    set({ stage: "ai" });
  }

  /** One signed-in AI is enough: on to Tailscale. */
  function continueToTailscale() {
    if (state.stage !== "ai" || !state.ai.accounts.some(a => a.step === "done")) return;
    set({ stage: "tailscale", tailscale: blankTs() });
    watchTailscale(run);
  }

  /**
   * Read the box's Tailscale state now, then again whenever the box says it changed (tailscale.changed) until it is connected and
   * the address is up. If the box's event stream is not there or breaks, a capped poll takes over: every few seconds, for at most
   * fifteen minutes, stopping at once when the box says the setup is over or answers with an error.
   */
  let watching = false;
  async function watchTailscale(mine) {
    if (watching) return;
    watching = true;
    try { await watchTailscaleLoop(mine); } finally { watching = false; }
  }
  async function watchTailscaleLoop(mine) {
    let stopFollow = () => {};
    let poked = false, over = false;
    const done = () => Boolean(state.tailscale.address && state.tailscale.address.phase === "serving");
    const read = async () => {
      const st = await chan.call("network.tailscale.status");
      if (mine !== run) return;
      const status = { state: String(st.state || ""), login: st.login ? String(st.login).slice(0, 120) : null, tailnet: st.tailnet ? String(st.tailnet).slice(0, 120) : null, tailnetKind: st.tailnetKind ? String(st.tailnetKind) : null, ip: st.ip ? String(st.ip).slice(0, 60) : null };
      set({ tailscale: { ...state.tailscale, status, error: null, loginUrl: status.state === "connected" ? null : state.tailscale.loginUrl } });
      if (status.state === "connected" && !done()) await publishAddress(mine);
    };
    const live = () => mine === run && state.stage === "tailscale" && chan;
    try { await read(); } catch (e) { if (live()) set({ tailscale: { ...state.tailscale, error: String(/** @type {Error} */ (e).message).slice(0, 200) } }); return; }
    if (!live() || done()) return;
    // Events first: each one is a reason to read again, and nothing polls while the box is quiet.
    let fellBack = typeof chan.follow !== "function";
    if (!fellBack) {
      stopFollow = chan.follow("tailscale.changed", () => { poked = true; }, err => { if (err && err.status === 401) over = true; fellBack = true; });
      while (live() && !done() && !fellBack && !over) {
        if (poked) { poked = false; try { await read(); } catch (e) { if (live()) set({ tailscale: { ...state.tailscale, error: String(/** @type {Error} */ (e).message).slice(0, 200) } }); stopFollow(); return; } }
        await sleep(200);
      }
      stopFollow();
    }
    if (!live() || done() || over) return;
    // The fallback: capped, and it stops when the box says the setup is over.
    const until = now() + 15 * 60_000;
    while (live() && !done() && now() < until) {
      await sleep(Math.max(pollMs, 1000));
      if (!live()) return;
      try { await read(); } catch (e) {
        if (!live()) return;
        // Any error ends the watching (setup_over most of all); Connect starts it again.
        set({ tailscale: { ...state.tailscale, error: String(/** @type {Error} */ (e).message).slice(0, 200) } });
        return;
      }
    }
  }

  /** With a tailnet address the name is claimed again, which publishes it and gets its certificate (names.claim's second run). */
  async function publishAddress(mine) {
    if (!chan || !state.named) return;
    try {
      const r = await chan.call("names.claim", { name: state.named.name });
      if (mine !== run) return;
      set({ tailscale: { ...state.tailscale, address: { phase: String((r && r.phase) || "dns"), why: r && r.why ? String(r.why).slice(0, 200) : null } } });
    } catch (e) { if (mine === run) set({ tailscale: { ...state.tailscale, error: String(/** @type {Error} */ (e).message).slice(0, 200) } }); }
  }

  /** "Connect": ask the box for Tailscale's own sign-in link. It is shown as a link to click, never opened for the person. */
  async function connectTailscale() {
    if (!chan || state.stage !== "tailscale" || state.tailscale.busy) return;
    const mine = run;
    set({ tailscale: { ...state.tailscale, busy: true, error: null } });
    try {
      const r = await chan.call("network.tailscale.login");
      if (mine !== run) return;
      const url = r && r.loginUrl ? safeUrl(r.loginUrl, isTailscaleHost) : null;
      set({ tailscale: { ...state.tailscale, busy: false, loginUrl: url, error: r && r.loginUrl && !url ? "The box gave a sign-in link that is not Tailscale's, so it was not shown." : null } });
      watchTailscale(mine);
    } catch (e) { if (mine === run) set({ tailscale: { ...state.tailscale, busy: false, error: String(/** @type {Error} */ (e).message).slice(0, 200) } }); }
  }

  // ---- Sign in to your AI: each provider's own login, one is enough to go on ----

  /** @param {string} provider "claude" | "codex" | "grok" */
  async function startAi(provider) {
    if (!chan || state.stage !== "ai") return;
    const mine = run;
    const id = `${provider}-${state.ai.accounts.length + 1}`;
    const row = { id, provider, flow: null, step: /** @type {const} */ ("starting"), url: null, code: null, paste: false, error: null };
    set({ ai: { accounts: [...state.ai.accounts.filter(a => a.provider !== provider || a.step === "done"), row] } });
    const upd = patch => { if (mine === run) set({ ai: { accounts: state.ai.accounts.map(a => (a.id === id ? { ...a, ...patch } : a)) } }); };
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
          if (r && r.step === "failed") return upd({ step: "failed", error: String((r.why || r.error || "the sign-in did not finish")).slice(0, 200) });
        } catch (e) { return upd({ step: "failed", error: String(/** @type {Error} */ (e).message).slice(0, 200) }); }
      } else await sleep(200);
    }
  }

  /** A code the person pasted back from the provider's page. @param {string} id @param {string} code */
  async function submitAiCode(id, code) {
    const a = state.ai.accounts.find(x => x.id === id);
    const text = String(code || "").trim();
    if (!chan || !a || !a.flow || !a.paste || !text || text.length > 400) return;
    const mine = run;
    const upd = patch => { if (mine === run) set({ ai: { accounts: state.ai.accounts.map(x => (x.id === id ? { ...x, ...patch } : x)) } }); };
    upd({ step: "waiting", error: null });
    try {
      const r = await chan.call("sessions.accounts.signin", { flow: a.flow, code: text });
      if (r && r.step === "failed") return upd({ step: "failed", paste: false, error: String(r.why || r.error || "that code did not work").slice(0, 200) });
      // Signed in, or still finishing: ask until it says.
      for (let i = 0; i < 40 && mine === run; i++) {
        const s2 = await chan.call("sessions.accounts.signin", { flow: a.flow });
        if (s2 && s2.step === "done") return upd({ step: "done", paste: false });
        if (s2 && s2.step === "failed") return upd({ step: "failed", paste: false, error: String(s2.why || s2.error || "the sign-in did not finish").slice(0, 200) });
        await sleep(pollMs);
      }
    } catch (e) { upd({ step: "failed", paste: false, error: String(/** @type {Error} */ (e).message).slice(0, 200) }); }
  }

  // ---- Devices: a phone pairs by scanning a ring drawn from the one ticket this page may make ----

  /** Once the address is live: on to devices. */
  function continueToDevices() {
    if (state.stage !== "tailscale" || !state.tailscale.address || state.tailscale.address.phase !== "serving") return;
    set({ stage: "devices", devices: blankDevices() });
  }

  /** "Add my phone": make the ticket (the setup key may make exactly one, good for five minutes) and wait for a phone to pair with it. */
  async function addPhone() {
    if (!chan || state.stage !== "devices" || (state.devices.phone !== "idle" && state.devices.phone !== "failed")) return;
    const mine = run;
    set({ devices: { ...state.devices, phone: "minting", error: null } });
    let baseline = 0;
    try {
      // Anything already on record does not count: only a pairing after this moment.
      const before = await chan.events("relay.paired", 0);
      baseline = before.reduce((n, e) => Math.max(n, e.id), 0);
      const r = await chan.call("relay.pair.ticket");
      if (mine !== run) return;
      ticket = String(r.ticket);
      set({ devices: { ...state.devices, phone: "showing", expiresAt: Number(r.expiresAt) || now() + 5 * 60_000 } });
    } catch (e) { if (mine === run) set({ devices: { ...state.devices, phone: "failed", error: String(/** @type {Error} */ (e).message).slice(0, 200) } }); return; }
    watchPairing(mine, baseline);
  }

  /** Follows the one ticket until a phone pairs with it or it runs out. */
  async function watchPairing(mine, baseline) {
    while (mine === run && state.stage === "devices" && state.devices.phone === "showing") {
      if (now() >= state.devices.expiresAt) { ticket = null; return set({ devices: { ...state.devices, phone: "expired" } }); }
      try {
        const got = await chan.events("relay.paired", baseline);
        if (mine !== run) return;
        if (got.length) {
          ticket = null;
          const name = got[0].payload && got[0].payload.name ? String(got[0].payload.name).slice(0, 60) : null;
          return set({ devices: { ...state.devices, phone: "paired", paired: name } });
        }
      } catch { /* a dropped poll: ask again */ }
      await sleep(Math.min(pollMs, Math.max(50, state.devices.expiresAt - now())));
    }
  }

  // ---- Arrive and claim: a one-time link to the person's own address, where the passkey is made ----

  /** From devices, whatever happened there (a phone can be added later): on to claiming. */
  function continueToClaim() {
    if (state.stage !== "devices" || state.devices.phone === "minting") return;
    set({ stage: "claim", claim: blankClaim() });
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
      // Fragment only: the token and the page key's public half, which the box's page hands to relay.setup.claim.
      const spki = btoa(String.fromCharCode(...sess.key.spki)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      set({ claim: { phase: "ready", url: `https://${host}/#claim=${token}&spki=${spki}`, expiresAt: Number(r.exp) || now() + 120_000, error: null } });
      // The two minutes run out; the link stops being shown then.
      (async () => { while (mine === run && state.claim.phase === "ready") { const left = state.claim.expiresAt - now(); if (left <= 0) return set({ claim: { ...state.claim, phase: "expired", url: null } }); await sleep(Math.min(left, 5000)); } })();
    } catch (e) { if (mine === run) set({ claim: { ...state.claim, phase: "failed", url: null, error: String(/** @type {Error} */ (e).message).slice(0, 200) } }); }
  }

  return {
    get state() { return state; },
    setName, claim, confirmWords, denyWords, markSaved, openDomain, setDomain, checkDomain,
    continueToClaim, mintClaim, continueToDevices, addPhone, currentTicket: () => ticket,
    continueToAi, continueToTailscale, connectTailscale, startAi, submitAiCode,
    /** Start (or start again): a new key and a new code; the old one is forgotten. */
    begin,
    /** Stop listening (the page is closing). */
    stop() { run++; closeChan(); set({ listening: false }); },
  };
}
