// @ts-check
// The only door the first-run screens use. Every name is a registry tool (core/onboard/first-run.js), which the MCP server forwards as itself.
import { MOCK, tool } from "../../src/real/box";
import { hostWanted } from "../../src/host";
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
  if (MOCK) return mock.finishGithub(login || "");
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

/** Pick another name for a space whose name the directory said was taken; the paired server is kept and the claim is tried again. @param {string} id @param {string} name */
export async function renameSpace(id, name) {
  if (MOCK) return { ok: true, id, name };
  try { return done(await tool("onboard.space.name", { id, name })); }
  catch (e) { return fail(e); }
}

/** "Not your server? Remove it": the paired server and the space made with it are forgotten here. @param {string} space */
export async function removeSpace(space) {
  if (MOCK) return mock.removeSpace(space);
  try { return done(await tool("onboard.space.remove", { space })); }
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

export async function finishFirstRun() {
  if (MOCK) return mock.finishFirstRun();
  try { return done(await tool("onboard.first.done", {})); }
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

/** Name the Assistant and keep its look: made on the server this space is on. `person` is the name the person gave in the name step (the server shows it beside theirs). @param {{ name: string, look: string, person?: string }} input */
export async function setAssistant(input) {
  if (MOCK) return mock.setAssistant(input);
  try { return done(await tool("onboard.assistant.set", input)); }
  catch (e) { return fail(e); }
}

/** What each connected AI account offers, for the model step. */
export async function listAssistantModels() {
  if (MOCK) return mock.listAssistantModels();
  try { return done(await tool("onboard.assistant.models", {})); }
  catch (e) { return fail(e); }
}

/** Keep the Assistant's default model. @param {string} model */
export async function setAssistantModel(model) {
  if (MOCK) return mock.setAssistantModel(model);
  try { return done(await tool("onboard.assistant.model", { model })); }
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

/** Sign in from any device: a space's address, the username and the password. The space gives the person's wrapped identity, the device opens it with the password, and the person is in every space they belong to. @param {{ space: string, username: string, password: string }} input */
export async function signInPassword(input) {
  if (MOCK) return mock.signInPassword(input);
  try { return done(await tool("onboard.signin", input)); }
  catch (e) { return fail(e); }
}

/** Sign in with GitHub: it finds the spaces this person belongs to (or logs in to the one space address the person typed). The password is asked once, next (unlockGithub). @param {string} [space] */
export async function signInGithub(space) {
  if (MOCK) return mock.signInGithub();
  try { return done(await tool("onboard.signin.github", space ? { space } : {})); }
  catch (e) { return fail(e); }
}

/** @param {string} password */
export async function unlockGithub(password) {
  if (MOCK) return mock.unlockGithub(password);
  try { return done(await tool("onboard.signin.unlock", { password })); }
  catch (e) { return fail(e); }
}

/** Is this page one with no daemon of its own (the hosted web app, or the Mac or Windows window with no vyred)? Its AI accounts are made on its server, so the AI step comes after the space is online. */
export const pageHasNoDaemon = () => !MOCK && hostWanted();
