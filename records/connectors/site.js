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
 * @param {{ id: string, label: string, origin: string, entries: { name: string, kind: string, op: any }[] }} i
 */
export function siteDeclaration({ id, label, origin, entries }) {
  /** @type {Record<string, any>} */ const ops = {};
  for (const e of entries) {
    const shapes = Object.fromEntries(e.op.params.map((/** @type {any} */ p) => [p.name, { type: shapeType(p.type), ...(p.required !== false ? { required: true } : {}) }]));
    const read = e.kind === "read";
    ops[opKey(e.name)] = { method: read ? "GET" : "POST", path: opPath(e.name), kind: e.kind, label: e.op.description || e.name, site: { name: e.name },
      ...(Object.keys(shapes).length ? { input: read ? { query: shapes } : { body: shapes, encoding: "json" } } : {}) };
  }
  return defineConnector({ id, label, version: 1, transport: "site", base_url: String(origin).replace(/\/+$/, ""), auth: { type: "browser" }, ops });
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
