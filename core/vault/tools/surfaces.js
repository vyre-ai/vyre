// @ts-check
// surfaces: the tools the person's own apps use (ADR 0006, decisions 2 to 4 and section 6).
// Sessions for the Deck, the Capsule and the extension; reveal and copy; fill into a native app;
// and the lock that ends all of them on sleep, screen lock or `vault.lock`.
//
// Who may call: people only (cli, local). None of these is offered to Claude over MCP or to a
// module, because each one either hands a value to a screen or opens the door to one. Each
// declares `presence` (ADR 0004) with a summary that names the item and where it goes, never the
// value; reveal and copy skip the proof while a live session covers a non-reprompt item.
//
// What leaves: vault.reveal returns the value, because showing it is the point. vault.copy and
// vault.fill.native return nothing of it: the value goes to a helper's stdin. Events and audit
// rows carry names, fields, surfaces and counts.

import path from "node:path";
import { Sessions, SURFACES, lockConfig, reprompt } from "../session.js";
import { Clipboard } from "../clipboard.js";
import { LockWatch } from "../watch.js";
import { Helper } from "../mac/helper.js";
import { fillNative, appLabel } from "../native.js";
import { callerKind } from "../../modules/index.js";
import { defaultField } from "../../../lib/vault-kinds/kinds.js";

const json = (v, d) => { try { return v == null ? d : JSON.parse(String(v)); } catch { return d; } };

const PEOPLE = ["cli", "local", "deck", "capsule"];
const APP = { type: "object", properties: { bundle: { type: "string" }, pid: { type: "integer" } } };
const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });

export const CONCEAL_AFTER_S = 30;

/**
 * Helpers for tests: `vault.testHelpers` in config.json, honoured only under `node --test`, swaps
 * each Swift helper for a fixed command and the clipboard's PATH for one with fake pbcopy and
 * pbpaste. Under tests without it, the clipboard and the helpers refuse, so a test can never
 * write the person's real clipboard or type into their apps.
 */
function testOptions(config) {
  if (!process.env.NODE_TEST_CONTEXT) return { test: false };
  const t = config && config.vault && config.vault.testHelpers;
  return { test: true, ...(t && typeof t === "object" ? t : {}) };
}

/** vault.clipboard.pasteboard, when it is a plausible pasteboard name. */
export function privatePasteboard(config) {
  const p = config && config.vault && config.vault.clipboard && config.vault.clipboard.pasteboard;
  return typeof p === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(p) ? p : undefined;
}

/**
 * @param {{ ctx: any, vault: any }} deps
 * @returns {{ sessions: Sessions, clipboard: Clipboard, watch: LockWatch, stop(): Promise<void> }}
 */
