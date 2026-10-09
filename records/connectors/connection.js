// @ts-check
// A Connection is a connector declaration a person made themselves (team/0.3/SPEC-0.3.0.md part 4): one pinned host, one Vault credential that already exists, and the
// declaration format.js already checks. This file is the pure part: the quick form becomes a declaration, and a check's answer becomes plain words. It opens nothing and holds no secret.

import { defineConnector, toCredentialConfig, appHost } from "./format.js";

/** How the key is sent, in the words of the form, and what each is in the declaration's `auth`. */
export const SEND_HOWS = Object.freeze(["bearer", "header", "basic", "query"]);

/** @param {string} s */
export const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
const fail = (/** @type {string} */ m, code = "bad_input") => Object.assign(new Error(m), { code });
const isObj = (/** @type {any} */ v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** `{name}` in a text, filled from the person's fixed values. A name with no value is a problem, not an empty string. @param {string} text @param {Record<string, string>} vars @param {boolean} [encode] */
function fill(text, vars, encode = false) {
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, k) => {
    if (typeof vars[k] !== "string" || !vars[k] || /^\{\{.*\}\}$/.test(vars[k])) throw fail(`{${k}} has no value: add it under the fixed values`);
    return encode ? encodeURIComponent(vars[k]) : vars[k];
  });
}

/** The kind a method has when nobody said otherwise: GET and HEAD read, POST PUT PATCH change, DELETE delete. @param {string} method */
export const kindOfMethod = method => (method === "GET" || method === "HEAD" ? "read" : method === "DELETE" ? "delete" : "change");

/**
 * The operations of a form (an array of { name, method, path, kind?, label?, relabeled?, input?, output?, poll? }) as a declaration's ops and polls. A kind left out is the method's. A `poll` makes
 * the operation a watcher source: { items?, id, at?, title?, args?, every_minutes? } (a list in the answer, the item's own id and time and title, extra query for the list call).
 * @param {any} operations @returns {{ ops: Record<string, any>, poll: Record<string, any> }}
 */
export function opsFromForm(operations) {
  /** @type {Record<string, any>} */ const ops = {}, poll = {};
  if (operations === undefined) return { ops, poll };
  if (!Array.isArray(operations) || operations.length > 200) throw fail("operations: a list of at most 200");
  for (const o of operations) {
    if (!isObj(o) || typeof o.name !== "string") throw fail("an operation has a name");
    const method = String(o.method || "").toUpperCase();
    ops[o.name] = { method, path: o.path, kind: o.kind === undefined ? kindOfMethod(method) : o.kind, ...(o.label ? { label: String(o.label) } : {}), ...(o.relabeled === true ? { relabeled: true } : {}),
      ...(o.input ? { input: o.input } : {}), ...(o.output ? { output: o.output } : {}) };
    if (o.poll !== undefined) {
      const p = o.poll;
      if (!isObj(p) || typeof p.id !== "string") throw fail(`operation ${o.name}: poll is { id (the item's own id), items?, at?, title?, args?, every_minutes? }`);
      // what a poll asks of its list call must be something the call takes: a name it did not declare is declared here as text
      for (const part of ["query", "params"]) for (const k of Object.keys((p.args && p.args[part]) || {})) {
        const inp = (ops[o.name].input = ops[o.name].input || {});
        inp[part] = inp[part] || {};
        if (!inp[part][k]) inp[part][k] = { type: "string" };
      }
      poll[o.name] = { op: o.name, id: p.id, ...(p.items ? { items: String(p.items) } : {}), ...(p.args ? { args: p.args } : {}), ...(p.every_minutes ? { every_minutes: p.every_minutes } : {}),
        label: String(o.label || o.name), map: { ...(p.title ? { title: String(p.title) } : {}), ...(p.at ? { at: String(p.at) } : {}) } };
    }
  }
  return { ops, poll };
}

