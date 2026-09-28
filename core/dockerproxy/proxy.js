// @ts-check
// dockerproxy: the box's Docker API for agents' computers, and nothing else (spec 7.9, ADR 0009).
//
// Whoever holds the Docker socket is root on the box, so vyred never does: it talks to this, on
// an internal network, and this alone holds the socket. An endpoint filter is not enough (a
// create body can ask for Privileged, a docker.sock bind, host PID), so this reads every body,
// checks it against core/computers/driver/policy.js, and forwards its own re-serialisation of
// what it checked, never the caller's bytes.
//
// HOTFIX (see docs/work/computers.md and the incident it closes): the internal network this
// listens on is not a strong enough boundary on its own -- a session's sandbox can share it (a
// spawner that runs sessions in the same netns as vyred, for one). Every request needs
// `Authorization: Bearer <token>`, checked in constant time, matching a secret only vyred's own
// uid can read (0400, in vyred's home, never in this process's Env or argv, which `docker inspect`
// or `/proc/<pid>/environ` can both expose to anything sharing the container's namespaces). A
// proxy started with no `bearer` refuses every request outright -- there is no unauthenticated
// mode -- except for a caller that opts in by name for a test double.
//
// Every decision about a container rests on labels the Engine itself returns: a per-container op
// first inspects the container, exec start first inspects the exec and then its container, and a
// create that reuses an existing volume first inspects that volume. Nothing the request says about
// labels is believed, except in the create body, which policy.allowCreate pins to the box's config.
//
// The endpoints (optionally behind /v1.NN), everything else 403:
//   GET    /containers/json                 list, label filter forced, rows filtered again
//   POST   /containers/create?name=         allowCreate, name pinned, existing volume checked
//   GET    /containers/{id}/json            inspect      \
//   POST   /containers/{id}/start|stop|pause|unpause      > the Engine's labels are a computer's
//   DELETE /containers/{id}?v=&force=       remove       /
//   POST   /containers/{id}/exec            exec create, never privileged, never another user
//   POST   /exec/{id}/start                 exec start, checked through the exec's own container
//   GET    /volumes/{name}                  volume inspect, the volume's labels are a computer's
// No Upgrade: docker.js never attaches, so a hijacked stdin stream is refused outright.

import http from "node:http";
import crypto from "node:crypto";

const MAX_BODY = 256 * 1024;
// A list of every computer on the box; far more than any real one, and bounded all the same.
const MAX_LIST = 16 * 1024 * 1024;
const NAME = "[A-Za-z0-9][A-Za-z0-9_.-]{0,127}";
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length"]);

/**
 * method, path pattern, route name, the query keys it may carry, and whether it takes a body.
 * @type {Array<[string, RegExp, string, string[], boolean]>}
 */
const ROUTES = [
  ["GET", /^\/containers\/json$/, "list", ["all", "filters", "limit", "size"], false],
  ["POST", /^\/containers\/create$/, "create", ["name"], true],
  ["GET", new RegExp(`^/containers/(${NAME})/json$`), "inspect", ["size"], false],
  ["POST", new RegExp(`^/containers/(${NAME})/(start|pause|unpause)$`), "op", [], false],
  ["POST", new RegExp(`^/containers/(${NAME})/(stop)$`), "op", ["t"], false],
  ["DELETE", new RegExp(`^/containers/(${NAME})$`), "remove", ["v", "force"], false],
  ["POST", new RegExp(`^/containers/(${NAME})/exec$`), "exec", [], true],
  ["POST", new RegExp(`^/exec/(${NAME})/start$`), "execStart", [], true],
  ["GET", new RegExp(`^/volumes/(${NAME})$`), "volume", [], false],
];

class Refusal extends Error {
  /** @param {number} status @param {string} why */
  constructor(status, why) { super(why); this.status = status; }
}
const refuse = (why, status = 403) => { throw new Refusal(status, why); };

/**
 * The first key repeated within one object of an already-valid JSON text, or null. JSON.parse keeps
 * the last of two equal keys, and the Engine's Go decoder may not agree on which one counts.
 * @param {string} text
 * @returns {string|null}
 */
