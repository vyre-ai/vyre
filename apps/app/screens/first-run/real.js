// @ts-check
// The only door the first-run screens use. Every name is a registry tool (core/onboard/first-run.js), which the MCP server forwards as itself.
import { MOCK, tool } from "../../src/real/box";
import { GITHUB_MOCK } from "../onboard/flow-model.js";

/** @param {any} e */
const fail = (e) => {
  const code = e && e.code ? String(e.code) : "failed";
  const message = code === "held_for_approval" ? "This waits for your approval. Nothing changed." : (e && e.message) || "That did not work. Try again.";
  return { ok: false, message, code };
};

/** @param {unknown} value @returns {any} */
const done = (value) => ({ ok: true, ...(value && typeof value === "object" ? value : {}) });

/** @param {string} username */
export async function lookupPerson(username) {
  if (MOCK) return { ok: true, username, route: `https://vyre.run/u/${username}` };
  try { return done(await tool("onboard.person.lookup", { username })); }
  catch (e) { return fail(e); }
}

/** @param {{ username: string, password: string, confirm: string }} input */
export async function createPerson(input) {
  if (MOCK) return { ok: true, username: input.username, route: `https://vyre.run/u/${input.username}`, recoveryKey: "R1-SAMPLE-KEY-SHOWN-ONCE", once: true };
  try { return done(await tool("onboard.person.create", { username: input.username, password: input.password, confirm: input.confirm })); }
  catch (e) { return fail(e); }
}

export async function startGithub() {
  if (MOCK) return { ok: true, url: null, user: GITHUB_MOCK.fresh };
  try { return done(await tool("onboard.github.start", {})); }
  catch (e) { return fail(e); }
}

/** @param {string} login */
export async function finishGithub(login) {
  if (MOCK) return { ok: true, linked: true, login, vault: "password" };
  try { return done(await tool("onboard.github.finish", { login })); }
  catch (e) { return fail(e); }
}

/** @param {string} link */
export async function readInvite(link) {
  if (MOCK) return { ok: true, link, role: "member", space: "juniper", ttlDays: 7 };
  try { return done(await tool("onboard.join.read", { link })); }
  catch (e) { return fail(e); }
}

/** @param {string} link */
export async function joinSpace(link) {
  if (MOCK) return { ok: true, joined: true, space: "juniper", role: "member" };
  try { return done(await tool("onboard.space.join", { link })); }
  catch (e) { return fail(e); }
}

/** @param {{ kind: "linux" | "mac", name?: string }} input */
export async function openSpace(input) {
  if (MOCK) return { ok: true, id: "fr_sample", kind: input.kind, command: input.kind === "mac" ? "curl -fsSL vyre.run/box/install-mac-server.sh | sh" : "curl -fsSL vyre.run/i | sh" };
  try { return done(await tool("onboard.space.open", { kind: input.kind, ...(input.name ? { name: input.name } : {}) })); }
  catch (e) { return fail(e); }
}

/** @param {string} id */
export async function pollSpace(id) {
  if (MOCK) return { ok: true, id, online: false, expired: false };
  try { return done(await tool("onboard.space.poll", { id })); }
  catch (e) { return fail(e); }
}

/** @param {{ space?: string, role: string, ttlDays: number }} input */
export async function makeInvite(input) {
  if (MOCK) return { ok: true, link: "https://vyre.run/i/sampletoken", role: input.role, ttlDays: input.ttlDays, space: input.space || "juniper" };
  try { return done(await tool("onboard.member.link", { role: input.role, ttlDays: input.ttlDays, ...(input.space ? { space: input.space } : {}) })); }
  catch (e) { return fail(e); }
}

/** @param {{ url: string, username?: string, password: string, github?: boolean }} input */
export async function addComputer(input) {
  if (MOCK) return { ok: true, url: input.url, username: input.username || null, github: input.github === true, added: true };
  try {
    return done(await tool("onboard.computer.add", { url: input.url, password: input.password, ...(input.username ? { username: input.username } : {}), ...(input.github ? { github: true } : {}) }));
  } catch (e) { return fail(e); }
}

/** @param {string} [space] */
export async function addPhone(space) {
  if (MOCK) return { ok: true, link: "https://vyre.run/i/samplephone", space: space || null };
  try { return done(await tool("onboard.phone.add", space ? { space } : {})); }
  catch (e) { return fail(e); }
}
