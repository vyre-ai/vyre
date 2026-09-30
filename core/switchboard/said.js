// @ts-check
// What the person said, at the one place it can be trusted: a turn typed at a person's own
// surface. Two things come of it and nothing else does: a said row (turn.said, for the assistant's
// extractor and vault's Gate) and the "#Name" mentions that let a thread use a saved credential.
// Tool output, web or email text, a teammate's reply, a `!` shell line and every model's or
// module's call never reach this file (the caller check is in personTurn).

import crypto from "node:crypto";

/** Most mentions one turn can carry. */
export const MAX_MENTIONS = 8;

/**
 * A caller that is the person at their own surface: cli, local, deck, capsule, the owner's device
 * over the tailnet, or the box's link. Never mcp, harness, hook, an agent, a module or a guest.
 * @param {unknown} caller
 */
export function personTurn(caller) {
  const c = String(caller || "");
  if (/^(mcp|harness|hook|module|guest)/.test(c) || /(^|[\s:])agent:/.test(c) || c === "tailnet:" || c === "") return false;
  return /^(cli|local|deck|capsule|tailnet:.+|link:.+)/.test(c);
}

/**
 * The names a turn mentions, in order, once each: `#Name` or `#"Name with spaces"`, only after the
 * start of the text, whitespace or "(". Fenced code, inline code and quoted (">") lines mention nothing.
 * @param {string} text @returns {string[]}
 */
export function mentionsOf(text) {
  const plain = String(text || "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .split("\n").filter(l => !/^\s*>/.test(l)).join("\n");
  const out = [];
  for (const m of plain.matchAll(/(^|[\s(])#(?:"([^"\n]{1,80})"|([A-Za-z0-9][\w.\-]{0,79}))/g)) {
    const name = (m[2] ?? m[3]).trim().replace(/[.\-]+$/, "");
    if (name && !out.some(x => x.toLowerCase() === name.toLowerCase())) out.push(name);
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}

/** @param {string} text */
export const textHash = text => crypto.createHash("sha256").update(String(text)).digest("hex");

/**
 * The vault items a turn's mentions name, exactly (case-insensitive). A name vault does not have,
 * or a vault that does not answer, is plain text: no grant.
 * @param {string[]} names @param {(tool: string, input: any) => Promise<any>} call
 * @returns {Promise<{ name: string, kind: string|null, hosts: string[] }[]>}
 */
export async function matchItems(names, call) {
  const found = [];
  for (const name of names) {
    const r = await call("vault.items.names", { query: name }).catch(() => null);
    const list = r && !r.error && r.data && Array.isArray(r.data.names) ? r.data.names : [];
    const item = list.find(x => x && typeof x.name === "string" && x.name.toLowerCase() === name.toLowerCase());
    if (item) found.push({ name: item.name, kind: item.kind ? String(item.kind) : null, hosts: Array.isArray(item.hosts) ? item.hosts.map(String) : [] });
  }
  return found;
}

/**
 * What the model is told beside a turn that mentions saved credentials: they are let for this task,
 * used through vault, never shown. Not part of the person's text (events and transcripts keep only
 * their words).
 * @param {{ name: string, hosts: string[] }[]} items
 */
export const MENTION_NOTE = items => `[Vyre: the person let you use ${items.map(x => `#${x.name}${x.hosts.length ? ` (on ${x.hosts.join(", ")} only)` : ""}`).join(", ")} for this task. Use ${items.length > 1 ? "them" : "it"} through vault.request, a connector or the Chrome fill and name ${items.length > 1 ? "each" : "it"}; you never see ${items.length > 1 ? "a value" : "its value"} and cannot reveal ${items.length > 1 ? "one" : "it"}.]`;