export function duplicateKey(text) {
  /** @type {Array<Set<string>|null>} */
  const stack = [];
  let prev = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && (prev === "{" || prev === ",")) {
        const key = JSON.parse(text.slice(i, j + 1));
        if (top.has(key)) return key;
        top.add(key);
      }
      prev = '"';
      i = j;
    } else if (c === "{") { stack.push(new Set()); prev = c; }
    else if (c === "[") { stack.push(null); prev = c; }
    else if (c === "}" || c === "]") { stack.pop(); prev = c; }
    else if (c === "," || c === ":") prev = c;
    else if (!/\s/.test(c)) prev = "v";
  }
  return null;
}

/**
 * A container's inspection, or a list row, without what carries secrets: a computer's Env holds
 * COMPUTERD_TOKEN and VNC_PASSWORD (pool.js), and Cmd, Entrypoint, Args, Path and a list row's
 * Command can carry them too. docker.js reads only Id, Name, State, Config.Labels and
 * NetworkSettings back, so nothing it needs goes. An exec's inspection is never sent back at all
 * (GET /exec/{id}/json is refused); ProcessConfig would go the same way if it ever were.
 * @param {any} c
 */
export function scrub(c) {
  if (!c || typeof c !== "object") return c;
  for (const k of ["Args", "Path", "Command", "ProcessConfig"]) delete c[k];
  if (c.Config && typeof c.Config === "object") for (const k of ["Env", "Cmd", "Entrypoint"]) delete c.Config[k];
  return c;
}

/** @param {any} v */
const isObj = v => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isBool = v => typeof v === "boolean";
const isStrs = v => Array.isArray(v) && v.every(s => typeof s === "string");
const isSize = v => v === null || (Array.isArray(v) && v.length === 2 && v.every(n => Number.isInteger(n) && n >= 0));

/**
 * Every key allowed, each with its check; anything else in the body is refused.
 * @param {any} body @param {Record<string, (v: any) => boolean>} shape @param {string} what
 */
function only(body, shape, what) {
  if (!isObj(body)) refuse(`${what} body must be a JSON object`);
  for (const [k, v] of Object.entries(body)) {
    if (!Object.hasOwn(shape, k)) refuse(`${what} may not set ${k}`);
    if (!shape[k](v)) refuse(`${what} has a value for ${k} it may not set`);
  }
}

// Exec runs as the container's own user, unprivileged, with no stdin: `Privileged` would hand it
// every capability the container dropped, and `User: "0"` root inside it.
const EXEC_SHAPE = { AttachStdin: v => v === false, AttachStdout: isBool, AttachStderr: isBool, Tty: isBool,
  Cmd: v => isStrs(v) && v.length > 0, Env: isStrs, WorkingDir: v => typeof v === "string", ConsoleSize: isSize,
  Privileged: v => v === false };
const EXEC_START_SHAPE = { Detach: isBool, Tty: isBool, ConsoleSize: isSize };

/**
 * The real policy, core/computers/driver/policy.js, loaded at runtime (main.js) so tests can pass
 * a stub with the same interface instead.
 * @param {string|URL} [file]
 */
export async function loadPolicy(file = new URL("../computers/driver/policy.js", import.meta.url)) {
  const p = await import(String(file));
  for (const f of ["computerLabels", "isComputerLabels", "allowCreate", "allowExec", "allowContainerOp"]) {
    if (typeof p[f] !== "function") throw new Error(`${file} does not export ${f}()`);
  }
  return p;
}

/**
 * @typedef {{ computerLabels: (labels: any) => ({ prefix: string, agent: string } | null),
 *   isComputerLabels: (labels: any) => boolean,
 *   allowCreate: (body: any, config: any) => ({ ok: boolean, why?: string }),
 *   allowExec: (labels: any, cmd?: string[]) => ({ ok: boolean, why?: string }),
 *   allowContainerOp: (labels: any) => ({ ok: boolean, why?: string }) }} Policy
 * @typedef {{ network: string, image: string, labelPrefix: string, capAdd: string[] }} Config
 */

