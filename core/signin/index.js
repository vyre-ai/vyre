// @ts-check
// signin: the command line's person session (`vyre signin`, `vyre signout`).
//
// Why it exists: a call on the socket that names `cli` is only a label, and anything running as the owner's user can send it. The daemon therefore treats the label as a person only when it measured the
// ancestry itself (core/daemon `outside`). A real person at a terminal over ssh, in tmux or through `docker exec` cannot be told from a model's shell by that measurement, so they sign in once.
//
// The flow follows the rollback approval (core/modulelist): `signin.ask` (the CLI, from a terminal login) opens one ask and `signin.pending` hands the owner's phone the card to sign; `signin.answer`
// takes the phone's proof, which the sealing process checks like any other grant act (op grant.cli_signin, bound to this ask and to the terminal); `signin.status` hands the CLI its credential once, only to
// the terminal that asked; `signin.end` is `vyre signout`.
//
// The pin, and why a model's shell cannot satisfy it: the session is made for a terminal login key, a string the daemon builds from the kernel's own view of the peer (the login's leader pid and start
// time on a tty `who` lists, or the clients of a tmux session that each run in such a login with no Claude above them: core/daemon atTerminal). It is never read from the call. The credential is the
// bearer secret in a 0600 file, and it counts only on a call from a process whose measured login key is the same. A program started by a model (under a claude or a thread) gets no key at all, so it can
// neither ask, nor read the status, nor use a copied secret. A process that is not under a claude but is in the owner's login (their own shell) is the person's own and may use it, as before. A process
// that left the login (setsid, a daemon) gets no login key. Same uid does not help: the key is a property of the process tree, not of the file or the user.

import { randomBytes } from "node:crypto";

const ASK_MS = 5 * 60_000;
/** One new ask per this long, so a terminal cannot nag the owner's phone. */
const NEW_ASK_MS = 30_000;
const NEEDS_TERMINAL = "Run this in a terminal you are logged in on, not from a program.";
const obj = (/** @type {Record<string, any>} */ properties = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties, required, additionalProperties: false });
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const PERSON_SURFACES = ["cli", "local", "deck", "capsule", "device"];

