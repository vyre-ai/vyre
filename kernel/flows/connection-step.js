// @ts-check
// "Call a service" for a Connection: a step names { connection, operation, input } and this turns it into the one service step the runner already runs (connector conn-<id>, method, path, query,
// headers, body), once, when the Flow is defined. What is stored and approved is the written-out step, so the destination of an outward call is constant and the approval card shows it; the
// Connection and the operation stay on the step for the person who reads the canvas. There is no second step kind and no second runner path: the Gate, the ledger, the idempotency key and the
// read-back are the service step's own (team/0.3/IFACE-connection.md, interface 2).
//
// Rules of the expansion:
//  - a declared operation fills its path from input.params, which must be written out (a constant); query, headers and body may be values or expressions, as in any service step.
//  - `request` is the generic operation: input.method and input.path are written out; the rest as above.
//  - input a declared operation does not name is refused, so a typo is an error at define time, not a silently dropped field.

/** @param {any} v */
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
/** Is this value a constant, with no expression in it? An expression is an object with an `expr` key, as compile.js reads it. @param {any} v @returns {boolean} */
const isConst = v => (v === null || typeof v !== "object" ? true : Array.isArray(v) ? v.every(isConst) : Object.hasOwn(v, "expr") ? false : Object.values(v).every(isConst));

/**
 * Expand every connection step of a Flow (also inside `repeat` and `decide` branches). Returns the Flow with those steps written out, and the problems found.
 * @param {any} flow @param {{ connectors?: Record<string, any> }} cat
 * @returns {{ flow: any, errors: { path: string, message: string }[] }}
 */
export function expandConnections(flow, cat) {
  /** @type {{ path: string, message: string }[]} */ const errors = [];
  /** @param {any[]} steps @param {string} base */
  const walk = (steps, base) => (Array.isArray(steps) ? steps.map((s, i) => {
    const p = `${base}[${i}]`;
    if (!isObj(s)) return s;
    let out = s;
    if (s.kind === "service" && s.connection !== undefined && s.connector === undefined) out = expandOne(s, p);
    if (Array.isArray(out.steps)) out = { ...out, steps: walk(out.steps, `${p}.steps`) };
    if (Array.isArray(out.then)) out = { ...out, then: walk(out.then, `${p}.then`) };
    if (Array.isArray(out.else)) out = { ...out, else: walk(out.else, `${p}.else`) };
    if (isObj(out.on_fail) && Array.isArray(out.on_fail.steps)) out = { ...out, on_fail: { ...out.on_fail, steps: walk(out.on_fail.steps, `${p}.on_fail.steps`) } };
    return out;
  }) : steps);
  /** @param {any} s @param {string} p */
  function expandOne(s, p) {
    const name = `conn-${s.connection}`;
    const conn = cat && cat.connectors && cat.connectors[name];
    if (!conn || !isObj(conn.operations)) { errors.push({ path: `${p}.connection`, message: `there is no Connection ${s.connection}: connect the app first` }); return s; }
    const op = String(s.operation || "");
    const input = isObj(s.input) ? s.input : {};
    const { connection, operation, input: _drop, ...rest } = s;
    /** @type {any} */ let step;
    if (op === "request") {
      for (const k of Object.keys(input)) if (!["method", "path", "query", "headers", "body"].includes(k)) errors.push({ path: `${p}.input.${k}`, message: "the generic request takes method, path, query, headers and body" });
      const method = String(input.method || "GET").toUpperCase();
      if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) errors.push({ path: `${p}.input.method`, message: "method is GET, HEAD, POST, PUT, PATCH or DELETE" });
      if (typeof input.path !== "string" || !/^\/[^\s?#]*$/.test(input.path)) errors.push({ path: `${p}.input.path`, message: "the path starts with / and is written out (the query goes in `query`)" });
      step = { ...rest, connector: name, method, path: String(input.path || "/"), ...pick(input, ["query", "headers", "body"]) };
    } else {
      const def = Object.hasOwn(conn.operations, op) ? conn.operations[op] : null;
      if (!def) { errors.push({ path: `${p}.operation`, message: `${s.connection} has no operation ${op || "(none)"}: it has ${Object.keys(conn.operations).slice(0, 12).join(", ") || "none declared"}, and request` }); return s; }
      const shapes = def.input || {};
      for (const part of ["params", "query", "headers", "body"]) {
        if (input[part] === undefined) continue;
        if (!isObj(input[part])) { errors.push({ path: `${p}.input.${part}`, message: `${part} is an object of names and values` }); continue; }
        for (const k of Object.keys(input[part])) if (!shapes[part] || !Object.hasOwn(shapes[part], k)) errors.push({ path: `${p}.input.${part}.${k}`, message: `${op} does not take ${k} in ${part}` });
      }
      for (const k of Object.keys(input)) if (!["params", "query", "headers", "body"].includes(k)) errors.push({ path: `${p}.input.${k}`, message: "input is { params, query, headers, body }" });
      for (const part of ["params", "query", "headers", "body"]) for (const [k, sh] of Object.entries(shapes[part] || {})) if (/** @type {any} */ (sh).required && !(isObj(input[part]) && input[part][k] !== undefined)) errors.push({ path: `${p}.input.${part}.${k}`, message: `${op} needs ${k} in ${part}` });
      const params = isObj(input.params) ? input.params : {};
      const path = String(def.path).replace(/\{([a-z_][a-z0-9_]*)\}/gi, (_m, k) => {
        if (!isConst(params[k]) || typeof params[k] === "object") { errors.push({ path: `${p}.input.params.${k}`, message: `${k} is written out: the address of an outward call is constant` }); return k; }
        return encodeURIComponent(String(params[k]));
      });
      step = { ...rest, connector: name, method: def.method, path, ...pick(input, ["query", "headers", "body"]) };
    }
    return { ...step, connection: String(connection), operation: op };
  }
  const steps = walk(flow && flow.steps, "steps");
  const onFailure = flow && Array.isArray(flow.on_failure) ? walk(flow.on_failure, "on_failure") : undefined;
  return { flow: errors.length ? flow : { ...flow, steps, ...(onFailure ? { on_failure: onFailure } : {}) }, errors };
}

/** @param {any} o @param {string[]} keys */
function pick(o, keys) { /** @type {any} */ const out = {}; for (const k of keys) if (o[k] !== undefined) out[k] = o[k]; return out; }
