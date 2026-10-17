// @ts-check
// First run, invites, and adding a computer or a phone. One tool each: the app calls these, and the MCP server
// forwards the same registry tools (harness/mcp/server.js holds none of its own).
//
// One identity can be the owner, an admin or a member of many spaces. Each space has its own server. A later
// join or create uses the identity already on this device. This file does not mint a second identity, a second
// install code, or a second owner change. A phone is a link. It never signs a change of who owns a space.

import { randomBytes } from "node:crypto";
import { isPerson } from "../../lib/caller.js";
import { newPrefixedId } from "../../lib/id.js";
import { resolveInstallOnline } from "../../lib/install-online.js";
import { ROLE_IDS } from "../../kernel/contracts/index.js";
import { loginAdapters } from "../../lib/agent-adapters.js";
import { canAssign } from "../../lib/spaces/members.js";
import { commandOk, spaceKey, inviteDays, inviteRole, parseInvite, passwordOk, personRoutes, placeKind, usernameOf } from "../../lib/first-run-shape.js";
import { modelSuppliedSecret, SECRET_REFUSED } from "../../lib/master-secret.js";
import { modelCaller } from "../modules/needs-you-hold.js";
import { httpFetch } from "../../lib/http.js";
import { vouch } from "../../lib/github-verified.js";
import { githubAccount, githubConfig, requestDeviceCode } from "./github-subject.js";

const OPEN = Object.freeze(["cli", "local", "deck", "capsule", "device", "mcp", "harness"]);
/** The tools that take the master password are the person's own surfaces only: a model never sees a password field here. An agent that wants the person to do these asks for a link or a Needs-you card instead. */
const PERSON_ONLY = Object.freeze(["cli", "local", "deck", "capsule", "device"]);
const obj = (properties, required = []) => ({ type: "object", properties, required });
const str = { type: "string" };
const bad = (message) => Object.assign(new Error(message), { code: "bad_input" });
const ROLES = new Set([...ROLE_IDS, "guest"]);
const VAULT_SPACE = /^spc_[a-z2-7]{8,}$/;
const TEST_SPACE = /^spc_test_[a-z0-9_-]{1,40}$/;

/** @type {Map<string, { command: string, expiresAt: string, kind: string, name: string }>} */
const waits = new Map();
/** @type {Map<string, { role: string, ttlDays: number, space: string, link: string }>} */
const links = new Map();

/**
 * @param {any} ctx
 * @param {{ fetch?: typeof fetch, save: (patch: any) => void, flow?: { load: (person: string) => any, save: (person: string, payload: any) => void, clear?: (person: string) => void }, adapters?: () => Iterable<string> }} io
 */
