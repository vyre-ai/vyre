// @ts-check
// The only door the first-run screens use. Every name is a registry tool (core/onboard/first-run.js), which the MCP server forwards as itself.
import { MOCK, tool } from "../../src/real/box";
import { GITHUB_MOCK } from "../onboard/flow-model.js";

/** Sample spaces for the mock export. One identity, added as the person joins or creates. */
const mock = { person: /** @type {string | null} */ (null), id: "id_alex", current: /** @type {string | null} */ (null), spaces: /** @type {{ id: string, name: string, role: string, server: string | null }[]} */ ([]) };

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

export async function personStatus() {
  if (MOCK) return { ok: true, exists: false, username: mock.person, id: mock.person ? mock.id : null, current: mock.current, spaces: mock.spaces.slice() };
  try { return done(await tool("onboard.person.status", {})); }
  catch (e) { return fail(e); }
}

/** @param {{ username: string, password: string, confirm: string }} input */
export async function createPerson(input) {
  if (MOCK) {
    mock.person = input.username;
    return { ok: true, username: input.username, id: mock.id, route: `https://vyre.run/u/${input.username}`, recoveryKey: "R1-SAMPLE-KEY-SHOWN-ONCE", once: true, already: false };
  }
  try { return done(await tool("onboard.person.create", { username: input.username, password: input.password, confirm: input.confirm })); }
  catch (e) { return fail(e); }
}

export async function startGithub() {
  if (MOCK) return { ok: true, url: null, user: GITHUB_MOCK.fresh };
  try { return done(await tool("onboard.github.start", {})); }
  catch (e) { return fail(e); }
}

/** @param {string} [login] @param {string} [code] */
export async function finishGithub(login, code) {
  if (MOCK) return { ok: true, linked: true, login: login || "sam-builds", vault: "password" };
  /** @type {Record<string, string>} */
  const input = {};
  if (login) input.login = login;
  if (code) input.code = code;
  try { return done(await tool("onboard.github.finish", input)); }
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
  if (MOCK) {
    const name = mock.spaces.some((s) => s.name === "juniper") ? "studio" : "juniper";
    const role = name === "studio" ? "admin" : "member";
    const row = { id: `spc_${name}`, name, role, server: `https://${name}.vyre.run` };
    mock.spaces = mock.spaces.filter((s) => s.id !== row.id).concat([row]);
    mock.current = row.id;
    return { ok: true, joined: true, space: name, id: row.id, role, server: row.server };
  }
  try { return done(await tool("onboard.space.join", { link })); }
  catch (e) { return fail(e); }
}

/** @param {{ kind: "linux" | "mac", name?: string }} input */
export async function openSpace(input) {
  if (MOCK) {
    const name = input.name || "space";
    const row = { id: `spc_${name}`, name, role: "owner", server: /** @type {string | null} */ (null) };
    mock.spaces = mock.spaces.filter((s) => s.id !== row.id).concat([row]);
    mock.current = row.id;
    return { ok: true, id: "fr_sample", spaceId: row.id, role: "owner", kind: input.kind, command: "curl -fsSL vyre.run/i | sh" };
  }
  try { return done(await tool("onboard.space.open", { kind: input.kind, ...(input.name ? { name: input.name } : {}) })); }
  catch (e) { return fail(e); }
}

/** @param {string} id */
export async function pollSpace(id) {
  if (MOCK) return { ok: true, id, online: false, expired: false };
  try { return done(await tool("onboard.space.poll", { id })); }
  catch (e) { return fail(e); }
}

export async function listSpaces() {
  if (MOCK) return { ok: true, person: mock.person || "alex", id: mock.id, current: mock.current, spaces: mock.spaces.slice() };
  try { return done(await tool("onboard.space.list", {})); }
  catch (e) { return fail(e); }
}

/** @param {string} space */
export async function chooseSpace(space) {
  if (MOCK) {
    const hit = mock.spaces.find((s) => s.id === space || s.name === space);
    if (!hit) return { ok: false, message: "That space is not one this identity belongs to.", code: "bad_input" };
    mock.current = hit.id;
    return { ok: true, current: hit.id, name: hit.name, role: hit.role, server: hit.server };
  }
  try { return done(await tool("onboard.space.current", { space })); }
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

export async function finishFirstRun() {
  if (MOCK) return { ok: true, done: true };
  try { return done(await tool("onboard.first.done", {})); }
  catch (e) { return fail(e); }
}

/** @param {string} [space] */
export async function addPhone(space) {
  if (MOCK) return { ok: true, link: "https://vyre.run/i/samplephone", space: space || null };
  try { return done(await tool("onboard.phone.add", space ? { space } : {})); }
  catch (e) { return fail(e); }
}