/** The declared operations of a declaration as the list the record shows (the check request is the record's own, not listed). @param {import("./format.js").Declaration} d */
export function operationsOf(d) {
  return Object.entries(d.ops).filter(([n]) => n !== "check").map(([name, op]) => ({ name, method: op.method, path: op.path, kind: op.kind, ...(op.label ? { label: op.label } : {}),
    ...(op.relabeled ? { relabeled: true } : {}), ...(op.input ? { input: op.input } : {}), ...(op.output ? { output: op.output } : {}),
    ...(d.poll && d.poll[name] ? { poll: { id: d.poll[name].id, ...(d.poll[name].items ? { items: d.poll[name].items } : {}), ...(d.poll[name].map?.title ? { title: d.poll[name].map.title } : {}),
      ...(d.poll[name].map?.at ? { at: d.poll[name].map.at } : {}), ...(d.poll[name].args ? { args: d.poll[name].args } : {}), ...(d.poll[name].every_minutes ? { every_minutes: d.poll[name].every_minutes } : {}) } } : {}) }));
}

/**
 * The quick form as a declaration. The one check request becomes a read op named `check`; the generic request (any method and path on the pinned host) needs no op at all.
 * @param {{ label: string, id?: string, base_url?: string, app?: string, send: { how: string, name?: string }, credential: { item: string, field?: string }, headers?: Record<string, string>,
 *   vars?: Record<string, string>, check: { path: string }, operations?: any[] }} form
 * @returns {{ id: string, declaration: import("./format.js").Declaration, credential: { item: string, field?: string }, check: { method: "GET", path: string } }}
 */