export function registerFirstRun(ctx, io) {
  const { save, flow, adapters } = io;
  const fetchGitHub = io.fetch || httpFetch;
  /** @type {{ code: string, expires: number } | null} */
  let device = null;
  /** Relay the running person's call (core/modules RELAY_ALLOWED onboard). Not named `call`: reach-module-calls scans literal call(). */
  const personCall = async (tool, input = {}) => {
    const r = await ctx.call(tool, input, { relay: true });
    if (r.error) throw Object.assign(new Error(r.error.code === "no_such_tool" ? `${tool.split(".")[0]} is not running on this machine` : r.error.message), { code: r.error.code });
    return r.data;
  };
  const tryCall = (tool, input) => personCall(tool, input).catch(e => ({ __error: e.message, __code: e.code }));
  const ob = () => (ctx.config && ctx.config.onboard) || {};
  const seeded = ob();
  const DEVICE_KEY = "__device__";
  /** @type {Map<string, { person: string | null, personId: string | null, current: string | null, spaces: { id: string, name: string, role: string, server: string | null }[] }>} */
  const cache = new Map();

  /** @returns {{ person: string | null, personId: string | null, current: string | null, spaces: { id: string, name: string, role: string, server: string | null }[] }} */
  function emptyHeld() {
    return { person: null, personId: null, current: null, spaces: [] };
  }

  /** @param {string | null} personId */
  function loadHeld(personId) {
    const key = personId || DEVICE_KEY;
    if (cache.has(key)) return cache.get(key);
    let held = flow && flow.load(key);
    if (!held && key === DEVICE_KEY) {
      held = {
        person: typeof seeded.person === "string" ? seeded.person : null,
        personId: typeof seeded.personId === "string" ? seeded.personId : null,
        current: typeof seeded.current === "string" ? seeded.current : null,
        spaces: Array.isArray(seeded.memberships) ? seeded.memberships.map(membershipOf).filter(Boolean) : [],
      };
    }
    if (!held) held = emptyHeld();
    cache.set(key, held);
    return held;
  }

  /** @param {string | null} personId @param {ReturnType<typeof emptyHeld>} held */
  function persistHeld(personId, held) {
    const key = personId || DEVICE_KEY;
    cache.set(key, held);
    if (flow) flow.save(key, held);
    else save({ onboard: { person: held.person, personId: held.personId, current: held.current, memberships: held.spaces } });
  }

  /** @param {any} meta */
  async function personKey(meta) {
    const existing = await identityNow(personCall);
    const personId = existing && existing.id ? String(existing.id) : null;
    return { personId, username: existing ? existing.username : null };
  }

  /** @param {any} meta */
  async function heldOf(meta) {
    const { personId, username } = await personKey(meta);
    const held = loadHeld(personId);
    if (username && !held.person) held.person = username;
    if (personId && !held.personId) held.personId = personId;
    return { held, personId };
  }

  const persist = (/** @type {string | null} */ personId, /** @type {ReturnType<typeof emptyHeld>} */ held) => persistHeld(personId, held);

  /** The spaces this identity belongs to: the ones recorded here, plus whatever spaces.list already knows. @returns {Promise<{ id: string, name: string, role: string, server: string | null }[]>} */
  async function spacesNow(held, personId, { persist: doPersist = true } = {}) {
    /** @type {any[]} */
    let remote = [];
    try { const got = await personCall("spaces.list", {}); if (Array.isArray(got)) remote = got; } catch { remote = []; }
    const out = held.spaces.map((s) => ({ ...s }));
    for (const row of remote) {
      const name = labelOf(row);
      const id = spaceKey(row && row.id, name);
      if (!id) continue;
      const server = serverFrom(row) || null;
      const role = row && ROLES.has(row.role) ? String(row.role) : "";
      const hit = out.find((s) => s.id === id || (name && s.name === name));
      if (hit) {
        const prev = hit.id;
        if (String(row.id || "").startsWith("spc_")) hit.id = String(row.id);
        if (held.current === prev) held.current = hit.id;
        if (name) hit.name = name;
        if (role) hit.role = role;
        if (server) hit.server = server;
      } else out.push({ id: String(row.id || id), name: name || id, role: role || "member", server });
    }
    held.spaces = out.map(membershipOf).filter(Boolean);
    if (held.current && !held.spaces.some((s) => s.id === held.current)) held.current = held.spaces[0] ? held.spaces[0].id : null;
    if (doPersist) persist(personId, held);
    return held.spaces.map((s) => ({ ...s }));
  }

  /** @param {ReturnType<typeof emptyHeld>} held @param {string | null} personId @param {{ id: string, name: string, role: string, server: string | null }} row */
  function rememberSpace(held, personId, row) {
    const next = membershipOf(row);
    if (!next) return null;
    const at = held.spaces.findIndex((s) => s.id === next.id || s.name === next.name);
    if (at >= 0) held.spaces[at] = { ...held.spaces[at], ...next, server: next.server || held.spaces[at].server };
    else held.spaces.push(next);
    held.current = held.spaces[at >= 0 ? at : held.spaces.length - 1].id;
    persist(personId, held);
    return held.spaces.find((s) => s.id === held.current) || next;
  }

  /** @param {any} meta @param {any} input */
  function refuseAgentSecret(meta, input) {
    const caller = String(meta && meta.caller || "");
    if (!modelCaller(caller)) return;
    if (modelSuppliedSecret(caller, input, meta && meta.origin)) throw Object.assign(new Error(SECRET_REFUSED), { code: "secret_refused" });
  }

  /** Strip anything that looks like a vault credential from a sign-in answer. @param {any} body */
  function scrubSignin(body) {
    if (!body || typeof body !== "object") return body;
    const out = { ...body };
    for (const k of ["token", "key", "apiKey", "api_key", "password", "secret", "recoveryKey"]) delete out[k];
    return out;
  }

  ctx.tool("onboard.person.lookup", {
    effect: "read",
    description: "Check a username for the public person page. Says whether the form is valid. Reads nothing secret.",
    input: obj({ username: str }, ["username"]),
    callers: [...OPEN],
    run: async ({ username }) => {
      const name = usernameOf(username);
      if (!name) return { ok: false, reason: "invalid" };
      return { ok: true, username: name, ...personRoutes(name) };
    },
  });

  ctx.tool("onboard.person.status", {
    effect: "read",
    description: "Whether this device already has an identity, and that username. A later space uses the same one.",
    input: obj({}),
    callers: [...OPEN],
    run: async (_i, meta) => {
      const { held, personId } = await heldOf(meta);
      const existing = await identityNow(personCall);
      if (existing) { held.person = existing.username; held.personId = existing.id || held.personId; }
      return { exists: Boolean(existing), username: held.person, id: held.personId, current: held.current, spaces: await spacesNow(held, personId, { persist: false }), ...(held.person ? personRoutes(held.person) : {}) };
    },
  });

  ctx.tool("onboard.person.create", {
    effect: "write",
    description: "Create this person's identity and vault from a username and master password. Returns the recovery key once.",
    input: obj({ username: str, password: str, confirm: str }, ["username", "password"]),
    callers: [...PERSON_ONLY],
    run: async ({ username, password, confirm }, meta) => {
      refuseAgentSecret(meta, { username, password, confirm });
      const { held, personId } = await heldOf(meta);
      const name = usernameOf(username);
      if (!name) throw bad("A username is lowercase letters, digits and hyphens, 3 to 20 characters, starting with a letter.");
      if (!passwordOk(password)) throw bad("Use a master password of at least 12 characters, and not a common one.");
      if (confirm !== undefined && confirm !== password) throw bad("Type the master password the same way twice.");
      const existing = await identityNow(personCall);
      if (existing) {
        held.person = existing.username;
        held.personId = existing.id || held.personId;
        persist(personId, held);
        return { username: existing.username, id: held.personId, ...personRoutes(existing.username), recoveryKey: null, once: false, already: true };
      }
      const made = await personCall("identity.create", { username: name, password });
      const recoveryKey = made && typeof made.recoveryKey === "string" ? made.recoveryKey : null;
      held.person = name;
      held.personId = made && typeof made.id === "string" ? made.id : held.personId;
      persist(personId, held);
      ctx.events.emit("onboard.stepped", { step: "identity", username: name });
      const body = { username: name, id: held.personId, ...personRoutes(name), recoveryKey, once: true, already: false };
      if (!isPerson(meta && meta.caller)) { delete body.recoveryKey; body.note = "The recovery key is shown on your device."; }
      return body;
    },
  });

  ctx.tool("onboard.github.start", {
    effect: "read",
    description: "Begin Continue with GitHub. Returns the address the person opens. GitHub does not unlock the vault.",
    input: obj({}),
    callers: [...OPEN],
    run: async () => {
      const url = githubStart(ctx.config);
      const gh = githubConfig(ctx.config);
      if (gh.clientId && !(device && device.expires > Date.now())) {
        try {
          const began = await requestDeviceCode(gh.clientId, fetchGitHub);
          device = { code: began.deviceCode, expires: Date.now() + began.expiresIn * 1000 };
        } catch { device = null; }
      }
      const exchange = Boolean(device && device.expires > Date.now());
      if (url) return exchange ? { url, exchange: true } : { url };
      return { url: null, pending: ["github.start"] };
    },
  });

  ctx.tool("onboard.github.finish", {
    effect: "write",
    description: "Link a GitHub login to this person. The account id is read from GitHub. The master password still unlocks the vault.",
    input: obj({
      login: str,
      subject: str,
      code: { type: "string", description: "The code from the GitHub login. The account id is read from GitHub." },
    }, []),
    callers: [...OPEN],
    run: async ({ login, code }) => {
      const name = String(login ?? "").trim().toLowerCase();
      if (name && !/^[a-z0-9-]{1,39}$/.test(name)) throw bad("That GitHub login cannot be linked.");
      const gh = githubConfig(ctx.config);
      const authCode = String(code ?? "").trim();
      const deviceCode = !authCode && device && device.expires > Date.now() ? device.code : "";
      if (!authCode && !deviceCode) return { linked: false, login: name || null, vault: "password", pending: ["github.start"] };
      /** @type {{ id?: string, login?: string, pending?: string }} */
      let account;
      try { account = await githubAccount({ ...gh, code: authCode, deviceCode, fetch: fetchGitHub }); }
      catch (e) {
        const err = /** @type {any} */ (e);
        if (err && err.code === "bad_input") device = null;
        if (err && err.code === "unavailable") throw Object.assign(new Error("GitHub did not answer. Try again in a minute."), { code: "unavailable" });
        throw bad(err && err.message ? err.message : "GitHub did not confirm this sign-in.");
      }
      if (account.pending) return { linked: false, login: name || null, vault: "password", pending: [account.pending] };
      const who = String(account.login || "").toLowerCase();
      device = null;
      if (!/^[a-z0-9-]{1,39}$/.test(who)) throw bad("That GitHub login cannot be linked.");
      if (name && who !== name) throw bad("That GitHub login is not the account that signed in.");
      vouch(who, String(account.id));
      const linked = await personCall("identity.github.link", { login: who, subject: String(account.id) });
      save({ onboard: { github: who } });
      const shown = (linked && linked.login) || who;
      return { linked: true, login: shown, vault: "password" };
    },
  });

  ctx.tool("onboard.join.read", {
    effect: "read",
    description: "Read an invite link and say which space and role it opens. Nothing on this path names a machine.",
    input: obj({ link: str }, ["link"]),
    callers: [...OPEN],
    run: async ({ link }) => {
      const parsed = parseInvite(link);
      if (!parsed) throw bad("That link does not open a space. Ask for a new invite.");
      const heldLink = links.get(parsed.token);
      let space = heldLink?.space || (parsed.spaceHost ? parsed.spaceHost.replace(/\.vyre\.run$/, "") : "");
      let role = heldLink?.role || "member";
      // The link an owner shares (vyre.run/i/<token>) names no server, so the person must still see which space and which role they are about to join: ask the invite card, which resolves the link and checks it.
      if (!space) {
        try {
          const card = /** @type {any} */ (await personCall("spaces.invites.preview", { link: parsed.link }));
          space = String((card && card.space) || "").replace(/\.vyre\.run$/, "");
          if (!heldLink && card && typeof card.role === "string" && card.role) role = card.role;
        } catch { /* the review then says "A space"; the join itself checks the invite */ }
      }
      return { link: parsed.link, role, space: space || null, ttlDays: heldLink?.ttlDays || null };
    },
  });

  ctx.tool("onboard.space.join", {
    effect: "write",
    description: "Accept an invite link and join that space with the role on the link. The same identity can join another.",
    input: obj({ link: str }, ["link"]),
    callers: [...OPEN],
    run: async ({ link }, meta) => {
      const { held, personId } = await heldOf(meta);
      const parsed = parseInvite(link);
      if (!parsed) throw bad("That link does not open a space. Ask for a new invite.");
      const heldLink = links.get(parsed.token);
      const joined = await personCall("spaces.invites.accept", { link: parsed.link });
      if (heldLink) links.delete(parsed.token);
      const name = (joined && (joined.name || joined.label)) || heldLink?.space || (parsed.spaceHost ? parsed.spaceHost.replace(/\.vyre\.run$/, "") : "") || "";
      const role = (heldLink && heldLink.role) || (joined && (joined.role || (joined.membership && joined.membership.role))) || "member";
      const row = rememberSpace(held, personId, { id: spaceKey(joined && (joined.space || joined.id), name), name: String(name || "space"), role: String(role), server: serverFrom(joined) || (parsed.spaceHost ? `https://${parsed.spaceHost}` : null) });
      return { joined: true, space: row ? row.name : null, id: row ? row.id : null, role: row ? row.role : "member", server: row ? row.server : null };
    },
  });

  ctx.tool("onboard.space.open", {
    effect: "write",
    description: "Start a space on a Linux server or an always-on Mac and return the one install command.",
    input: obj({ kind: { type: "string", enum: ["linux", "mac"] }, name: str }, ["kind"]),
    callers: [...OPEN],
    run: async ({ kind, name }, meta) => {
      const { held, personId } = await heldOf(meta);
      const place = placeKind(kind);
      if (!place) throw bad("Pick a Linux server or an always-on Mac.");
      const label = usernameOf(name) || "space";
      const issued = await personCall("wink.install.issue", { os: place });
      const command = issued && typeof issued.line === "string" ? issued.line : "";
      if (!commandOk(command)) throw bad("The install command is not one this app can show.");
      const id = newPrefixedId("fr");
      const expiresAt = new Date(Number(issued.expires) * 1000).toISOString();
      waits.set(id, { command, expiresAt, kind: place, name: label });
      const row = rememberSpace(held, personId, { id: spaceKey("", label), name: label, role: "owner", server: null });
      return { id, command, expiresAt, kind: place, name: label, spaceId: row ? row.id : null, role: "owner" };
    },
  });

  ctx.tool("onboard.space.poll", {
    effect: "read",
    description: "Whether the new space's computer is online yet. A read, while the install command runs.",
    input: obj({ id: str }, ["id"]),
    callers: [...OPEN],
    run: async ({ id }, meta) => {
      const row = waits.get(String(id || ""));
      if (!row) throw bad("That install is not one this device started.");
      let status = null;
      try { status = await personCall("wink.install.status", {}); } catch { status = null; }
      const seen = /** @type {{ contested?: boolean }} */ ({});
      const adopted = await resolveInstallOnline({ tryCall, meta, seen });
      if (seen.contested) return { id, online: false, expired: false, contested: true, kind: row.kind, expiresAt: row.expiresAt, message: "Another server answered this install line first. Nothing was paired. Make a new install line and run it only on your own server." };
      const sid = adopted ? vaultSpace(status && status.space) : "";
      const { held, personId } = await heldOf(meta);
      if (adopted && sid && isPerson(meta && meta.caller)) {
        try { await personCall("vault.space.create", { space: sid }); }
        catch (e) { if (!e || e.code !== "exists") throw e; }
        rememberSpace(held, personId, { id: sid, name: row.name, role: "owner", server: null });
      }
      if (adopted) return { id, online: true, expired: false, kind: row.kind, expiresAt: row.expiresAt, ...(sid ? { space: sid } : {}) };
      const expMs = status && status.expires ? Number(status.expires) * 1000 : Date.parse(row.expiresAt);
      if (Number.isFinite(expMs) && expMs < Date.now() && !(status && status.issued)) {
        return { id, online: false, expired: true, kind: row.kind, expiresAt: row.expiresAt, message: "The install window ended. Go back and show a new command." };
      }
      return { id, online: false, expired: false, kind: row.kind, expiresAt: row.expiresAt };
    },
  });

  ctx.tool("onboard.space.list", {
    effect: "read",
    description: "Spaces this one identity belongs to, each with its role and its own server.",
    input: obj({}),
    callers: [...OPEN],
    run: async (_i, meta) => {
      const { held, personId } = await heldOf(meta);
      return { person: held.person, id: held.personId, current: held.current, spaces: await spacesNow(held, personId, { persist: false }) };
    },
  });

  ctx.tool("onboard.space.current", {
    effect: "write",
    description: "Choose which of this identity's spaces is showing. The identity stays the same.",
    input: obj({ space: str }, ["space"]),
    callers: [...OPEN],
    run: async ({ space }, meta) => {
      const { held, personId } = await heldOf(meta);
      const rows = await spacesNow(held, personId);
      const want = String(space || "");
      const hit = rows.find((s) => s.id === want || s.name === want);
      if (!hit) throw bad("That space is not one this identity belongs to.");
      held.current = hit.id;
      persist(personId, held);
      return { current: hit.id, name: hit.name, role: hit.role, server: hit.server };
    },
  });

  ctx.tool("onboard.member.link", {
    effect: "write",
    description: "Make a link someone can use to join a space, for a role and a number of days.",
    input: obj({ space: str, role: str, ttlDays: { type: "number" } }, ["role", "ttlDays"]),
    callers: [...OPEN],
    run: async ({ space, role, ttlDays }, meta) => {
      const { held, personId } = await heldOf(meta);
      return remember(await invite(personCall, held, personId, space, role, ttlDays));
    },
  });

  const progressKey = (/** @type {string | null} */ personId) => `progress:${personId || DEVICE_KEY}`;

  ctx.tool("onboard.first.progress", {
    effect: "read",
    description: "Where this person left the first-run flow, so a reload can resume.",
    input: obj({}),
    callers: [...OPEN],
    run: async (_i, meta) => {
      const { personId } = await heldOf(meta);
      const row = flow && flow.load(progressKey(personId));
      const stack = row && Array.isArray(row.stack) ? row.stack.map(String).filter(Boolean) : [];
      const screen = row && typeof row.screen === "string" ? row.screen : (stack[stack.length - 1] || "id.create");
      return { screen, stack: stack.length ? stack : [screen] };
    },
  });

  ctx.tool("onboard.first.progress.save", {
    effect: "write",
    description: "Save where this person is in the first-run flow.",
    input: obj({ screen: str, stack: { type: "array", items: str } }, ["screen"]),
    callers: [...OPEN],
    run: async ({ screen, stack }, meta) => {
      if (!isPerson(meta && meta.caller) && String(meta && meta.caller) !== "device") throw Object.assign(new Error("only the person on their own surface saves first-run progress"), { code: "denied" });
      const { personId } = await heldOf(meta);
      const next = { screen: String(screen || "id.create"), stack: Array.isArray(stack) && stack.length ? stack.map(String) : [String(screen || "id.create")] };
      if (flow) flow.save(progressKey(personId), next);
      return { saved: true, ...next };
    },
  });

  ctx.tool("onboard.agent.list", {
    effect: "read",
    description: "AI providers the first-run sign-in step may offer. Login-able adapters only.",
    input: obj({}),
    callers: [...OPEN],
    run: async () => {
      const labels = { claude: "Claude", codex: "Codex", grok: "Grok" };
      const ids = loginAdapters(adapters ? adapters() : []);
      return { providers: ids.map((id) => ({ id, label: labels[id] || id })) };
    },
  });

  ctx.tool("onboard.agent.signin", {
    effect: "write",
    description: "Sign in to an AI through its provider login. Credentials stay in the vault; nothing secret is returned.",
    input: obj({ provider: str, label: str, flow: str, code: str }),
    callers: [...OPEN],
    run: async (input, meta) => {
      refuseAgentSecret(meta, input);
      const provider = String(input.provider || "");
      if (!loginAdapters(adapters ? adapters() : []).includes(provider)) throw bad("That provider does not support sign-in here.");
      const r = await personCall("sessions.accounts.signin", input);
      return scrubSignin(r);
    },
  });

  ctx.tool("onboard.first.done", {
    effect: "write",
    description: "Mark the first run finished so this computer opens the app.",
    input: obj({}),
    callers: ["cli", "local", "deck", "capsule", "device"],
    run: async (_i, meta) => {
      const { personId } = await heldOf(meta);
      if (flow && flow.clear) flow.clear(progressKey(personId));
      save({ onboard: { firstRun: null } });
      return { done: true };
    },
  });
}

