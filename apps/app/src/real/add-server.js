// @ts-check
import { installLine } from "../../screens/install/first-run.js";
// add-server: the ONE way a server joins a person's Vyre (spec 0.3.0 part 10). It serves an upgrade from Home to Cloud, a second server, a replacement server and a team space's first server alike.
//
//   1. The app makes a one-time setup code (relay/client/setup.js: a key only this app holds, and a secret) and shows the install line that carries it, with the Records choice.
//   2. The server's installer registers a sealed offer at the code's place on the relay and posts its progress there, and prints four check words. Nothing needs copying back.
//   3. The app finds the offer and shows its own four words; the person says they match the server's terminal (that is the confirm, in the app, never at the server).
//   4. Only then does the app open the setup channel (admitted for its key alone), ask the unowned server for a pairing ticket for THIS identity (wink.server.setup-offer), and pair with it the way
//      a scanned code does: the identity's signature is the proof, so nobody answers a question at the terminal.
//
// What comes after (the space on the server, and moving everything onto it) is the existing My Cloud card's: spaces.create with the server as home, then spaces.upgrade.*. This file is pure: every
// outside thing (the relay client, the channel, the pairing) comes in as a port, so Node tests it against fakes and against a real server over a real relay.

export const SETUP_TTL_MS = 3_600_000;

/** The two choices, the same for every space: Records recommended and first, preselected. `store` is VYRE_STORE on the install line. */
/** Which kind of machine the server is: the line differs (a Linux server or cloud machine, or a Mac that stays on). */
export const SERVER_KINDS = Object.freeze([
  { id: "linux", label: "A Linux server, or a cloud server", where: "On the server, paste this line. Use your own account, not root." },
  { id: "mac", label: "A Mac that stays on", where: "On the Mac, open Terminal and paste this line. It asks for the Mac password once." },
]);

export const CHOICES = Object.freeze([
  Object.freeze({ id: "records", store: "auto", label: "With Records (recommended)", note: "Keeps your contacts, projects and tasks. Needs 8 GB of memory. 4 GB is the least.", minMb: 3500, recommendedMb: 7500 }),
  Object.freeze({ id: "plain", store: "sqlite", label: "Without Records", note: "For a small server. 2 GB is enough. You can add Records later.", minMb: 1800, recommendedMb: 1800 }),
]);
export const DEFAULT_CHOICE = "records";

/** What a server unlocks, said once on the screen that offers it. */
export const GAINS = Object.freeze([
  "Your assistants keep working when this computer sleeps.",
  "Your phone reaches everything from anywhere.",
  "Watchers and schedules run all the time.",
  "Your team can join.",
]);

/** @param {string} id */
export const choiceOf = id => CHOICES.find(c => c.id === id) || CHOICES[0];

/**
 * What to say once the server's memory is known (system.info over the setup channel): nothing when it suits the choice, plain words when it does not. Records can be turned on later in Settings
 * when the server has the memory, so a small server with the Records choice is told it will start without them.
 * @param {string} id @param {number} memoryMb
 */
export function memoryNote(id, memoryMb) {
  const c = choiceOf(id);
  if (!Number.isFinite(memoryMb) || memoryMb <= 0) return null;
  const gb = Math.round(memoryMb / 102.4) / 10;
  if (c.id === "records" && memoryMb < c.minMb) return `This server has ${gb} GB of memory, which is less than Records needs. Vyre will start without Records. You can change this in Settings.`;
  if (c.id === "plain" && memoryMb < c.minMb) return `This server has ${gb} GB of memory, which is less than the 2 GB a small server needs.`;
  return null;
}

/**
 * FileVault warning for the server card (always-online): a Mac server with FileVault on waits at the login window after a power cut and runs nothing until someone signs in. system.info says "on", "off",
 * "unknown" or null (not a Mac); only "on" is said. Vyre never changes FileVault.
 * @param {unknown} filevault
 */
