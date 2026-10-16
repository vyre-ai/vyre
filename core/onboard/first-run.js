// @ts-check
// First run, invites, and adding a computer or a phone. One tool each: the app calls these, and the MCP server
// forwards the same registry tools (harness/mcp/server.js holds none of its own).
//
// Each write calls the kernel tool that owns the act. This file does not mint a second identity, a second install
// code, or a second owner change. A phone is a link. It never signs a change of who owns a space.

import { randomBytes } from "node:crypto";
import { isPerson } from "../../lib/caller.js";
import { commandOk, inviteDays, inviteRole, parseInvite, passwordOk, personRoutes, placeKind, usernameOf } from "../../lib/first-run-shape.js";

const OPEN = Object.freeze(["cli", "local", "deck", "capsule", "device", "mcp", "harness"]);
const obj = (properties, required = []) => ({ type: "object", properties, required });
const str = { type: "string" };
const bad = (message) => Object.assign(new Error(message), { code: "bad_input" });

/** @type {Map<string, { command: string, expiresAt: string, kind: string, name: string }>} */
const waits = new Map();
/** @type {Map<string, { role: string, ttlDays: number, space: string, link: string }>} */
const links = new Map();

/**
 * @param {any} ctx
 * @param {{ call: (tool: string, input?: any) => Promise<any>, tryCall: (tool: string, input?: any) => Promise<any>, save: (patch: any) => void }} io
 */