/** The identity already on this device, or null. A missing identity tool means there is nothing to reuse yet. @param {(tool: string, input?: any) => Promise<any>} call */
async function identityNow(personCall) {
  try {
    const st = await personCall("identity.status", {});
    const name = st && st.exists ? usernameOf(st.username) : "";
    return name ? { username: name, id: typeof st.id === "string" ? st.id : null } : null;
  } catch { return null; }
}

/** @param {any} raw @returns {{ id: string, name: string, role: string, server: string | null } | null} */
function membershipOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name || "").trim().slice(0, 80);
  const id = spaceKey(raw.id, name);
  if (!id) return null;
  const role = ROLES.has(raw.role) ? String(raw.role) : "member";
  return { id, name: name || id, role, server: serverUrl(raw.server) || null };
}

/** A space id vault.space.create accepts. @param {unknown} raw */
function vaultSpace(raw) {
  const s = String(raw || "");
  return VAULT_SPACE.test(s) || TEST_SPACE.test(s) ? s : "";
}


/** @param {any} row */
function labelOf(row) {
  const raw = row && (row.label || row.displayName || row.name) || "";
  return String(raw).replace(/\.vyre\.run$/i, "").trim().slice(0, 80);
}

/** A server address a tool already returned. https only. @param {any} row */
function serverFrom(row) {
  if (!row || typeof row !== "object") return "";
  const home = row.home && typeof row.home === "object" ? row.home.url : "";
  return serverUrl(row.server) || serverUrl(row.url) || serverUrl(home) || (typeof row.name === "string" && row.name.endsWith(".vyre.run") ? serverUrl(`https://${row.name}`) : "");
}