export function filevaultNote(filevault) {
  return filevault === "on" ? "FileVault is on. After a power cut or a restart this Mac will wait for someone to type the password, and Vyre will be offline until then. For a server, turn FileVault off in System Settings, Privacy and Security, then run this line again. To keep FileVault anyway, run the line with VYRE_ACCEPT_FILEVAULT=1." : null;
}

/** The notes the server card shows, in one line each: memory first, then FileVault. @param {(string | null)[]} notes */
export const joinNotes = (...notes) => notes.filter(Boolean).join(" ") || null;

/** Plain words by code; nothing a server or the network says reaches the screen. */
export const MESSAGES = Object.freeze({
  expired: "The hour for this line ran out. Start again for a new one.",
  mismatch: "Those words are different, so this may not be your server. Nothing was connected. Start again.",
  contested: "Two servers used this line. Start again for a new one.",
  relay: "Vyre could not connect. Check your internet, then start again.",
  connect: "Vyre found your server but could not connect to it. Start again.",
  pair: "Your server did not finish connecting. Start again.",
  key: "This computer could not make a key for the line. Try again.",
});

/**
 * @typedef {{ stage: "idle"|"install"|"found"|"pairing"|"done"|"stopped", choice: string, installLine: string, code: string, lines: string[],
 *   box: null | { name: string, fingerprint: string, words: string[], route: string }, memoryMb: number|null, note: string|null, error: null | { code: string, message: string }, expiresAt: number }} AddServerState
 * @typedef {{ createSetupKey: Function, setupCode: Function, resolveSetup: Function, setupWords: Function, mailboxReader: Function }} SetupClient
 */

/**
 * @param {{ client: SetupClient, relay: string, identity: () => Promise<{ id: string }>, connect: (o: { offer: any, key: any, secret: Uint8Array }) => Promise<{ call: (tool: string, input?: object) => Promise<any>, close: () => void }>,
 *   pair: (qr: string, opts?: { pageKey?: any }) => Promise<void>, random?: (n: number) => Uint8Array, now?: () => number, sleep?: (ms: number) => Promise<void>, pollMs?: number, version?: string | null, onChange?: (s: AddServerState) => void }} o
 */
