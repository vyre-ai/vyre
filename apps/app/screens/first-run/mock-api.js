// @ts-check
// Mock answers for first-run tools. Used only when EXPO_PUBLIC_VYRE_MOCK=1.

import { GITHUB_MOCK } from "./mock.js";

const mock = { person: /** @type {string | null} */ (null), id: "id_alex", current: /** @type {string | null} */ (null), spaces: /** @type {{ id: string, name: string, role: string, server: string | null }[]} */ ([]) };
let progress = { screen: "id.create", stack: ["id.create"] };

/** @param {string} username */
export async function lookupPerson(username) {
  return { ok: true, username, route: `https://vyre.run/u/${username}` };
}

export async function personStatus() {
  return { ok: true, exists: false, username: mock.person, id: mock.person ? mock.id : null, current: mock.current, spaces: mock.spaces.slice() };
}

/** @param {any} input */
export async function createPerson(input) {
  mock.person = input.username;
  return { ok: true, username: input.username, id: mock.id, route: `https://vyre.run/u/${input.username}`, recoveryKey: "R1-SAMPLE-KEY-SHOWN-ONCE", once: true, already: false };
}

export async function startGithub() {
  return { ok: true, url: null, user: GITHUB_MOCK.fresh };
}

/** @param {string} login */
export async function finishGithub(login) {
  return { ok: true, linked: true, login, vault: "password" };
}

/** @param {string} link */
export async function readInvite(link) {
  return { ok: true, link, role: "member", space: "juniper", ttlDays: 7 };
}

/** @param {string} link */
export async function joinSpace(link) {
  const name = mock.spaces.some((s) => s.name === "juniper") ? "studio" : "juniper";
  const role = name === "studio" ? "admin" : "member";
  const row = { id: `spc_${name}`, name, role, server: `https://${name}.vyre.run` };
  mock.spaces = mock.spaces.filter((s) => s.id !== row.id).concat([row]);
  mock.current = row.id;
  return { ok: true, joined: true, space: name, id: row.id, role, server: row.server };
}

/** @param {any} input */
export async function openSpace(input) {
  const name = input.name || "space";
  const row = { id: `spc_${name}`, name, role: "owner", server: /** @type {string | null} */ (null) };
  mock.spaces = mock.spaces.filter((s) => s.id !== row.id).concat([row]);
  mock.current = row.id;
  return { ok: true, id: "fr_sample", spaceId: row.id, role: "owner", kind: input.kind, command: "curl -fsSL vyre.run/i | sh", expiresAt: new Date(Date.now() + 1_800_000).toISOString() };
}

/** @param {string} id */
export async function pollSpace(id) {
  return { ok: true, id, online: false, expired: false };
}

export async function listSpaces() {
  return { ok: true, person: mock.person || "alex", id: mock.id, current: mock.current, spaces: mock.spaces.slice() };
}

/** @param {string} space */
export async function chooseSpace(space) {
  const hit = mock.spaces.find((s) => s.id === space || s.name === space);
  if (!hit) return { ok: false, message: "That space is not one this identity belongs to.", code: "bad_input" };
  mock.current = hit.id;
  return { ok: true, current: hit.id, name: hit.name, role: hit.role, server: hit.server };
}

/** @param {any} input */
export async function makeInvite(input) {
  return { ok: true, link: "https://vyre.run/i/sampletoken", role: input.role, ttlDays: input.ttlDays, space: input.space || "juniper" };
}

export async function finishFirstRun() {
  return { ok: true, done: true };
}

export async function listAgentProviders() {
  return { ok: true, providers: [{ id: "claude", label: "Claude" }, { id: "codex", label: "Codex" }, { id: "grok", label: "Grok" }] };
}

/** @param {any} input */
export async function signInAgent(input) {
  return { ok: true, provider: input.provider, step: "done", signedIn: true };
}

export async function loadProgress() {
  return { ok: true, ...progress };
}

/** @param {any} input */
export async function saveProgress(input) {
  progress = { screen: input.screen, stack: input.stack };
  return { ok: true, saved: true, ...progress };
}

/** @param {any} input */
export async function signInPassword(input) {
  const name = String(input.space || "juniper");
  mock.person = String(input.username || "alex");
  mock.spaces = [{ id: `spc_${name}`, name, role: "member", server: `https://${name}.vyre.run` }];
  mock.current = mock.spaces[0].id;
  return { ok: true, username: mock.person, spaces: mock.spaces.slice() };
}

export async function signInGithub() {
  return { ok: true, login: "alexg", spaces: [{ id: "spc_juniper", name: "juniper", role: "owner" }, { id: "spc_studio", name: "studio", role: "admin" }] };
}

/** @param {string} password */
export async function unlockGithub(password) {
  mock.person = "alexg";
  mock.spaces = [{ id: "spc_juniper", name: "juniper", role: "owner", server: "https://juniper.vyre.run" }, { id: "spc_studio", name: "studio", role: "admin", server: "https://studio.vyre.run" }];
  mock.current = "spc_juniper";
  return { ok: true, unlocked: Boolean(password), spaces: mock.spaces.slice() };
}