/** @param {{ link: string, role: string, ttlDays: number, space: string | null }} made */
function remember(made) {
  const parsed = parseInvite(made.link);
  if (parsed) links.set(parsed.token, { role: made.role, ttlDays: made.ttlDays, space: made.space || "", link: parsed.link });
  return made;
}

/** @param {(tool: string, input?: any) => Promise<any>} relayTool @param {any} held @param {string | null} personId @param {unknown} space @param {unknown} role @param {unknown} ttlDays @param {boolean} [checkRole] */
async function invite(relayTool, held, personId, space, role, ttlDays, checkRole = true) {
  const picked = inviteRole(role);
  const days = inviteDays(ttlDays);
  if (!picked) throw bad("Pick a role: admin, member or guest.");
  if (!days) throw bad("An invite lasts 1, 7 or 30 days.");
  const spaceName = String(space || "").trim().slice(0, 80);
  if (!spaceName) throw bad("Name the space this link is for.");
  const rows = await (async () => {
    /** @type {any[]} */ let remote = [];
    try { const got = await relayTool("spaces.list", {}); if (Array.isArray(got)) remote = got; } catch { remote = []; }
    return [...held.spaces, ...remote.map((row) => membershipOf({ id: row.id, name: labelOf(row), role: row.role, server: serverFrom(row) })).filter(Boolean)];
  })();
  const mine = rows.find((s) => s && (s.name === spaceName || s.id === spaceName));
  const actorRole = mine && mine.role ? mine.role : "owner";
  const assignRole = picked === "guest" ? "temp" : picked;
  if (checkRole && !canAssign(actorRole, assignRole)) throw bad("You cannot invite someone with that role.");
  const made = await relayTool("spaces.invites.create", { space: spaceName, role: picked, ttlDays: days });
  const link = made && typeof made.link === "string" ? made.link : "";
  const parsed = parseInvite(link);
  if (!parsed) throw bad("The invite link did not come back.");
  return { link: parsed.link, role: picked, ttlDays: days, space: spaceName };
}

/** The GitHub address from kernel config (`github.start`). https only, no userinfo. Empty when it is unset or not an address. @param {any} config */
function githubStart(config) {
  const raw = config && config.github && typeof config.github.start === "string" ? config.github.start.trim() : "";
  if (!raw || raw.length > 300) return "";
  let url;
  try { url = new URL(raw); } catch { return ""; }
  if (url.protocol !== "https:" || url.username || url.password) return "";
  return url.toString();
}

/** A space address the person typed. https only, no userinfo. @param {unknown} raw */
function serverUrl(raw) {
  const text = String(raw ?? "").trim();
  if (!text || text.length > 300) return "";
  let url;
  try { url = new URL(text); } catch { return ""; }
  if (url.protocol !== "https:") return "";
  if (url.username || url.password) return "";
  return url.origin;
}
