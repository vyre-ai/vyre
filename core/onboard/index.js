// @ts-check
// onboard — the six steps of spec section 1, as tools the Deck's first screen calls.
//
// Each step is worked out fresh from what is true on the machine (is claude installed, is
// Tailscale running, is the name serving), plus the few choices the person made, which live in
// config.json under "onboard". The steps call other modules' tools (names.*, vault.put,
// recall.*, projects.*) and work without them: a missing module blocks its step and says why.

import os from "node:os";
import { execFile } from "node:child_process";
import * as config from "../config/index.js";
import { loopback } from "./loopback.js";
import { setupToken } from "./setup-token.js";

export const STEPS = ["you", "claude", "tailscale", "name", "history", "devices"];
/** names phases, in order; the page shows them as reserve, dns and cert rows. */
const PHASES = ["idle", "dns", "certificate", "serving"];
const ROWS = ["reserve", "dns", "cert"];
const MAC_DOWNLOAD = "https://vyre.run/download/mac";
const CLAUDE_INSTALL = "npm install -g @anthropic-ai/claude-code";
// Prefixes only; a real value never appears in code, logs or events.
const PREFIX = { subscription: "sk-ant-oat", "api-key": "sk-ant-api" };
const VAULT_ITEM = { subscription: "claude-setup-token", "api-key": "anthropic-api-key" };
const VAULT_KIND = { subscription: "secret", "api-key": "api-key" };
const VAULT_ABOUT = { subscription: "Claude subscription token from `claude setup-token`, for headless sessions", "api-key": "Anthropic API key, for headless sessions" };
// The switchboard's agents module starts the headless sessions and hands them this credential.
const CREDENTIAL_READERS = ["agents"];

const obj = (properties = {}, required = []) => ({ type: "object", properties, required });