export function register({ ctx, vault }) {
  const config = ctx.config || {};
  const lock = lockConfig(config);
  const t = testOptions(config);
  const dir = path.join((ctx.paths && ctx.paths.root) || ctx.paths?.vault || ".", "helpers");
  const helper = name => {
    if (t.test) return t[name] ? new Helper({ name, dir, command: t[name] }) : null;
    return new Helper({ name, dir });
  };
  const clipHelper = helper("clip"), watchHelper = helper("watch"), typeHelper = helper("type");
  // The Secure Enclave helper, for Touch ID unlock of the personal vault (vault.js reads it).
  if (vault && (t.test || process.platform === "darwin")) vault.enclave = helper("enclave");
  const guardedClipboard = t.test && !t.clip && !t.env;

  /** Stop watching once nothing is left to protect. */
  const maybeIdle = () => { if (!sessions.count() && !clipboard.holding()) watch.idle(); };

  const clipboard = new Clipboard({
    helper: clipHelper,
    env: t.test && t.env ? { ...process.env, ...t.env } : process.env,
    // vault.clipboard.pasteboard: a named private NSPasteboard instead of the real one (demos and
    // click-throughs); tests may also set it through vault.testHelpers.
    pasteboard: (t.test && t.pasteboard) || privatePasteboard(config),
    log: ctx.log,
    onEmpty: () => maybeIdle(),
  });
  const sessions = new Sessions({
    vault, config,
    emit: (type, p) => ctx.events.emit(type, p),
    onLastClose: () => {
      // The personal vault closes with the last surface; agents keep the agent vault.
      if (vault && typeof vault.lockAccount === "function" && vault.pvk) vault.lockAccount("vyred");
      maybeIdle();
    },
  });
  const watch = new LockWatch({
    helper: watchHelper, onSleep: lock.onSleep, onScreenLock: lock.onScreenLock, role: config.role, log: ctx.log,
    onSignal: why => {
      const n = sessions.closeAll(why);
      clipboard.clear(why).catch(() => {});
      vault.audit("auto-lock", null, "vyred", true, `${why}: ${n} sessions ended`);
    },
  });
  vault.sessions = sessions;

  // `vault.lock` (the tool, and vyred stopping) ends every session and clears the clipboard too.
  // Wrapped here so the lock tool in index.js and the Vault class stay as they are.
  const plainLock = vault.lock.bind(vault);
  vault.lock = (...a) => {
    sessions.closeAll("lock");
    clipboard.clear("lock").catch(() => {});
    return plainLock(...a);
  };

  /** Which field a request means, with the item's kind. Throws for an unknown item. */
  const pick = (name, field) => {
    const r = vault.row(name);
    if (!r) throw new Error(`no item named ${name}`);
    // The private half of a signing key never leaves vyred: it signs there.
    if ((r.kind === "ssh-key" && (field || "private") === "private") || (r.kind === "passkey" && (field || "private_key") === "private_key"))
      throw new Error(`${name} is ${r.kind === "passkey" ? "a passkey" : "an ssh key"}; its private key signs inside the vault and is never shown or copied`);
    const want = field || defaultField(r.kind, json(r.fields, []));
    if (!want) throw new Error(`${name} is ${r.kind === "env-set" ? "an env-set" : `a ${r.kind}`}; name the field you want`);
    return { r, want };
  };

  /** One field's value, or an error that names the field and never a value. */
  const valueOf = async (r, want, version) => {
    const f = version === undefined || version === null ? await vault.fields(r) : await vault.versionFields(r, version);
    if (!f || typeof f[want] !== "string") throw new Error(`${r.name} has no field ${want}`);
    return f[want];
  };

  // The Capsule calls every action with `{ id, front }` (its result's id, and the app that was in
  // front when it opened), so the tools it lists take those as names for `name` and `app`.
  const asItem = i => ({ ...i, name: i.name ?? i.id, app: i.app ?? i.front });
  const named = i => { const x = asItem(i); if (typeof x.name !== "string" || !x.name) throw new Error("name the item"); return x; };

  const surfaceFor = (session, caller) => sessions.surfaceOf(session) || callerKind(caller);
  const skip = ({ input }) => Boolean(input && sessions.ok(input.session, input.name));
  // For the presence floor's session method (ADR 0004 addendum): a session proof covers an item
  // unless it is reprompt, which always asks afresh.
  const sessionable = input => { const n = input && (input.name ?? input.id); return typeof n === "string" && !reprompt(vault, n); };
  const kindOf = name => { try { return vault.row(name)?.kind || "item"; } catch { return "item"; } };
  const fieldFor = (name, field) => field || defaultField(kindOf(name)) || "value";
  const minutes = ttl_s => Math.max(1, Math.round((ttl_s ? Math.min(lock.max, Number(ttl_s) * 1000) : lock.max) / 60_000));

  // ---- sessions --------------------------------------------------------------------------

  ctx.tool("vault.session.open", {
    description: "Unlock the vault in the Deck, the Capsule or the extension for a while. Returns a session token for that surface only.",
    input: obj({ surface: { type: "string", enum: SURFACES }, ttl_s: { type: "integer" } }, ["surface"]),
    callers: [...PEOPLE, "tailnet", "device"],
    presence: { summary: async ({ surface, ttl_s }) => `Unlock the vault in ${surface} for ${minutes(ttl_s)} minutes` },
    run: async ({ surface, ttl_s }, { caller }) => {
      const s = sessions.open(surface, ttl_s);
      vault.audit("session-open", null, caller, true, surface);
      watch.ensure().catch(() => {});
      return s;
    },
  });

  // Ending a session takes access away, so anyone holding the token may.
  ctx.tool("vault.session.close", {
    description: "Lock a surface's session now.",
    input: obj({ session: str }, ["session"]),
    // Taking access away: a model session may close a session whose token it holds (surfaces.test.js pins it); the token is the guard.
    callers: [...PEOPLE, "tailnet", "device", "module", "mcp"],
    run: async ({ session }, { caller }) => {
      const surface = sessions.surfaceOf(session);
      const out = sessions.close(session);
      if (out.closed) vault.audit("session-close", null, caller, true, surface);
      return out;
    },
  });

  ctx.tool("vault.session.status", {
    description: "Whether a session is unlocked, until when, and for which surface.",
    input: obj({ session: str }, ["session"]),
    callers: [...PEOPLE, "tailnet", "device"],
    run: async ({ session }) => sessions.status(session),
  });

  // ---- reveal and copy -------------------------------------------------------------------

  ctx.tool("vault.reveal", {
    description: "Show one field of an item to the person, on their own device. Hide it again after concealAfter seconds.",
    input: obj({ name: str, field: str, session: str, version: { type: "integer" } }, ["name"]),
    callers: [...PEOPLE, "tailnet", "device"],
    presence: { summary: async ({ name, field, version }) => `Show the ${fieldFor(name, field)} of ${kindOf(name)} "${name}"${version ? ` from version ${Number(version)}` : ""}`, skip, session: sessionable },
    run: async ({ name, field, session, version }, { caller }) => {
      const surface = surfaceFor(session, caller);
      // Floor rule 8 (SPEC 11): a value may be shown to a person who has just proved presence on
      // their own device, for that one value. prove.js asks for that proof before this runs.
      let want = field || "value";
      try {
        const p = pick(name, field);
        want = p.want;
        const value = await valueOf(p.r, want, version);
        vault.audit("reveal", name, caller, true, `field ${want} on ${surface}`);
        ctx.events.emit("vault.revealed", { name, field: want, surface });
        return { value, concealAfter: CONCEAL_AFTER_S };
      } catch (e) {
        vault.audit("reveal", name, caller, false, /** @type {any} */ (e).code === "locked" ? "locked" : `field ${want}`);
        throw e;
      }
    },
  });

  ctx.tool("vault.copy", {
    description: "Copy one field of an item to this Mac's clipboard, cleared after 90 seconds. Never returns the value.",
    input: obj({ name: str, id: str, field: str, session: str, version: { type: "integer" }, front: { type: "object" } }),
    callers: [...PEOPLE, "tailnet", "device"],
    presence: { summary: async i => { const { name, field, version } = asItem(i); return `Copy the ${fieldFor(name, field)} of ${kindOf(name)} "${name}"${version ? ` from version ${Number(version)}` : ""} to the clipboard`; }, skip: ({ input }) => skip({ input: asItem(input || {}) }), session: sessionable },
    run: async (input, { caller }) => {
      const { name, field, session, version } = named(input);
      const surface = surfaceFor(session, caller);
      if (guardedClipboard) throw new Error("under tests the clipboard needs vault.testHelpers (a private pasteboard or fake pbcopy)");
      let want = field || "value";
      try {
        const p = pick(name, field);
        want = p.want;
        const no = clipboard.refusal();
        if (no) throw new Error(no);
        // "totp" copies the current one-time code, not the seed.
        if (version && want === "totp") throw new Error("an older version's one-time code is not copied; revert it first");
        const text = want === "totp" ? String((await vault.code({ name }, caller)).code) : await valueOf(p.r, want, version);
        const out = await clipboard.copy(text);
        watch.ensure().catch(() => {});
        vault.audit("copy", name, caller, true, `field ${want} on ${surface} via ${out.via}`);
        ctx.events.emit("vault.copied", { name, field: want, surface, clearsAt: out.clearsAt });
        return { copied: true, clearsAt: out.clearsAt, said: `Copied the ${want === "totp" ? "one-time code" : want} of ${name} · clears in 90 s`, ...(out.warning ? { warning: out.warning } : {}) };
      } catch (e) {
        vault.audit("copy", name, caller, false, /** @type {any} */ (e).code === "locked" ? "locked" : `field ${want}`);
        throw e;
      }
    },
  });

  // The Capsule's search provider: names and where each is used, never a value.
  ctx.tool("vault.search", {
    description: "Items whose name, description, kind or hosts match, for a launcher's results. Names only, never a value.",
    input: obj({ q: str, limit: { type: "integer" } }),
    callers: null,
    run: async ({ q = "", limit = 8 }) => {
      const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
      const rows = [];
      for (const it of vault.list({}).items) {
        const hay = [it.name, it.description, it.kind, ...(it.hosts || [])].join(" ").toLowerCase();
        if (!words.every(w => hay.includes(w))) continue;
        const host = (it.hosts || [])[0];
        rows.push({ id: it.name, name: it.name, kind: it.kind, sub: host ? `${it.kind} · ${host.replace(/^https?:\/\//, "")}` : it.kind });
        if (rows.length >= Math.max(1, Math.min(50, Number(limit) || 8))) break;
      }
      return { rows };
    },
  });

  // Clearing takes nothing away from anyone but a value this vault put there, so any caller may.
  ctx.tool("vault.clipboard.clear", {
    description: "Clear the clipboard now, if it still holds what the vault copied.",
    input: obj({}),
    // Harmless for any caller: it clears only what the vault copied (hash compared first), and reads and writes no secret.
    callers: [...PEOPLE, "tailnet", "device", "module", "mcp"],
    run: async (_input, { caller }) => {
      await clipboard.clear("asked");
      vault.audit("clipboard-clear", null, caller, true, null);
      return { cleared: true };
    },
  });

  // ---- fill into a native app (the Capsule) ----------------------------------------------

  ctx.tool("vault.fill.native", {
    description: "Fill a login's username and password into the app in front, by Accessibility. The value goes to a helper, never back to the caller.",
    input: obj({ name: str, id: str, app: APP, front: APP, session: str }),
    callers: PEOPLE,
    // A fill is not one of the three things a session skips the proof for (ADR 0006, decision 3).
    presence: { summary: async i => { const { name, app } = asItem(i); return `Fill ${name} into ${appLabel(app && app.bundle)}`; } },
    run: async (input, { caller }) => {
      const { name, app, session } = named(input);
      if (!app || typeof app.bundle !== "string" || !Number.isInteger(app.pid)) throw new Error("say which app is in front: { bundle, pid }");
      const surface = surfaceFor(session, caller);
      try {
        const out = await fillNative({ vault, helper: typeHelper, name, app });
        vault.audit("fill-native", name, caller, true, `${app.bundle} on ${surface}`);
        ctx.events.emit("vault.filled", { name, app: app.bundle, surface });
        return { ...out, said: `Filled ${name} in ${appLabel(app.bundle)}` };
      } catch (e) {
        const code = /** @type {any} */ (e).code;
        vault.audit("fill-native", name, caller, false, `${app && app.bundle}: ${typeof code === "string" ? code : "failed"}`);
        throw e;
      }
    },
  });

  return {
    sessions, clipboard, watch,
    async stop() {
      sessions.closeAll("stop");
      await clipboard.stop();
      watch.idle();
    },
  };
}
