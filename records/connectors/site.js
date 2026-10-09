// @ts-check
// A site Connection: a website signed in through a browser, whose operations were learned from its own page (lib/siteops, team/0.3.1/DESIGN-site-operations.md). It is the same Connection as any
// other for Flows, watchers, agents and the Gate: it has a host, operations with a kind, and a light. What differs is where a call goes: not over HTTP with a key, but into a browser that is
// signed in, which signs it. The login never reaches Vyre; the Connection holds only the names and shapes of what was learned.
//
// This file is the pure half: the learned operations of a site record become a declaration the existing checker accepts, with each operation given a VIRTUAL address (GET for a read, POST
// for the rest, under /ops/<name>) so that the rules a Flow is checked against, the Gate's classes and the approval binding all work unchanged.

import { defineConnector, toCredentialConfig, kindsOutward } from "./format.js";

/** A learned operation's name (camelCase) as a declaration's op name (words joined by dots, lowercase). searchPeople -> search_people. @param {string} name */
export const opKey = name => String(name).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** The address the Connection gives a learned operation. @param {string} name */
export const opPath = name => `/ops/${opKey(name)}`;

/** The shape type of an input. @param {string} t */
const shapeType = t => (t === "number" || t === "boolean" || t === "object" || t === "array" ? t : "string");

/**
 * The declaration of a site Connection from the operations a site record holds. `entries` are the record's `ops` items ({ name, kind, op }); the Connection's address is the site's origin.
 * A read takes its inputs in the query (a GET); every other kind takes them in the body (a POST). Inputs keep their names and types, so a Flow's step is checked against them.
 * `polls` makes a read a watcher's source: { name, operation (the learned name), id (the path of an item's own id), items? (the list in the answer), title?, at?, args? ({ query }), every_minutes? }.
 * A watcher then polls the website like any Connection's read, and files each new item for a Flow.
 * @param {{ id: string, label: string, origin: string, entries: { name: string, kind: string, op: any }[], polls?: any[] }} i
 */
export function siteDeclaration({ id, label, origin, entries, polls }) {
  /** @type {Record<string, any>} */ const ops = {};
  for (const e of entries) {
    const shapes = Object.fromEntries(e.op.params.map((/** @type {any} */ p) => [p.name, { type: shapeType(p.type), ...(p.required !== false ? { required: true } : {}) }]));
    const read = e.kind === "read";
    ops[opKey(e.name)] = { method: read ? "GET" : "POST", path: opPath(e.name), kind: e.kind, label: e.op.description || e.name, site: { name: e.name },
      ...(Object.keys(shapes).length ? { input: read ? { query: shapes } : { body: shapes, encoding: "json" } } : {}) };
  }
  /** @type {Record<string, any>} */ const poll = {};
  for (const p of Array.isArray(polls) ? polls : []) {
    if (!p || typeof p.name !== "string" || typeof p.operation !== "string" || typeof p.id !== "string") throw Object.assign(new Error("a poll is { name, operation, id (the path of an item's own id), items?, title?, at?, args?, every_minutes? }"), { code: "bad_input" });
    poll[p.name] = { op: opKey(p.operation), id: p.id, ...(p.items ? { items: String(p.items) } : {}), ...(p.args ? { args: p.args } : {}), ...(p.every_minutes ? { every_minutes: p.every_minutes } : {}), label: String(p.label || p.name),
      map: { ...(p.title ? { title: String(p.title) } : {}), ...(p.at ? { at: String(p.at) } : {}) } };
  }
  return defineConnector({ id, label, version: 1, transport: "site", base_url: String(origin).replace(/\/+$/, ""), auth: { type: "browser" }, ops, ...(Object.keys(poll).length ? { poll } : {}) });
}

/** The polls of a declaration, in the form siteDeclaration takes, so a sync keeps them. @param {import("./format.js").Declaration} d */
export function pollsOf(d) {
  return Object.entries(d.poll || {}).map(([name, p]) => ({ name, operation: (d.ops[p.op] && d.ops[p.op].site && d.ops[p.op].site.name) || p.op, id: typeof p.id === "string" ? p.id : "", ...(p.items ? { items: p.items } : {}), ...(p.args ? { args: p.args } : {}),
    ...(p.every_minutes ? { every_minutes: p.every_minutes } : {}), ...(p.label ? { label: p.label } : {}), ...(p.map && p.map.title ? { title: p.map.title } : {}), ...(p.map && p.map.at ? { at: p.map.at } : {}) }));
}

/**
 * The vault api-credential config a site Connection compiles to. The credential holds the host and the route rules a Flow is checked against, and no key: nothing outside the declared
 * operations is allowed (there is no generic request on a browser's login), and the vault never makes a request with it (core/vault/request.js hands the call to the browser).
 * @param {import("./format.js").Declaration} d
 */
export function siteConfig(d) {
  const base = toCredentialConfig(d);
  return { ...base, operations: JSON.parse(JSON.stringify(d.ops)) };
}

/**
 * A call to a site Connection's virtual address, back to the learned operation and its inputs. A read's inputs are in the query, any other kind's in the body.
 * @param {import("./format.js").Declaration} d @param {{ method: string, path: string, query?: any, body?: any }} r
 * @returns {{ name: string, kind: string, inputs: Record<string, any> } | null}
 */
export function operationOf(d, r) {
  const method = String(r.method || "GET").toUpperCase();
  for (const o of Object.values(d.ops)) {
    if (o.method !== method || o.path !== r.path || !o.site) continue;
    const src = method === "GET" || method === "HEAD" ? r.query : r.body;
    let inputs = src;
    if (typeof inputs === "string") { try { inputs = JSON.parse(inputs); } catch { inputs = {}; } }
    return { name: o.site.name, kind: o.kind, inputs: inputs && typeof inputs === "object" && !Array.isArray(inputs) ? inputs : {} };
  }
  return null;
}

/** Whether a kind leaves the machine (what the Gate holds). @param {string} kind */
export const isOutwardKind = kind => kindsOutward().includes(kind);

/**
 * The plain-words card for a proposed website Connection: what it would reach and what each operation may do. Built from the learned operations, never from the proposer's own words.
 * @param {{ label: string, origin: string, entries: { name: string, kind: string, op: any }[] }} p
 */
export function siteCardOf({ label, origin, entries }) {
  const host = new URL(origin).hostname;
  const kindWords = /** @type {Record<string, string>} */ ({ read: "reads", draft: "prepares a draft on", change: "changes things on", send: "sends from", spend: "spends money on", delete: "deletes on" });
  return {
    title: `Connect ${label}?`,
    reaches: host,
    lines: [
      `It can reach ${host} and nothing else, through your own signed-in browser.`,
      "Your login stays in the browser: Vyre never holds it.",
      "Any call that is not a plain read waits for your yes.",
      ...entries.map(e => `${e.name}(${e.op.params.map((/** @type {any} */ p) => p.name).join(", ")}): ${kindWords[e.kind] || e.kind} ${host}`),
    ],
  };
}