/** `claude --version`, remembered for half a minute: the page asks every couple of seconds. */
let known = { at: 0, version: /** @type {Promise<string|null>|null} */ (null) };
function claudeVersion() {
  if (known.version && Date.now() - known.at < 30_000) return known.version;
  known = { at: Date.now(), version: new Promise(resolve => execFile(process.env.VYRE_CLAUDE_BIN || "claude", ["--version"], { timeout: 10_000 },
    (e, out) => resolve(e ? null : String(out).trim().split("\n")[0] || "unknown"))) };
  return known.version;
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const save = patch => config.save(patch, ctx.paths.root, ctx.config);
    const ob = () => ctx.config.onboard || {};
    const skipped = () => new Set(ob().skipped || []);
    const net = () => ctx.config.network || {};
    const lb = loopback({ handler: p => ctx.handler(p), port: Number(net().onboardPort ?? 7300), log: m => ctx.log(m) });
    let claimUrl = null;
    let indexing = null;
    let lastPhase = "idle";
    const signin = setupToken();
    /** @type {Record<string, string>} */
    let lastStates = {};

    const call = async (tool, input = {}) => {
      const r = await ctx.call(tool, input);
      if (r.error) throw Object.assign(new Error(r.error.code === "no_such_tool" ? `${tool.split(".")[0]} is not running on this machine` : r.error.message), { code: r.error.code });
      return r.data;
    };
    const tryCall = (tool, input) => call(tool, input).catch(e => ({ __error: e.message }));
    const mark = (step, s) => skipped().has(step) && s.state !== "done" ? { ...s, state: "skipped" } : s;

    async function status(caller = "local") {
      const [version, names, recall] = await Promise.all([claudeVersion(), tryCall("names.status"), tryCall("recall.status")]);
      const n = names.__error ? null : names;
      const t = n && n.tailscale;

      const you = { state: ctx.config.name ? "done" : "todo", why: null, name: ctx.config.name || null, assistant: ob().assistant || null };

      const auth = ob().claude || null;
      const claude = { state: "todo", why: null, installed: Boolean(version), version, install: version ? null : CLAUDE_INSTALL, auth,
        signedIn: Boolean(auth), via: auth === "api-key" ? "api-key" : auth ? "setup-token" : null };
      if (claude.auth) claude.state = "done";
      else if (!version) Object.assign(claude, { state: "blocked", why: "Claude Code is not installed on this machine" });

      const tailscale = { state: "todo", why: null, installed: false, install: null, backend: null, loginUrl: null,
        operator: { ok: true, fix: null }, node: null, owner: net().owner || null, claimUrl: null };
      if (!t) Object.assign(tailscale, { state: "blocked", why: names.__error || "Tailscale status is unavailable" });
      else {
        Object.assign(tailscale, { installed: t.installed, install: t.install, backend: t.backend, loginUrl: t.loginUrl,
          operator: t.operator || tailscale.operator,
          node: t.node && { name: t.node.name, dnsName: t.node.dnsName, ips: t.node.ips, dns: t.node.dnsName, ip: (t.node.ips || []).find(a => a.includes(".")) || null } });
        if (!t.installed) Object.assign(tailscale, { state: "blocked", why: "Tailscale is not installed" });
        else if (!tailscale.operator.ok) Object.assign(tailscale, { state: "blocked", why: "Vyre may not sign this machine in to Tailscale yet" });
        else if (t.running && !t.tun) Object.assign(tailscale, { state: "blocked", why: "Tailscale runs in userspace networking mode; Vyre needs its network interface" });
        else if (t.running) tailscale.state = "done";
        else if (t.loginUrl) Object.assign(tailscale, { state: "working", why: "waiting for you to sign in" });
      }
      // A tagged node has no person behind it: the owner is whoever opens the claim link first.
      if (t && t.running && t.node && t.node.tagged && !net().owner && n && n.listening && n.address) {
        if (!claimUrl) { const c = await tryCall("names.claim-code"); if (!c.__error) claimUrl = n.address + c.path; }
        tailscale.claimUrl = claimUrl;
      }

      const address = { state: "todo", why: null, name: ctx.config.name || null, address: n ? n.address : null, via: n ? n.via : null,
        phase: n ? n.phase : "idle", certificate: n ? n.certificate : null };
      if (!n) Object.assign(address, { state: "blocked", why: names.__error });
      else if (n.phase === "serving") address.state = "done";
      else if (n.phase === "dns" || n.phase === "certificate") address.state = "working";
      else if (n.phase === "failed") Object.assign(address, { state: "blocked", why: n.why });
      else if (tailscale.state !== "done") Object.assign(address, { state: "blocked", why: "connect Tailscale first" });

      const r = recall.__error ? null : recall;
      const history = { state: "todo", why: null, sessions: 0, indexed: r ? r.sessions : 0, running: Boolean(r && r.indexing) || Boolean(indexing) };
      if (!r) Object.assign(history, { state: "blocked", why: recall.__error });
      else {
        const cat = await tryCall("projects.catalog", { limit: 100000 });
        history.sessions = Math.max(cat.__error ? 0 : Number(cat.total) || 0, history.indexed);
        if (history.running) history.state = "working";
        else if (history.sessions === 0) Object.assign(history, { state: "done", why: "no Claude Code sessions on this machine yet" });
        else if (ob().history && history.indexed >= history.sessions) history.state = "done";
      }

      const devices = { state: ob().finished ? "done" : "todo", why: null, phoneUrl: n && n.phase === "serving" ? n.address : null, macDownload: MAC_DOWNLOAD };

      // detail: each step's full state (todo, working, blocked, done, skipped) and what it needs.
      // steps: the page's view of it, todo, done or skipped.
      const detail = { you: mark("you", you), claude: mark("claude", claude), tailscale: mark("tailscale", tailscale),
        name: mark("name", address), history: mark("history", history), devices: mark("devices", devices) };
      for (const k of STEPS) {
        if (lastStates[k] && lastStates[k] !== detail[k].state) ctx.events.emit("onboard.stepped", { step: k, state: detail[k].state });
      }
      lastStates = Object.fromEntries(STEPS.map(k => [k, detail[k].state]));
      const steps = Object.fromEntries(STEPS.map(k => [k, ["done", "skipped"].includes(detail[k].state) ? detail[k].state : "todo"]));
      const current = STEPS.find(k => steps[k] === "todo") || null;
      const mode = caller === "onboard" ? "loopback" : String(caller).startsWith("tailnet:") ? "tailnet" : "local";
      return { mode, role: ctx.config.role, owner: net().owner || null, address: n && n.phase === "serving" ? n.address : null,
        host: (t && t.node && t.node.name) || os.hostname(), name: ctx.config.name || null, assistant: ob().assistant || null,
        current, finished: Boolean(ob().finished), steps, detail };
    }

    const stepOf = async (k, caller) => (await status(caller)).detail[k];
    /** The address step as progress rows (reserve, dns, cert), and its url once it serves. */
    const progress = s => {
      if (s.phase !== "failed") lastPhase = s.phase;
      const failed = s.phase === "failed", i = Math.min(PHASES.indexOf(failed ? lastPhase : s.phase), failed ? 2 : 3);
      const steps = ROWS.map((id, j) => ({ id, state: j < i ? "done" : j > i ? "todo" : failed ? "failed" : i === 0 ? "todo" : "doing", note: failed && j === i ? s.why : null }));
      return { ...s, steps, url: s.phase === "serving" ? s.address : null };
    };
    /** Tailscale as the page reads it: state is off, needs-login or connected; the step's own state is `step`. */
    const link = s => ({ ...s, step: s.state, state: s.state === "done" ? "connected" : s.loginUrl ? "needs-login" : "off" });

    ctx.tool("onboard.status", {
      description: "Where the onboarding stands: every step's state and what it needs.",
      input: obj(),
      run: async (_, { caller }) => status(caller),
    });

    ctx.tool("onboard.you", {
      description: "Step 1: your name, checked like onboard.name and saved, and your assistant's name.",
      input: obj({ name: { type: "string" }, assistant: { type: "string" } }, ["name"]),
      run: async ({ name, assistant }, { caller }) => {
        const a = String(assistant ?? "").trim();
        if (a.length > 40 || /[\u0000-\u001f]/.test(a)) throw new Error("the assistant's name is one line of up to 40 characters");
        const c = await call("names.check", { name });
        if (!c.valid || !c.available) throw new Error(`${c.name}.vyre.run cannot be yours: ${c.why || "someone else has that name"}`);
        save({ name: c.name, ...(a ? { onboard: { assistant: a } } : {}) });
        return stepOf("you", caller);
      },
    });

    ctx.tool("onboard.name", {
      description: "Step 1 checks <name>.vyre.run and saves it; step 4 reserves it (DNS and certificate, as progress rows) or falls back to the ts.net name.",
      input: obj({ name: { type: "string" }, action: { type: "string", enum: ["check", "reserve", "claim", "status", "ts.net"] } }),
      run: async ({ name, action = "check" }, { caller }) => {
        if (action === "check") {
          if (!name) throw new Error("name is required to check");
          const c = await call("names.check", { name });
          if (c.valid && c.available) save({ name: c.name });
          await status(caller);
          return c;
        }
        if (action !== "status") await call(action === "ts.net" ? "names.fallback" : "names.claim", action !== "ts.net" && name ? { name } : {});
        return progress(await stepOf("name", caller));
      },
    });

    ctx.tool("onboard.claude", {
      description: "Store Claude Code's sign-in in the Vault: a subscription setup token or an API key. The value is never returned. setup-token alone starts `claude setup-token` and returns its sign-in url; setup-token with the code the page showed finishes it.",
      input: obj({ mode: { type: "string", enum: ["detect", "setup-token", "api-key"] }, key: { type: "string" }, code: { type: "string" },
        kind: { type: "string", enum: ["subscription", "api-key"] }, token: { type: "string" } }),
      run: async ({ mode, key, code, kind, token }, { caller }) => {
        if (mode === "setup-token" && !key && !token) {
          if (!code) return { ...(await stepOf("claude", caller)), url: await signin.start(), needsCode: true };
          [kind, token] = ["subscription", await signin.finish(code)];
        }
        kind ||= mode === "api-key" ? "api-key" : mode === "setup-token" ? "subscription" : undefined;
        token ??= key;
        if (kind) {
          const t = String(token || "").trim();
          if (!t.startsWith(PREFIX[kind]) || t.length < 40 || /\s/.test(t)) {
            throw new Error(kind === "subscription" ? "that does not look like a token from `claude setup-token`" : "that does not look like an Anthropic API key");
          }
          await call("vault.put", { name: VAULT_ITEM[kind], kind: VAULT_KIND[kind], description: VAULT_ABOUT[kind], value: t, grants: CREDENTIAL_READERS });
          save({ onboard: { claude: kind } });
        }
        return { ...(await stepOf("claude", caller)), url: null, needsCode: signin.active() };
      },
    });

    ctx.tool("onboard.tailscale", {
      description: "Tailscale on this machine; connect starts `tailscale up` and returns its sign-in link.",
      input: obj({ action: { type: "string", enum: ["status", "detect", "poll", "connect"] } }),
      run: async ({ action = "status" }, { caller }) => {
        if (action === "connect") {
          const s = await stepOf("tailscale", caller);
          if (s.state === "done" || !s.installed || !s.operator.ok) return link(s);
          const r = await call("names.connect");
          const after = await stepOf("tailscale", caller);
          return link({ ...after, loginUrl: after.loginUrl || r.loginUrl || null });
        }
        return link(await stepOf("tailscale", caller));
      },
    });

    ctx.tool("onboard.history", {
      description: "Find and index this machine's Claude Code sessions, in the background.",
      input: obj({ action: { type: "string", enum: ["status", "start"] } }),
      run: async ({ action = "status" }, { caller }) => {
        if (action === "start" && !indexing) {
          save({ onboard: { history: true } });
          indexing = call("recall.index").catch(e => ctx.log("onboard: indexing failed: " + e.message)).finally(() => { indexing = null; });
        }
        return stepOf("history", caller);
      },
    });

    ctx.tool("onboard.skip", {
      description: "Skip a step for now; it can be finished later from Settings.",
      input: obj({ step: { type: "string", enum: STEPS } }, ["step"]),
      run: async ({ step }, { caller }) => {
        save({ onboard: { skipped: [...new Set([...skipped(), step])] } });
        return status(caller);
      },
    });

    ctx.tool("onboard.finish", {
      description: "Finish the onboarding.",
      input: obj(),
      run: async (_, { caller }) => {
        save({ onboard: { finished: new Date().toISOString() } });
        ctx.events.emit("onboard.finished", {});
        if (net().ownerSeen) await lb.close();
        const s = await status(caller);
        return { ...s, url: s.address };
      },
    });

    ctx.tool("onboard.link", {
      description: "A one-time link to the onboarding page on this machine's loopback address. Only from this machine's own socket.",
      input: obj(),
      run: async (_, { caller }) => {
        if (!["cli", "local", "capsule"].includes(String(caller))) throw new Error("links are made only from the box's own terminal");
        const address = net().address || null;
        if (net().ownerSeen) return { url: null, address, port: null, expires: null, user: os.userInfo().username };
        return { ...(await lb.link()), address, user: os.userInfo().username };
      },
    });

    // The owner reached the box over the tailnet, so the loopback door is no longer needed.
    const off = ctx.events.on("owner.seen", () => { lb.close().catch(() => {}); });
    return { async stop() { if (typeof off === "function") off(); signin.stop(); await lb.close(); await indexing; } };
  },
};