export function registerFirstRun(ctx, io) {
  const { call, save } = io;

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

  ctx.tool("onboard.person.create", {
    effect: "write",
    description: "Create this person's identity and vault from a username and master password. Returns the recovery key once.",
    input: obj({ username: str, password: str, confirm: str }, ["username", "password"]),
    callers: [...OPEN],
    run: async ({ username, password, confirm }) => {
      const name = usernameOf(username);
      if (!name) throw bad("A username is lowercase letters, digits and hyphens, 3 to 20 characters, starting with a letter.");
      if (!passwordOk(password)) throw bad("Use a master password of at least 12 characters, and not a common one.");
      if (confirm !== undefined && confirm !== password) throw bad("Type the master password the same way twice.");
      const made = await call("identity.create", { username: name, password });
      const recoveryKey = made && typeof made.recoveryKey === "string" ? made.recoveryKey : null;
      save({ onboard: { person: name } });
      ctx.events.emit("onboard.stepped", { step: "identity", username: name });
      return { username: name, ...personRoutes(name), recoveryKey, once: true };
    },
  });

  ctx.tool("onboard.github.start", {
    effect: "read",
    description: "Begin Continue with GitHub. Returns the address the person opens. GitHub does not unlock the vault.",
    input: obj({}),
    callers: [...OPEN],
    run: async () => {
      // No kernel tool returns a GitHub address yet. Linking still goes through identity.github.link once the subject is known.
      return { url: null, pending: ["github.start"] };
    },
  });

  ctx.tool("onboard.github.finish", {
    effect: "write",
    description: "Link a GitHub login to this person. The master password is still required to unlock the vault.",
    input: obj({ login: str, subject: str }, ["login"]),
    callers: [...OPEN],
    run: async ({ login, subject }) => {
      const name = String(login ?? "").trim().toLowerCase();
      if (!/^[a-z0-9-]{1,39}$/.test(name)) throw bad("That GitHub login cannot be linked.");
      const id = String(subject ?? "").trim();
      if (!id) return { linked: false, login: name, vault: "password", pending: ["identity.github.link"] };
      const linked = await call("identity.github.link", { login: name, subject: id });
      save({ onboard: { github: name } });
      return { linked: true, login: (linked && linked.login) || name, vault: "password" };
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
      const held = links.get(parsed.token);
      const space = held?.space || (parsed.spaceHost ? parsed.spaceHost.replace(/\.vyre\.run$/, "") : "");
      return { link: parsed.link, role: held?.role || "member", space: space || null, ttlDays: held?.ttlDays || null };
    },
  });

  ctx.tool("onboard.space.join", {
    effect: "write",
    description: "Accept an invite link and join that space with the role on the link. Changes who is in the space.",
    input: obj({ link: str }, ["link"]),
    callers: [...OPEN],
    run: async ({ link }) => {
      const parsed = parseInvite(link);
      if (!parsed) throw bad("That link does not open a space. Ask for a new invite.");
      const held = links.get(parsed.token);
      const joined = await call("spaces.invites.accept", { link: parsed.link });
      if (held) links.delete(parsed.token);
      return { joined: true, space: (joined && (joined.space || joined.name)) || held?.space || null, role: held?.role || (joined && joined.role) || "member" };
    },
  });

  ctx.tool("onboard.space.open", {
    effect: "write",
    description: "Start a space on a Linux server or an always-on Mac and return the one install command.",
    input: obj({ kind: { type: "string", enum: ["linux", "mac"] }, name: str }, ["kind"]),
    callers: [...OPEN],
    run: async ({ kind, name }) => {
      const place = placeKind(kind);
      if (!place) throw bad("Pick a Linux server or an always-on Mac.");
      const label = usernameOf(name) || "space";
      const issued = await call("wink.install.issue", { os: place });
      const command = issued && typeof issued.line === "string" ? issued.line : "";
      if (!commandOk(command)) throw bad("The install command is not one this app can show.");
      const id = `fr_${randomBytes(8).toString("hex")}`;
      const expiresAt = new Date(Number(issued.expires) * 1000).toISOString();
      waits.set(id, { command, expiresAt, kind: place, name: label });
      return { id, command, expiresAt, kind: place, name: label };
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
      try { status = await call("wink.install.status", {}); } catch { status = null; }
      if (status && (status.owned || status.locked)) return { id, online: true, expired: false, kind: row.kind };
      const expMs = status && status.expires ? Number(status.expires) * 1000 : Date.parse(row.expiresAt);
      if (Number.isFinite(expMs) && expMs < Date.now() && !(status && status.issued)) return { id, online: false, expired: true, kind: row.kind };
      // The person's own screen may finish pairing. An agent calls wink.install.complete, which is held for a tap.
      if (isPerson(meta && meta.caller)) {
        try {
          const done = await call("wink.install.complete", {});
          if (done && done.ok) return { id, online: true, expired: false, kind: row.kind };
        } catch { /* the server has not taken the line yet */ }
      }
      return { id, online: false, expired: false, kind: row.kind };
    },
  });

  ctx.tool("onboard.member.link", {
    effect: "write",
    description: "Make a link someone can use to join a space, for a role and a number of days.",
    input: obj({ space: str, role: str, ttlDays: { type: "number" } }, ["role", "ttlDays"]),
    callers: [...OPEN],
    run: async ({ space, role, ttlDays }) => remember(await invite(call, space, role, ttlDays)),
  });

  ctx.tool("onboard.computer.add", {
    effect: "write",
    description: "Add this person's computer to a space with its address, name and master password, or GitHub.",
    input: obj({ url: str, username: str, password: str, github: { type: "boolean" }, login: str, subject: str }, ["url", "password"]),
    callers: [...OPEN],
    run: async ({ url, username, password, github, login, subject }) => {
      const address = serverUrl(url);
      if (!address) throw bad("The space address is a https URL.");
      if (!passwordOk(password)) throw bad("The master password is required, and it is at least 12 characters.");
      const name = usernameOf(username);
      const ghLogin = String(login ?? "").trim().toLowerCase();
      const ghSubject = String(subject ?? "").trim();
      if (!name && !(github === true && ghSubject)) throw bad("Give the username, or a GitHub account already linked on this device.");
      const signed = await call("devices.signin", {
        server: address,
        password,
        ...(name ? { username: name } : {}),
        ...(github === true && ghSubject ? { github: { login: ghLogin, subject: ghSubject } } : {}),
      });
      return { url: address, username: (signed && signed.username) || name || null, github: github === true, added: true };
    },
  });

  ctx.tool("onboard.phone.add", {
    effect: "write",
    description: "Add this person's phone. Returns a link the phone opens. Changes which devices can reach the space.",
    input: obj({ space: str }),
    callers: [...OPEN],
    run: async ({ space }) => {
      const made = remember(await invite(call, space, "member", 1));
      return { link: made.link, space: made.space, role: "member" };
    },
  });
}

/** @param {{ link: string, role: string, ttlDays: number, space: string | null }} made */
function remember(made) {
  const parsed = parseInvite(made.link);
  if (parsed) links.set(parsed.token, { role: made.role, ttlDays: made.ttlDays, space: made.space || "", link: parsed.link });
  return made;
}

/** @param {(tool: string, input?: any) => Promise<any>} call @param {unknown} space @param {unknown} role @param {unknown} ttlDays */
async function invite(call, space, role, ttlDays) {
  const picked = inviteRole(role);
  const days = inviteDays(ttlDays);
  if (!picked) throw bad("Pick a role: admin, member or guest.");
  if (!days) throw bad("An invite lasts 1, 7 or 30 days.");
  const spaceName = String(space || "").trim().slice(0, 80);
  if (!spaceName) throw bad("Name the space this link is for.");
  const made = await call("spaces.invites.create", { space: spaceName, role: picked, ttlDays: days });
  const link = made && typeof made.link === "string" ? made.link : "";
  const parsed = parseInvite(link);
  if (!parsed) throw bad("The invite link did not come back.");
  return { link: parsed.link, role: picked, ttlDays: days, space: spaceName };
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