export function createAddServer(o) {
  const now = o.now || Date.now;
  const sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const random = o.random || (n => globalThis.crypto.getRandomValues(new Uint8Array(n)));
  const pollMs = o.pollMs ?? 3000;
  /** @type {AddServerState} */
  let state = { stage: "idle", choice: DEFAULT_CHOICE, installLine: "", code: "", lines: [], box: null, memoryMb: null, note: null, error: null, expiresAt: 0 };
  let run = 0;
  /** @type {null | { mine: number, offer: any, key: any, secret: Uint8Array }} */
  let pending = null;
  const set = (/** @type {Partial<AddServerState>} */ patch) => { state = { ...state, ...patch }; o.onChange?.(state); };
  const stop = (/** @type {keyof typeof MESSAGES} */ code) => { run++; pending = null; set({ stage: "stopped", error: { code, message: MESSAGES[code] } }); };

  /** Make the code and show the install line; then listen for the server. @param {string} [choice] "records" or "plain" @param {string} [os] "linux" (the default) or "mac": which installer the line runs */
  async function begin(choice = DEFAULT_CHOICE, os = "linux") {
    const mine = ++run;
    pending = null;
    const c = choiceOf(choice);
    let key, secret, code;
    try {
      key = await o.client.createSetupKey();
      secret = random(16);
      code = await o.client.setupCode(secret, key.spki);
    } catch { return stop("key"); }
    if (mine !== run) return;
    set({ stage: "install", choice: c.id, code, installLine: installLine(o.version, { code, store: c.store, os }), lines: [], box: null, memoryMb: null, note: null, error: null, expiresAt: now() + SETUP_TTL_MS });
    void followMailbox(mine, key, secret);
    void waitForBox(mine, key, secret);
    void (async () => {
      while (mine === run && state.stage === "install") {
        const left = state.expiresAt - now();
        if (left <= 0) return stop("expired");
        await sleep(Math.min(left, 60_000));
      }
    })();
  }

  /** The install script's progress lines, as plain text for a log. Never read for meaning. */
  async function followMailbox(/** @type {number} */ mine, /** @type {any} */ key, /** @type {Uint8Array} */ secret) {
    let reader;
    try { reader = await o.client.mailboxReader({ relay: o.relay, secret, key }); } catch { if (mine === run) stop("relay"); return; }
    let quiet = 0;
    while (mine === run && ["install", "found", "pairing"].includes(state.stage)) {
      try {
        const got = await reader.next();
        if (mine !== run) return;
        if (got.length) set({ lines: [...state.lines, ...got.map((/** @type {any} */ t) => String(t).slice(0, 400))].slice(-200) });
        quiet = 0;
      } catch (e) {
        const code = /** @type {any} */ (e).code;
        if (code === "contested") { if (mine === run) stop("contested"); return; }
        if (code === "bad_line" || code === "out_of_order" || code === "unauthorized") { if (mine === run) stop("relay"); return; }
        quiet++;
        await sleep(code === "rate_limited" ? 15_000 : Math.min(pollMs * quiet, 15_000));
      }
    }
  }

  /** The server's own sealed offer at the code's place is the one sign that a server used this code. Anyone who saw the code could have put one there first, so nothing opens until the words are confirmed. */
  async function waitForBox(/** @type {number} */ mine, /** @type {any} */ key, /** @type {Uint8Array} */ secret) {
    while (mine === run && state.stage === "install") {
      try {
        const r = await o.client.resolveSetup(secret, { relay: o.relay });
        if (mine !== run) return;
        const words = await o.client.setupWords(r.offer.box, secret);
        pending = { mine, offer: r.offer, key, secret };
        return set({ stage: "found", box: { name: r.name, fingerprint: r.fingerprint, words, route: r.offer.route }, error: null });
      } catch (e) {
        const code = /** @type {any} */ (e).code;
        if (code === "contested" || code === "bad_record") return stop("contested");
        await sleep(code === "rate_limited" ? 15_000 : pollMs);
      }
    }
  }

  /** "These match my server's terminal": now, and only now, the connection opens and the pairing starts. */
  async function confirmWords() {
    const p = pending;
    if (!p || p.mine !== run || state.stage !== "found") return;
    pending = null;
    const mine = p.mine;
    set({ stage: "pairing", error: null });
    let chan;
    try { chan = await o.connect({ offer: p.offer, key: p.key, secret: p.secret }); } catch { if (mine === run) stop("connect"); return; }
    if (mine !== run) { try { chan.close(); } catch { /* gone */ } return; }
    let qr;
    try {
      const me = await o.identity();
      // The memory is a courtesy for the screen: a server that does not say it simply gets no note.
      try { const info = await chan.call("system.info"); const mb = Number(info && info.memoryMb); const fv = filevaultNote(info && info.filevault); if (mine === run && ((Number.isFinite(mb) && mb > 0) || fv)) set({ ...(Number.isFinite(mb) && mb > 0 ? { memoryMb: mb } : {}), note: joinNotes(Number.isFinite(mb) && mb > 0 ? memoryNote(state.choice, mb) : null, fv) }); } catch { /* no note */ }
      const offer = await chan.call("wink.server.setup-offer", { identity: me.id });
      qr = String(offer && offer.qr || "");
    } catch { try { chan.close(); } catch { /* gone */ } if (mine === run) stop("pair"); return; }
    try { chan.close(); } catch { /* gone */ }
    if (mine !== run) return;
    try { await o.pair(qr, { pageKey: p.key }); } catch { if (mine === run) stop("pair"); return; }
    if (mine !== run) return;
    set({ stage: "done" });
  }

  /** "They don't match": not this server. Nothing was opened. */
  function denyWords() {
    if (!pending || state.stage !== "found") return;
    stop("mismatch");
  }

  return { get state() { return state; }, begin, confirmWords, denyWords, stop: () => { run++; pending = null; set({ stage: "idle" }); } };
}