export function fromForm(form) {
  if (!isObj(form)) throw fail("the form is an object");
  const label = String(form.label || "").trim();
  const id = form.id ? String(form.id) : slug(label);
  const how = form.send && form.send.how;
  if (!SEND_HOWS.includes(how)) throw fail(`send.how: ${SEND_HOWS.join(", ")} (OAuth client credentials is not available yet)`);
  const name = form.send.name ? String(form.send.name) : "";
  if ((how === "header" || how === "query") && !name) throw fail(`send.name: the ${how === "header" ? "header" : "query parameter"} the key goes in`);
  const auth = how === "bearer" ? { type: "bearer" } : how === "basic" ? { type: "basic" } : how === "header" ? { type: "api-key", header: name } : { type: "api-key", in: "query", param: name };
  const cred = form.credential;
  if (!isObj(cred) || typeof cred.item !== "string" || !cred.item) throw fail("credential.item: the Vault item that holds the key");
  const vars = isObj(form.vars) ? /** @type {Record<string, string>} */ (form.vars) : {};
  const headers = isObj(form.headers) ? Object.fromEntries(Object.entries(form.headers).map(([k, v]) => [k, fill(String(v), vars)])) : {};
  const chk = form.check;
  if (!isObj(chk) || typeof chk.path !== "string" || !chk.path.startsWith("/")) throw fail("check.path: the path of one request that proves the key works, such as /locations/{locationId}");
  if (/[?#]/.test(chk.path)) throw fail("check.path: the path only; the check is a plain GET");
  const path = fill(chk.path, vars, true);
  const { ops, poll } = opsFromForm(form.operations);
  if (Object.hasOwn(ops, "check")) throw fail("operations: `check` is the connection's own check request");
  if (form.app !== undefined && form.base_url) throw fail("an app's connection has an app, not an address");
  if (form.app !== undefined && Object.keys(poll).length) throw fail("a poll is not available for an app's connection yet");
  const declaration = defineConnector({
    id, label, version: 1, ...(form.app !== undefined ? { app: form.app } : { base_url: String(form.base_url || "").replace(/\/+$/, "") }), auth,
    ...(Object.keys(headers).length ? { headers } : {}),
    // the check is one of the declared operations when it names the same call; the format does not take one call twice
    ops: { ...(Object.values(ops).some(o => o.method === "GET" && o.path === path) ? {} : { check: { method: "GET", path, kind: "read", label: "Check the connection" } }), ...ops },
    ...(Object.keys(poll).length ? { poll } : {}),
  });
  return { id, declaration, credential: { item: cred.item, ...(cred.field ? { field: String(cred.field) } : {}) }, check: { method: "GET", path } };
}

/**
 * The vault api-credential config a Connection compiles to. The credential reads the key from the person's own Vault item; this module (and only for the check's path, read only) is
 * its one reader, so the check can run without any model or agent holding a way in.
 * @param {{ declaration: import("./format.js").Declaration, credential: { item: string, field?: string }, check: { path: string } }} c
 */
export function toConfig(c) {
  const base = toCredentialConfig(c.declaration, { item: c.credential.item, ...(c.credential.field ? { field: c.credential.field } : {}) });
  // The generic `request` (any method and path on the pinned host) is what the declared operations sit on top of: the declared ones come first, so the first match decides, and anything they do not
  // name is classified by its method (GET and HEAD read, POST PUT PATCH send, DELETE delete), which the vault holds for a yes. Flows reach the same by the allow rule at the end.
  const generic = [{ method: "GET", path: "/*", kind: "read" }, { method: "HEAD", path: "/*", kind: "read" }, { method: "POST", path: "/*", kind: "send" }, { method: "PUT", path: "/*", kind: "send" },
    { method: "PATCH", path: "/*", kind: "send" }, { method: "DELETE", path: "/*", kind: "delete" }];
  return { ...base, operations: JSON.parse(JSON.stringify(c.declaration.ops)), endpoints: [...base.endpoints, ...generic], service: { ...base.service, allow: [...base.service.allow, { path: "/*" }] },
    readers: [{ module: "connectors", paths: [c.check.path] }] };
}

/** The Vault item a Connection compiles to. @param {string} id */
export const credentialName = id => `conn-${id}`;

/**
 * What a check's answer means, in plain words. `reply` is the vault.request answer ({status}); `error` is what it threw. Green only for a 2xx.
 * @param {{ reply?: { status?: number } | null, error?: { code?: string, message?: string } | null }} r
 * @returns {{ light: "green" | "red", words: string }}
 */
export function outcomeOf({ reply, error }) {
  if (error) {
    const m = String(error.message || ""), c = String(error.code || "");
    if (/app is not running|apps are not running/i.test(m)) return { light: "red", words: "the app is not running" };
    if (/timed? ?out|ETIMEDOUT|ESOCKETTIMEDOUT|no answer/i.test(m)) return { light: "red", words: "no answer from the host (timeout)" };
    if (/ENOTFOUND|EAI_AGAIN|does not resolve|could not resolve/i.test(m)) return { light: "red", words: "that address does not resolve" };
    if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(m)) return { light: "red", words: "the host refused the connection" };
    if (c === "config" || /no secret|has no |which is not there|line break/i.test(m)) return { light: "red", words: `the key could not be read from the Vault: ${m.slice(0, 160)}` };
    return { light: "red", words: `the check could not run: ${m.slice(0, 160)}` };
  }
  const s = Number(reply && reply.status);
  if (s >= 200 && s < 300) return { light: "green", words: "connected" };
  if (s === 401) return { light: "red", words: "the key was refused (401)" };
  if (s === 403) return { light: "red", words: "the key is not allowed to do that (403)" };
  if (s === 404) return { light: "red", words: "that id was not found (404)" };
  if (s === 429) return { light: "red", words: "the service says to slow down (429)" };
  if (s >= 500) return { light: "red", words: `the service is having trouble (${s})` };
  if (s >= 300 && s < 400) return { light: "red", words: `the service sent the check somewhere else (${s})` };
  return { light: "red", words: `the service answered ${Number.isFinite(s) && s ? s : "nothing usable"}` };
}

/**
 * The plain-words card for a proposed Connection: what it would reach, how the key is sent, and what each operation may do. Built from the checked form, never from the proposer's own words.
 * @param {ReturnType<typeof fromForm>} made @param {string} item
 */
export function cardOf(made, item) {
  const d = made.declaration, a = d.auth;
  const where = d.app ? `the ${d.app} app on this machine` : new URL(/** @type {string} */ (d.base_url)).hostname;
  const how = a.type === "bearer" ? "as a bearer token" : a.type === "basic" ? "as a username and password" : a.in === "query" ? `in the address, as ${a.param}` : `in the ${a.header || "x-api-key"} header`;
  const kindWords = /** @type {Record<string, string>} */ ({ read: "reads", draft: "prepares a draft in", change: "changes things in", send: "sends from", spend: "spends money at", delete: "deletes in" });
  return {
    title: `Connect ${d.label}?`,
    reaches: where,
    lines: [
      `It can reach ${where} and nothing else.`,
      `It uses the key in your Vault item ${item}, sent ${how}. The key is never shown to the assistant.`,
      `Any call to it that is not a plain read waits for your yes.`,
      ...Object.entries(d.ops).filter(([n]) => n !== "check").map(([n, o]) => `${n}: ${kindWords[o.kind] || o.kind} ${where} (${o.method} ${o.path})`),
    ],
  };
}