/**
 * @param {{ socket?: string, policy: Policy, config: Config,
 *   log?: (entry: { method: string, path: string, status: number, why: string }) => void }} opts
 * @returns {http.Server} not yet listening
 */
export function createProxy({ socket = "/var/run/docker.sock", policy, config, bearer, log = () => {} }) {
  if (!policy || !config || !config.network || !config.image || !config.labelPrefix) {
    throw new Error("createProxy needs the policy and the box's computers network, image and label prefix");
  }
  if (typeof bearer !== "string" || bearer.length < 16) {
    throw new Error("createProxy needs a bearer token (16+ chars) -- there is no unauthenticated mode");
  }
  const bearerBuf = Buffer.from(bearer, "utf8");
  /** Constant-time: refuses early (a bad length is itself timing-safe info an attacker cannot
   * use to guess the token faster) but never short-circuits on the token's own content. */
  const authorized = header => {
    const m = /^Bearer (.+)$/.exec(String(header || ""));
    if (!m) return false;
    const given = Buffer.from(m[1], "utf8");
    return given.length === bearerBuf.length && crypto.timingSafeEqual(given, bearerBuf);
  };
  const prefix = config.labelPrefix;

  /** Is this label set, as the Engine reports it, one of this box's computers? */
  const computer = labels => {
    const verdict = policy.allowContainerOp(labels || {});
    if (!verdict.ok) return verdict;
    const cl = policy.computerLabels(labels);
    if (!cl || cl.prefix !== prefix) return { ok: false, why: `not a computer under ${prefix}` };
    return { ok: true };
  };

  /**
   * One request to the Engine, sent and answered whole, for the proxy's own checks.
   * @param {string} method @param {string} path
   * @returns {Promise<{ status: number, body: any }>}
   */
  const engine = (method, path, cap = MAX_BODY) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, method, path, timeout: 30_000, headers: { host: "docker" } }, res => {
      const chunks = []; let n = 0;
      res.on("data", c => { n += c.length; if (n > cap) req.destroy(new Error("the Engine's answer is too large")); else chunks.push(c); });
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
        resolve({ status: res.statusCode || 0, body });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("the Engine did not answer")));
    req.on("error", reject);
    req.end();
  });

  /** Inspect a container on the Engine and refuse unless it is a computer; the inspection, or null on 404. */
  const own = async (ver, id) => {
    const r = await engine("GET", `${ver}/containers/${encodeURIComponent(id)}/json`);
    if (r.status === 404) return null;
    if (r.status !== 200) refuse(`inspecting container ${id} failed with ${r.status}`, 502);
    const verdict = computer(r.body && r.body.Config && r.body.Config.Labels);
    if (!verdict.ok) refuse(`container ${id}: ${verdict.why}`);
    if (typeof r.body.Id !== "string" || !new RegExp(`^${NAME}$`).test(r.body.Id)) refuse(`container ${id} has no usable Id`, 502);
    return r.body;
  };

  /**
   * Send the checked request on, and stream the Engine's answer back as it comes.
   * @param {http.ServerResponse} res @param {string} method @param {string} path @param {any} [body]
   */
  const forward = (res, method, path, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const up = http.request({ socketPath: socket, method, path, headers: { host: "docker",
      ...(data ? { "content-type": "application/json", "content-length": data.length } : { "content-length": 0 }) } }, ures => {
      const headers = {};
      for (const [k, v] of Object.entries(ures.headers)) if (!HOP.has(k.toLowerCase()) && v !== undefined) headers[k] = v;
      res.writeHead(ures.statusCode || 502, headers);
      ures.pipe(res);
      ures.on("end", resolve);
      ures.on("error", reject);
    });
    up.on("error", reject);
    res.on("close", () => up.destroy());
    up.end(data || undefined);
  });

  /** @param {http.ServerResponse} res @param {number} status @param {any} body */
  const send = (res, status, body) => {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { "content-type": "application/json", "content-length": data.length });
    res.end(data);
  };

  /** @param {http.IncomingMessage} req @returns {Promise<Buffer|null>} null when over the cap */
  const readBody = async req => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > MAX_BODY) { req.resume(); return null; }
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n <= MAX_BODY) chunks.push(c); }
    return n > MAX_BODY ? null : Buffer.concat(chunks);
  };

  /** @param {Buffer} raw */
  const parse = raw => {
    const text = raw.toString("utf8");
    let body;
    try { body = JSON.parse(text); } catch { refuse("the body is not JSON", 400); }
    const dup = duplicateKey(text);
    if (dup !== null) refuse(`the body repeats the key ${JSON.stringify(dup)}`, 400);
    return body;
  };

  /** The caller's list filters, with the computer labels forced in. */
  const forceFilters = raw => {
    /** @type {Record<string, string[]>} */
    const out = {};
    if (raw) {
      let f;
      try { f = JSON.parse(raw); } catch { refuse("filters is not JSON", 400); }
      if (!isObj(f)) refuse("filters must be a JSON object", 400);
      for (const [k, v] of Object.entries(f)) {
        // The Engine takes both {"label":["a"]} and the older {"label":{"a":true}}.
        if (isStrs(v)) out[k] = [...v];
        else if (isObj(v) && Object.values(v).every(x => x === true)) out[k] = Object.keys(v);
        else refuse(`filters.${k} is neither a list nor a set of strings`, 400);
      }
    }
    out.label = [...new Set([...(out.label || []), "run.vyre=1", `${prefix}.managed=true`])];
    return JSON.stringify(out);
  };

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  const handle = async (req, res) => {
    if (!authorized(req.headers.authorization)) refuse("missing or wrong bearer", 401);
    const method = String(req.method);
    const url = new URL(String(req.url), "http://docker");
    const v = /^\/v1\.\d{1,2}(?=\/)/.exec(url.pathname);
    const ver = v ? v[0] : "";
    const path = url.pathname.slice(ver.length);
    if (!["GET", "POST", "DELETE", "HEAD"].includes(method)) refuse(`${method} is not a method this proxy passes`);
    const route = ROUTES.find(([m, re]) => m === method && re.test(path));
    if (!route) refuse(`${method} ${path} is not an endpoint agents' computers use`);
    const [, re, name, keys, hasBody] = /** @type {[string, RegExp, string, string[], boolean]} */ (route);
    const m = /** @type {RegExpExecArray} */ (re.exec(path));
    for (const k of new Set(url.searchParams.keys())) {
      if (!keys.includes(k)) refuse(`${path} may not carry ?${k}`);
      if (url.searchParams.getAll(k).length > 1) refuse(`?${k} is given twice`);
    }
    const q = url.searchParams;

    const raw = await readBody(req);
    if (raw === null) refuse(`the body is over ${MAX_BODY} bytes`, 413);
    const buf = /** @type {Buffer} */ (raw);
    if (!hasBody && buf.length) refuse(`${path} takes no body`);
    const body = hasBody ? parse(buf) : undefined;

    if (name === "list") {
      const qs = new URLSearchParams(q);
      qs.set("filters", forceFilters(q.get("filters")));
      const r = await engine("GET", `${ver}/containers/json?${qs}`, MAX_LIST);
      if (r.status !== 200) return send(res, r.status, r.body);
      return send(res, 200, (Array.isArray(r.body) ? r.body : []).filter(c => c && computer(c.Labels).ok).map(scrub));
    }

    if (name === "create") {
      const verdict = policy.allowCreate(body, config);
      if (!verdict.ok) refuse(`create: ${verdict.why}`);
      const agent = body.Labels && body.Labels[`${prefix}.computer`];
      if (typeof agent !== "string" || !agent) refuse(`create: Labels name no ${prefix}.computer`);
      if (q.get("name") !== `${prefix}-computer-${agent}`) refuse(`create: the container must be named ${prefix}-computer-${agent}`);
      // Docker applies VolumeOptions.Labels only to a volume it makes now; an existing one is
      // mounted as it is, so its own labels must already name this agent.
      const mounts = (body.HostConfig && Array.isArray(body.HostConfig.Mounts)) ? body.HostConfig.Mounts : [];
      for (const mt of mounts.filter(x => x && x.Type === "volume")) {
        const src = String(mt.Source || "");
        if (!new RegExp(`^${NAME}$`).test(src)) refuse(`create: ${JSON.stringify(src)} is not a volume name`);
        const r = await engine("GET", `${ver}/volumes/${encodeURIComponent(src)}`);
        if (r.status === 404) continue;
        if (r.status !== 200) refuse(`inspecting volume ${src} failed with ${r.status}`, 502);
        const cl = policy.computerLabels(r.body && r.body.Labels);
        if (!cl || cl.prefix !== prefix || cl.agent !== agent) refuse(`create: volume ${src} exists and is not ${agent}'s`);
      }
      return forward(res, "POST", `${ver}/containers/create?${new URLSearchParams({ name: String(q.get("name")) })}`, body);
    }

    if (name === "volume") {
      const r = await engine("GET", `${ver}/volumes/${encodeURIComponent(m[1])}`);
      if (r.status !== 200) return send(res, r.status, r.body);
      const verdict = computer(r.body && r.body.Labels);
      if (!verdict.ok) refuse(`volume ${m[1]}: ${verdict.why}`);
      return send(res, 200, r.body);
    }

    if (name === "execStart") {
      only(body, EXEC_START_SHAPE, "exec start");
      const r = await engine("GET", `${ver}/exec/${encodeURIComponent(m[1])}/json`);
      if (r.status !== 200) return send(res, r.status, r.body);
      const cid = r.body && r.body.ContainerID;
      if (typeof cid !== "string" || !cid) refuse(`exec ${m[1]} names no container`, 502);
      if (!(await own(ver, cid))) refuse(`exec ${m[1]}'s container is gone`);
      return forward(res, "POST", `${ver}/exec/${encodeURIComponent(m[1])}/start`, body);
    }

    // Every per-container op: the Engine's own labels first, then the op on the id it returned,
    // so a name cannot be swapped for another container in between.
    const c = await own(ver, m[1]);
    if (!c) return send(res, 404, { message: `No such container: ${m[1]}` });
    const id = c.Id;
    const qs = q.toString() ? `?${q}` : "";
    if (name === "inspect") {
      // Buffered (capped by engine()) and scrubbed, never streamed: the Engine's answer has Env.
      const r = await engine("GET", `${ver}/containers/${id}/json${qs}`);
      if (r.status !== 200) return send(res, r.status, r.body);
      if (!computer(r.body && r.body.Config && r.body.Config.Labels).ok) refuse(`container ${m[1]} changed under the check`);
      return send(res, 200, scrub(r.body));
    }
    // Residual (security, 26 Sep): any caller that reaches this proxy can stop, pause or remove
    // ANY agent's computer, not only its own; labels tell a computer from vyred's containers, not
    // one agent's from another's. Denial of service only: the home volume survives a remove
    // (named, v=false leaves it), and nothing here reads or runs inside the computer. Closed when
    // vyred is the only caller on this network.
    if (name === "op") return forward(res, "POST", `${ver}/containers/${id}/${m[2]}${qs}`);
    if (name === "remove") return forward(res, "DELETE", `${ver}/containers/${id}${qs}`);
    if (name === "exec") {
      only(body, EXEC_SHAPE, "exec");
      if (!body.Cmd) refuse("exec needs a Cmd");
      const verdict = policy.allowExec(c.Config.Labels, body.Cmd);
      if (!verdict.ok) refuse(`exec: ${verdict.why}`);
      return forward(res, "POST", `${ver}/containers/${id}/exec`, body);
    }
    refuse(`${name} has no handler`);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      const status = err instanceof Refusal ? err.status : 502;
      const why = err instanceof Refusal ? err.message : `the Engine: ${err.message}`;
      log({ method: String(req.method), path: new URL(String(req.url), "http://docker").pathname, status, why });
      if (!res.headersSent) send(res, status, { message: `vyre docker proxy: ${why}` });
      else res.destroy();
      req.resume();
    });
  });
  // An attached exec would hijack the connection for stdin; docker.js never attaches.
  server.on("upgrade", (req, sock) => {
    log({ method: String(req.method), path: new URL(String(req.url), "http://docker").pathname, status: 403, why: "connection upgrades are refused" });
    sock.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  server.requestTimeout = 60_000;
  return server;
}
