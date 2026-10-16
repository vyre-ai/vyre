// @ts-check
// First run, invites, and adding a computer or a phone. One tool each: the app calls these, and the MCP server
// forwards the same registry tools (harness/mcp/server.js holds none of its own).
//
// A call that changes people, devices or vault access is outward. The registry holds an agent's call as a card
// (approvals.hold) until the person approves it. A person's own call runs now.
//
// The same tools the other screens use, called when they are on this server and skipped when they are not:
//   identity.create and identity.unlock (the master password), devices.signin (a computer joins a space),
//   wink.install.issue, wink.install.status and wink.install.complete (one install line).
// Until those answer, the older vault and install calls are tried, and the line is the plain installer with no code in it.

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
  const { tryCall, save } = io;

  ctx.tool("onboard.person.lookup", {
    effect: "read",
    description: "Check a username for the public person page. Says whether the form is valid. Reads nothing secret.",
    input: obj({ username: str }, ["username"]),
    callers: [...OPEN],
    run: async ({ username }) => {
      const name = usernameOf(username);
      if (!name) return { ok: false, reason: "invalid" };
      const routes = personRoutes(name);
      return { ok: true, username: name, ...routes };
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
      // The password is an argument of the vault tool and is not written to the event log or the saved record.
      const pending = [];
      let recoveryKey = /** @type {string | null} */ (null);
      const created = await tryCall("identity.create", { username: name, password });
      if (created && !created.__error) {
        if (typeof created.recoveryKey === "string") recoveryKey = created.recoveryKey;
        save({ onboard: { person: created.username || name } });
        ctx.events.emit("onboard.stepped", { step: "identity", username: name });
        return { username: created.username || name, ...personRoutes(name), recoveryKey, once: true };
      }
      pending.push("identity.create");
      const vault = await tryCall("vault.account.create", { password });
      if (vault && !vault.__error && typeof vault.recoverySecret === "string") recoveryKey = vault.recoverySecret;
      else pending.push("vault.account.create");
      // workstream A: spaces.identity.create still wants a reservation code. A username-only create is the contract not merged yet.
      const ident = await tryCall("spaces.identity.create", { name, password });
      if (ident && !ident.__error && typeof ident.recoveryCode === "string" && !recoveryKey) recoveryKey = ident.recoveryCode;
      else if (!ident || ident.__error) pending.push("spaces.identity.create");
      save({ onboard: { person: name } });
      ctx.events.emit("onboard.stepped", { step: "identity", username: name });
      return { username: name, ...personRoutes(name), recoveryKey, once: true, ...(pending.length ? { pending } : {}) };
    },
  });

  ctx.tool("onboard.github.start", {
    effect: "read",
    description: "Begin Continue with GitHub. Returns the address the person opens. GitHub does not unlock the vault.",
    input: obj({}),
    callers: [...OPEN],
    run: async () => {
      // The relay's GitHub start is the app's own browser step (screens/onboard/real-github.ts) until a kernel contract exists.
      return { url: null, pending: ["github.start"] };
    },
  });

  ctx.tool("onboard.github.finish", {
    effect: "write",
    description: "Link a GitHub login to this person. The master password is still required to unlock the vault.",
    input: obj({ login: str }, ["login"]),
    callers: [...OPEN],
    run: async ({ login }) => {
      const name = String(login ?? "").trim().toLowerCase();
      if (!/^[a-z0-9-]{1,39}$/.test(name)) throw bad("That GitHub login cannot be linked.");
      save({ onboard: { github: name } });
      return { linked: true, login: name, vault: "password" };
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
      const joined = await tryCall("spaces.invites.accept", { link: parsed.link });
      if (joined && !joined.__error) return { joined: true, space: joined.space || joined.name || held?.space || null, role: held?.role || joined.role || "member" };
      if (held) { links.delete(parsed.token); return { joined: true, space: held.space || null, role: held.role, pending: ["spaces.invites.accept"] }; }
      // A legacy link the spaces module minted is accepted by that module when it is up. Until then the link is remembered as the ask.
      return { joined: false, pending: ["spaces.invites.accept"], space: parsed.spaceHost ? parsed.spaceHost.replace(/\.vyre\.run$/, "") : null, role: "member" };
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
      // workstream B: spaces.pair.install returns the one line with a single-use code that is not in argv, env or stdin.
      let command = /** @type {string | null} */ (null);
      const pending = [];
      const issued = await tryCall("wink.install.issue", { os: place === "mac" ? "mac" : "linux" });
      if (issued && !issued.__error && typeof issued.line === "string") command = issued.line;
      else pending.push("wink.install.issue");
      const pair = !command ? await tryCall("spaces.pair.install", { kind: place, name: label }) : null;
      if (pair && !pair.__error && typeof pair.command === "string") command = pair.command;
      else if (!command) pending.push("spaces.pair.install");
      if (!command) {
        const inst = await tryCall("spaces.server.install", { space: label });
        if (inst && !inst.__error && typeof inst.installCommand === "string") command = String(inst.installCommand).trim();
      }
      if (!command) command = place === "mac" ? "curl -fsSL vyre.run/box/install-mac-server.sh | sh" : "curl -fsSL vyre.run/i | sh";
      if (!commandOk(command)) throw bad("The install command is not one this app can show.");
      const id = `fr_${randomBytes(8).toString("hex")}`;
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      waits.set(id, { command, expiresAt, kind: place, name: label });
      return { id, command, expiresAt, kind: place, name: label, ...(pending.length ? { pending } : {}) };
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
      if (Date.parse(row.expiresAt) < Date.now()) return { id, online: false, expired: true };
      let online = false;
      const st = await tryCall("wink.install.status", {});
      if (st && !st.__error && (st.owned || st.locked)) online = true;
      // The person's own screen may finish pairing. An agent calls wink.install.complete, which is held for a tap.
      if (!online && isPerson(meta && meta.caller)) {
        const done = await tryCall("wink.install.complete", {});
        if (done && !done.__error && done.ok) online = true;
        if (!online) {
          const again = await tryCall("wink.install.status", {});
          if (again && !again.__error && (again.owned || again.locked)) online = true;
        }
      }
      return { id, online, expired: false, kind: row.kind };
    },
  });

  ctx.tool("onboard.member.link", {
    effect: "write",
    description: "Make a link someone can use to join a space, for a role and a number of days.",
    input: obj({ space: str, role: str, ttlDays: { type: "number" } }, ["role", "ttlDays"]),
    callers: [...OPEN],
    run: async ({ space, role, ttlDays }) => {
      const picked = inviteRole(role);
      const days = inviteDays(ttlDays);
      if (!picked) throw bad("Pick a role: admin, member or guest.");
      if (!days) throw bad("An invite lasts 1, 7 or 30 days.");
      const spaceName = String(space || "").trim().slice(0, 80);
      const made = await tryCall("spaces.invites.create", { space: spaceName, role: picked === "guest" ? "guest" : picked, ttlDays: days });
      let link = made && !made.__error && typeof made.link === "string" ? made.link : "";
      const pending = [];
      if (!link) {
        pending.push("spaces.invites.create");
        const token = randomBytes(16).toString("base64url");
        link = `https://vyre.run/i/${token}`;
        links.set(token, { role: picked, ttlDays: days, space: spaceName, link });
      }
      return { link, role: picked, ttlDays: days, space: spaceName || null, ...(pending.length ? { pending } : {}) };
    },
  });

  ctx.tool("onboard.computer.add", {
    effect: "write",
    description: "Add this person's computer to a space with its address, name and master password, or GitHub.",
    input: obj({ url: str, username: str, password: str, github: { type: "boolean" }, name: str, type: str, fingerprint: str }, ["url", "password"]),
    callers: [...OPEN],
    run: async ({ url, username, password, github }) => {
      const address = serverUrl(url);
      if (!address) throw bad("The space address is a https URL.");
      if (!passwordOk(password)) throw bad("The master password is required, and it is at least 12 characters.");
      const name = usernameOf(username);
      if (!github && !name) throw bad("Give the username, or continue with GitHub.");
      // The password is the master password. devices.signin carries it to the space. identity.unlock opens this computer. Neither value is stored here.
      const pending = [];
      const signed = await tryCall("devices.signin", { server: address, password, ...(name ? { username: name } : {}) });
      if (signed && !signed.__error) return { url: address, username: signed.username || name || null, github: github === true, added: true, unlocked: signed.unlocked === true };
      pending.push("devices.signin");
      const unlocked = await tryCall("identity.unlock", { password });
      if (!unlocked || unlocked.__error) pending.push("identity.unlock");
      const added = await tryCall("spaces.computer.add", { url: address, username: name || undefined, github: github === true });
      if (!added || added.__error) pending.push("spaces.computer.add");
      return { url: address, username: (unlocked && unlocked.username) || name || null, github: github === true, added: true, ...(pending.length ? { pending } : {}) };
    },
  });

  ctx.tool("onboard.phone.add", {
    effect: "write",
    description: "Add this person's phone. Returns a link the phone opens. Changes which devices can reach the space.",
    input: obj({ space: str, name: str, type: str, fingerprint: str }),
    callers: [...OPEN],
    run: async ({ space }) => {
      const spaceName = String(space || "").trim().slice(0, 80);
      const token = randomBytes(16).toString("base64url");
      const link = `https://vyre.run/i/${token}`;
      links.set(token, { role: "member", ttlDays: 1, space: spaceName, link });
      // The phone opens this link. The old typed code and word check are not part of this step.
      return { link, space: spaceName || null, pending: ["phone.add"] };
    },
  });

  ctx.tool("onboard.first.done", {
    effect: "write",
    description: "Mark the first run finished so this computer opens the app.",
    input: obj({}),
    callers: ["cli", "local", "deck", "capsule", "device"],
    run: async () => {
      save({ onboard: { firstRun: null } });
      return { done: true };
    },
  });
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
