// @ts-check
// The small mapping a connector declaration uses to turn what a service answers into what Vyre files: a path into the JSON, a few named transforms, and a fixed shape for the
// people on a message. It is data in, data out, with no I/O, so the same code runs in a Flow's host and, copied by source, inside a poll watcher's sandbox (`MAPPER_SOURCE`).
//
//   path       "id", "data.items[0].name", "payload.headers[name=Subject].value" (a [key=value] picks the list entry whose key matches, case-blind)
//   transform  "internalDate|iso", "payload.headers[name=From].value|address": a path then pipes; some take an argument after a colon ("truncate:300")
//   a field    a string (path and pipes; "a ?? b" takes the first that has a value), { const: v }, { template: "gmail:{$mailbox}:{id}" }, { people: [ { path, how } ] }, or { direction: { from: path, mine: "$mailbox" } }
//   `$name`    a variable the poller was given (the mailbox address, the calendar id), never a value from the service

/** One factory, so its source can be handed to a sandbox: no imports and no outside names. */
export function makeMapper() {
  const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
  /** @param {any} obj @param {string} path */
  function get(obj, path) {
    let cur = obj;
    const parts = String(path).match(/[^.[\]]+(?:\[[^\]]*\])*|\[[^\]]*\]/g) || [];
    for (const part of parts) {
      const m = /^([^[]*)((?:\[[^\]]*\])*)$/.exec(part);
      if (!m) return undefined;
      if (m[1]) { if (FORBIDDEN.has(m[1]) || cur === null || typeof cur !== "object") return undefined; cur = cur[m[1]]; }
      for (const b of (m[2].match(/\[[^\]]*\]/g) || [])) {
        const inner = b.slice(1, -1);
        if (cur === null || typeof cur !== "object") return undefined;
        if (/^\d+$/.test(inner)) { cur = Array.isArray(cur) ? cur[Number(inner)] : undefined; continue; }
        const eq = inner.indexOf("=");
        if (eq < 1 || !Array.isArray(cur)) return undefined;
        const k = inner.slice(0, eq), v = inner.slice(eq + 1).toLowerCase();
        cur = cur.find(x => x && typeof x === "object" && !FORBIDDEN.has(k) && String(x[k] ?? "").toLowerCase() === v);
      }
      if (cur === undefined) return undefined;
    }
    return cur;
  }
  /** Every address in a header-like string ("Jane <Jane@x.test>, bob@y.test"), lower case, in order, once each. @param {any} v @returns {string[]} */
  function addresses(v) {
    const list = Array.isArray(v) ? v : [v];
    const out = [];
    for (const item of list) {
      const s = typeof item === "string" ? item : item && typeof item === "object" ? String(item.email ?? item.address ?? "") : "";
      for (const m of s.matchAll(/[A-Za-z0-9._%+'=-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g)) { const a = m[0].toLowerCase(); if (!out.includes(a)) out.push(a); }
    }
    return out;
  }
  /** @param {any} v @param {string} t */
  function transform(v, t) {
    const [name, arg] = [t.split(":")[0], t.includes(":") ? t.slice(t.indexOf(":") + 1) : undefined];
    switch (name) {
      case "address": return addresses(v)[0];
      case "addresses": return addresses(v);
      case "iso": { if (v === undefined || v === null || v === "") return undefined; const n = typeof v === "number" || /^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v)); if (!Number.isFinite(n)) return undefined; const ms = n < 1e12 ? n * 1000 : n; return new Date(ms).toISOString(); }
      case "lower": return v === undefined ? v : String(v).toLowerCase();
      case "trim": return v === undefined ? v : String(v).trim();
      case "truncate": return v === undefined ? v : String(v).slice(0, Math.max(0, Number(arg) || 0));
      case "string": return v === undefined || v === null ? undefined : String(v);
      case "first": return Array.isArray(v) ? v[0] : v;
      case "count": return Array.isArray(v) ? v.length : undefined;
      default: throw new Error(`no transform ${name}`);
    }
  }
  /** @param {any} raw @param {string} spec @param {Record<string, any>} vars */
  function evalPath(raw, spec, vars) {
    // "a ?? b|iso": the first path that has a value, then the pipes
    const [alts, ...pipes] = String(spec).split("|");
    let v;
    for (const alt of alts.split(" ?? ")) {
      const path = alt.trim();
      v = path.startsWith("$") ? vars[path.slice(1)] : get(raw, path);
      if (v !== undefined && v !== null && v !== "") break;
    }
    for (const p of pipes) v = transform(v, p.trim());
    return v === "" ? undefined : v;
  }
  /** One field's value. @param {any} raw @param {any} f @param {Record<string, any>} vars */
  function field(raw, f, vars) {
    if (typeof f === "string") return evalPath(raw, f, vars);
    if (f && typeof f === "object" && "const" in f) return f.const;
    if (f && typeof f === "object" && typeof f.template === "string") {
      let missing = false;
      const t = f.template.replace(/\{([^}]+)\}/g, (/** @type {string} */ _m, /** @type {string} */ p) => { const v = evalPath(raw, p, vars); if (v === undefined || v === null) missing = true; return String(v); });
      return missing ? undefined : t;
    }
    if (f && typeof f === "object" && Array.isArray(f.people)) {
      const out = [];
      for (const p of f.people) for (const a of addresses(evalPath(raw, p.path, vars))) if (!out.some(x => x.address === a && x.how === p.how)) out.push({ address: a, how: p.how });
      return out;
    }
    if (f && typeof f === "object" && f.direction) {
      const from = addresses(evalPath(raw, f.direction.from, vars))[0], mine = String(f.direction.mine && f.direction.mine.startsWith("$") ? vars[f.direction.mine.slice(1)] : f.direction.mine || "").toLowerCase();
      return from && mine && from === mine ? "outbound" : "inbound";
    }
    throw new Error("a mapped field is a path string, { const }, { template }, { people } or { direction }");
  }
  /** The mapped item: only fields that came out defined. @param {any} raw @param {Record<string, any>} map @param {Record<string, any>} [vars] */
  function mapItem(raw, map, vars = {}) {
    const out = {};
    for (const [k, f] of Object.entries(map)) { if (FORBIDDEN.has(k)) continue; const v = field(raw, f, vars); if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0 && k !== "people")) out[k] = v; }
    // who was on it, as written: the addresses of each role, comma separated (the Communication's from, to, cc, bcc, organizer and attendees); `people` stays for matching them to contacts
    if (Array.isArray(out.people)) {
      const FIELD = { from: "from", to: "to", cc: "cc", bcc: "bcc", organizer: "organizer", attendee: "attendees" };
      for (const p of out.people) { const k = FIELD[p.how]; if (k && !(k in map)) out[k] = out[k] ? out[k] + ", " + p.address : p.address; }
    }
    return out;
  }
  return { get, addresses, transform, mapItem, field };
}

const m = makeMapper();
export const { get, addresses, transform, mapItem, field } = m;
/** The source of the mapper, for a sandboxed watcher to define as `const M = ...`. */
export const MAPPER_SOURCE = `(${makeMapper.toString()})()`;
