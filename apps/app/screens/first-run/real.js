// @ts-check
// The only door the first-run screens use. Every name is a registry tool (core/onboard/first-run.js), which the MCP server forwards as itself.
import { MOCK, tool } from "../../src/real/box";
import * as mock from "./mock-api.js";

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
  if (MOCK) return mock.lookupPerson(username);
  try { return done(await tool("onboard.person.lookup", { username })); }
  catch (e) { return fail(e); }
}

export async function personStatus() {
  if (MOCK) return mock.personStatus();
  try { return done(await tool("onboard.person.status", {})); }
  catch (e) { return fail(e); }
}

/** @param {{ username: string, password: string, confirm: string }} input */
export async function createPerson(input) {
  if (MOCK) return mock.createPerson(input);
  try { return done(await tool("onboard.person.create", { username: input.username, password: input.password, confirm: input.confirm })); }
  catch (e) { return fail(e); }
}

export async function startGithub() {
  if (MOCK) return mock.startGithub();
  try { return done(await tool("onboard.github.start", {})); }
  catch (e) { return fail(e); }
}

/** @param {string} [login] @param {string} [code] */
export async function finishGithub(login, code) {
  if (MOCK) return mock.finishGithub(login);
  /** @type {Record<string, string>} */
  const input = {};
  if (login) input.login = login;
  if (code) input.code = code;
  try { return done(await tool("onboard.github.finish", input)); }
  catch (e) { return fail(e); }
}

/** @param {string} link */
export async function readInvite(link) {
  if (MOCK) return mock.readInvite(link);
  try { return done(await tool("onboard.join.read", { link })); }
  catch (e) { return fail(e); }
}

/** @param {string} link */
export async function joinSpace(link) {
  if (MOCK) return mock.joinSpace(link);
  try { return done(await tool("onboard.space.join", { link })); }
  catch (e) { return fail(e); }
}

/** @param {{ kind: "linux" | "mac", name?: string }} input */
export async function openSpace(input) {
  if (MOCK) return mock.openSpace(input);
  try { return done(await tool("onboard.space.open", { kind: input.kind, ...(input.name ? { name: input.name } : {}) })); }
  catch (e) { return fail(e); }
}

/** @param {string} id */
export async function pollSpace(id) {
  if (MOCK) return mock.pollSpace(id);
  try { return done(await tool("onboard.space.poll", { id })); }
  catch (e) { return fail(e); }
}

export async function listSpaces() {
  if (MOCK) return mock.listSpaces();
  try { return done(await tool("onboard.space.list", {})); }
  catch (e) { return fail(e); }
}

/** @param {string} space */
export async function chooseSpace(space) {
  if (MOCK) return mock.chooseSpace(space);
  try { return done(await tool("onboard.space.current", { space })); }
  catch (e) { return fail(e); }
}

/** @param {{ space?: string, role: string, ttlDays: number }} input */
export async function makeInvite(input) {
  if (MOCK) return mock.makeInvite(input);
  try { return done(await tool("onboard.member.link", { role: input.role, ttlDays: input.ttlDays, ...(input.space ? { space: input.space } : {}) })); }
  catch (e) { return fail(e); }
}

/** @param {{ url: string, username?: string, password: string, github?: boolean }} input */
export async function addComputer(input) {
  if (MOCK) return mock.addComputer(input);
  try {
    return done(await tool("onboard.computer.add", { url: input.url, password: input.password, ...(input.username ? { username: input.username } : {}), ...(input.github ? { github: true } : {}) }));
  } catch (e) { return fail(e); }
}

export async function finishFirstRun() {
  if (MOCK) return mock.finishFirstRun();
  try { return done(await tool("onboard.first.done", {})); }
  catch (e) { return fail(e); }
}

/** @param {string} [space] */
export async function addPhone(space) {
  if (MOCK) return mock.addPhone(space);
  try { return done(await tool("onboard.phone.add", space ? { space } : {})); }
  catch (e) { return fail(e); }
}

export async function listAgentProviders() {
  if (MOCK) return mock.listAgentProviders();
  try { return done(await tool("onboard.agent.list", {})); }
  catch (e) { return fail(e); }
}

/** @param {{ provider: string, label?: string, flow?: string, code?: string }} input */
export async function signInAgent(input) {
  if (MOCK) return mock.signInAgent(input);
  try { return done(await tool("onboard.agent.signin", input)); }
  catch (e) { return fail(e); }
}

export async function loadProgress() {
  if (MOCK) return mock.loadProgress();
  try { return done(await tool("onboard.first.progress", {})); }
  catch (e) { return fail(e); }
}

/** @param {{ screen: string, stack: string[] }} input */
export async function saveProgress(input) {
  if (MOCK) return mock.saveProgress(input);
  try { return done(await tool("onboard.first.progress.save", input)); }
  catch (e) { return fail(e); }
}