/** @param {any} t the terminal meta the daemon measured */
const loginKey = t => (t && typeof t === "object" ? t.key : typeof t === "string" ? t : null);

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const now = typeof ctx.now === "function" ? ctx.now : Date.now;
    /** The one open ask: the terminal it is for and where it stands. `token` is held until the same terminal reads it, once. @type {{ id: string, key: string, at: number, state: "waiting" | "approved" | "refused", from?: string|null, token?: string, expires?: number } | null} */
    let ask = null, lastAskAt = -Infinity;
    const live = () => { if (ask && ask.state === "waiting" && now() - ask.at > ASK_MS) ask = null; return ask; };
    const need = () => { if (typeof ctx.cliSigninPayload !== "function" || typeof ctx.cliSessions !== "object" || !ctx.kernel) throw refuse("this build has no command-line sign-in", "unavailable"); };
    const card = (/** @type {any} */ a) => {
      const p = ctx.cliSigninPayload(a.id, a.key);
      // SG-2: the phone says where the login came from, so `ssh localhost` from a model's shell reads as this machine and a login from another computer names its address (the copy is ui-ux's).
      const host = String((ctx.config && ctx.config.name) || "your server");
      const local = !a.from || a.from === "127.0.0.1" || a.from === "::1" || a.from === "localhost";
      return { id: a.id, state: a.state, title: `Sign in to ${host}'s terminal`,
        body: local ? `Something on ${host} asked to sign in as you. That is you at its own terminal, or a program running on it. Approve only if you opened that terminal yourself.`
          : `A computer at ${a.from} asked to sign in to ${host} as you. Approve only if that is one of your computers and you just used it.`,
        asked_from: local ? `${host} itself, not another computer` : a.from, op: p.op, space: p.space, fields: p.fields, payload_hash: p.payload_hash, expires_in_s: Math.max(0, Math.round((ASK_MS - (now() - a.at)) / 1000)) };
    };

    ctx.tool("signin.ask", {
      description: "Ask the owner's phone to sign in this terminal. Answers { id, expires_in_s }; read the outcome with signin.status. Only from a terminal login the daemon can see; nothing is signed in until the owner approves. One ask at a time, open for 5 minutes.",
      input: obj(),
      callers: ["cli", "local"],
      run: async (/** @type {any} */ _i, /** @type {any} */ meta) => {
        need();
        const key = loginKey(meta && meta.terminal);
        if (!key) throw refuse(NEEDS_TERMINAL, "no_terminal");
        const a = live();
        if (a && a.state === "waiting" && a.key === key) return { id: a.id, expires_in_s: card(a).expires_in_s };
        if (now() - lastAskAt < NEW_ASK_MS) throw refuse("a sign-in was asked for a moment ago: wait a little before asking again", "rate_limited");
        ask = { id: `si_${randomBytes(9).toString("base64url")}`, key, at: now(), state: "waiting", from: meta && meta.terminal && typeof meta.terminal === "object" && typeof meta.terminal.from === "string" ? meta.terminal.from : null };
        lastAskAt = now();
        return { id: ask.id, expires_in_s: ASK_MS / 1000 };
      },
    });

    ctx.tool("signin.pending", {
      description: "The command-line sign-in waiting for the owner, as the phone shows it: { id, title, body, op, space, fields, payload_hash } to sign, or { none: true }.",
      input: obj(),
      callers: PERSON_SURFACES,
      run: async () => { need(); const a = live(); return a && a.state === "waiting" ? card(a) : { none: true }; },
    });

    ctx.tool("signin.answer", {
      description: "The owner's answer to the sign-in ask: { id, approve: true } with the presence proof signed over the card's payload_hash (Face ID on the phone), or { id, approve: false }. A no, a wrong proof or a timed-out ask changes nothing.",
      input: obj({ id: { type: "string" }, approve: { type: "boolean" } }, ["id", "approve"]),
      callers: PERSON_SURFACES,
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        need();
        const a = live();
        if (!a || a.state !== "waiting" || a.id !== String(input.id)) throw refuse("there is no sign-in waiting for you", "not_found");
        // A no ends the ask only from the person's own session: a label alone cannot cancel the owner's sign-in.
        if (input.approve !== true) { if (!meta || !meta.person) return { answered: "ignored", why: "a no needs your signed-in session" }; a.state = "refused"; return { answered: "refused" }; }
        const chain = await ctx.kernel.chain(meta);
        const r = await ctx.cliSigninCheck(chain, ctx.kernel.proofFrom(meta) || null, a.id, a.key);
        if (!r || r.ok !== true) throw refuse(r && r.why === "owner_only" ? "only the owner can approve this" : "that approval was not for this sign-in: ask again", r && r.why === "owner_only" ? "denied" : "needs_presence");
        const s = ctx.cliSessions.start(a.key);
        a.state = "approved"; a.token = s.token; a.expires = s.expires;
        return { answered: "approved" };
      },
    });

    ctx.tool("signin.status", {
      description: "Where the sign-in ask stands: waiting, approved (with the credential, once, only to the terminal that asked), refused, or none.",
      input: obj({ id: { type: "string" } }, ["id"]),
      callers: ["cli", "local"],
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        const a = live();
        const key = loginKey(meta && meta.terminal);
        // Only the terminal that asked reads the answer: another terminal, or a program with no login, learns nothing.
        if (!a || a.id !== String(input.id) || !key || key !== a.key) return { state: "none" };
        if (a.state === "waiting") return { state: "waiting" };
        const out = a.state === "approved" ? { state: "approved", token: a.token, expires: a.expires } : { state: a.state };
        ask = null;
        return out;
      },
    });

    ctx.tool("signin.end", {
      description: "Sign this terminal out: its command-line session ends.",
      input: obj(),
      callers: ["cli", "local"],
      run: async (/** @type {any} */ _i, /** @type {any} */ meta) => {
        need();
        const key = loginKey(meta && meta.terminal);
        if (!key) throw refuse(NEEDS_TERMINAL, "no_terminal");
        return { ended: ctx.cliSessions.end(key) };
      },
    });

    // DEVELOPMENT ONLY, for the app walk: the walk runs in a browser, which is never under sshd, so on a development build whose home holds the hand-made stand-in file a CLI the daemon already counts as the
    // owner (surfaceAncestry: a named login server on the system list, never any unknown) mints an ordinary cookie person session for the browser's node, marked "stand-in", which the harness hands the
    // browser like any signed-in session. A release-kind build refuses it: devStandIn is false there.
    ctx.tool("signin.dev", {
      description: "Development builds only: make a person session (a cookie) for the owner on the device node you name, marked as the stand-in's. Needs the dev stand-in file and a caller the daemon already counts as the owner.",
      input: obj({ node: { type: "string" }, label: { type: "string" } }, ["node"]),
      callers: ["cli", "local"],
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        need();
        if (typeof ctx.devStandIn !== "function" || ctx.devStandIn() !== true || typeof ctx.cliSessions.startStandIn !== "function") throw refuse("this build takes no sign-in stand-in", "dev_only");
        let c = null; try { c = await ctx.kernel.chain(meta); } catch { c = null; }
        const hops = c && Array.isArray(c.hops) ? c.hops : [];
        if (hops.length !== 1 || !hops[0].actor || hops[0].actor.kind !== "person") throw refuse("this call is not from a signed-in person", "denied");
        const node = String(input.node || "");
        if (!/^[A-Za-z0-9_.:@-]{1,128}$/.test(node)) throw refuse("node must name the device the browser connects from", "bad_input");
        if (typeof ctx.cliSessions.nodeInUse === "function" && ctx.cliSessions.nodeInUse(node)) throw refuse("that device already holds a signed-in session", "denied");
        const s = ctx.cliSessions.startStandIn(node);
        // presence.signed-in is presence's event: the daemon says it when it starts the stand-in session (core/daemon cliSessions.startStandIn), not this module.
        return { kind: "cookie", id: s.id, token: s.token, expires: s.expires, method: "stand-in" };
      },
    });
    return { async stop() { ask = null; } };
  },
};
