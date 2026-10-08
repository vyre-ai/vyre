// @ts-check
// The app module manifest (spec 0.3.0 part 8): a module that wraps an open-source app. Four parts, each reusing something that exists:
//   app          a container image pinned by digest, its port, volumes, environment (secrets come from the Vault), a health path, memory and CPU limits, and what it may reach outward
//   connection   the app's own API in the Connection format (team/0.3/IFACE-connection.md); its credential is made at install and kept in the Vault
//   events       the app's webhooks mapped to Vyre events, and optionally to a Flow's web trigger
//   screens      the app's own web screens, served by vyred on the app's own origin, <module>.<host>, behind Vyre's sign-in (a one-time ticket): [{ id, label, path, icon? }], path relative to that origin
// This file only reads and checks a manifest; nothing here starts anything. A manifest that fails is refused whole, with every problem named.

export const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
/** A full, pinned image reference: name, tag and sha256 digest. A tag can be moved at the registry; the digest cannot. */
export const PINNED_RE = /^[a-z0-9][a-z0-9./_-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*)?@sha256:[0-9a-f]{64}$/;
const VOLUME_RE = /^[a-z][a-z0-9-]{0,30}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const EVENT_RE = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/;
const FLOW_PATH_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OP_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,3}$/;
export const GENERATORS = Object.freeze(["hex32", "base64url32", "password24"]);
/** What an app may be allowed to reach: nothing, or Vyre's own webhook door. No other host is nameable in 0.3.0. */
export const EGRESS_TARGETS = Object.freeze(["vyred"]);
/** Placeholders a value may carry; the host fills them. */
export const PLACEHOLDERS = Object.freeze(["origin", "hook_url", "hook_token", "api_token", "name"]);
export const LIMITS = Object.freeze({ memoryMb: [64, 8192], cpus: [0.1, 8], pids: [32, 4096], volumes: 4, env: 40, screens: 12, events: 24 });

const isObj = (/** @type {any} */ v) => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (/** @type {any} */ v, /** @type {[number, number]} */ r) => typeof v === "number" && Number.isFinite(v) && v >= r[0] && v <= r[1];

/** @param {string} s the placeholders a string uses that this build does not know */
function unknownPlaceholders(s) { return [...String(s).matchAll(/\{([a-z_]+)\}/g)].map(m => m[1]).filter(p => !PLACEHOLDERS.includes(p)); }

/**
 * Check a manifest. Returns the problems, each { path, message }; none means it is usable.
 * @param {any} m
 * @returns {{ path: string, message: string }[]}
 */
export function checkAppModule(m) {
  /** @type {{ path: string, message: string }[]} */ const out = [];
  const bad = (/** @type {string} */ path, /** @type {string} */ message) => out.push({ path, message });
  if (!isObj(m)) return [{ path: "", message: "a manifest is an object" }];
  const known = ["name", "version", "vyre", "description", "app", "connection", "events", "screens", "drive", "notes", "license", "source", "$schema"];
  for (const k of Object.keys(m)) if (!known.includes(k) && !k.startsWith("x-")) bad(k, `${k} is not part of an app module manifest`);
  if (typeof m.name !== "string" || !NAME_RE.test(m.name)) bad("name", "a name is lowercase letters, digits and dashes, 2 to 31 characters");
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(m.version)) bad("version", "version is semver");
  if (m.vyre !== undefined && m.vyre !== "1") bad("vyre", 'vyre is "1"');
  if (typeof m.description !== "string" || !m.description.trim() || m.description.length > 200) bad("description", "one plain sentence, at most 200 characters");
  if (m.license !== undefined && typeof m.license !== "string") bad("license", "license is a string");
  if (m.source !== undefined && !(typeof m.source === "string" && /^https:\/\//.test(m.source))) bad("source", "source is an https address");

  // The Drive folders the app's files may be put in (the owner agrees at install; the module is granted these and no others).
  if (m.drive !== undefined && !(Array.isArray(m.drive) && m.drive.length > 0 && m.drive.length <= 4 && m.drive.every((/** @type {any} */ d) => typeof d === "string" && /^[A-Z][A-Za-z0-9 _-]{0,40}$/.test(d)))) bad("drive", "drive lists the top Drive folders the app's files go in, each starting with a capital letter");
  if (m.notes !== undefined && !(Array.isArray(m.notes) && m.notes.length <= 6 && m.notes.every((/** @type {any} */ n) => typeof n === "string" && n.length > 0 && n.length <= 240))) bad("notes", "notes are a few plain sentences the install card shows");
  const a = m.app;
  if (!isObj(a)) bad("app", "an app module has an app part");
  else {
    const ak = ["image", "port", "volumes", "env", "secrets", "health", "limits", "egress", "bootstrap", "login", "public", "tmp", "hookPort"];
    for (const k of Object.keys(a)) if (!ak.includes(k)) bad(`app.${k}`, `${k} is not part of app`);
    if (typeof a.image !== "string" || !PINNED_RE.test(a.image)) bad("app.image", "the image is pinned by digest: name:tag@sha256:<64 hex>");
    if (!(Number.isInteger(a.port) && a.port >= 1 && a.port <= 65535)) bad("app.port", "port is a whole number from 1 to 65535");
    if (a.volumes !== undefined) {
      if (!Array.isArray(a.volumes) || a.volumes.length > LIMITS.volumes) bad("app.volumes", `at most ${LIMITS.volumes} volumes`);
      else a.volumes.forEach((/** @type {any} */ v, /** @type {number} */ i) => {
        if (!isObj(v) || typeof v.name !== "string" || !VOLUME_RE.test(v.name)) bad(`app.volumes[${i}].name`, "a volume name is lowercase letters, digits and dashes");
        if (!isObj(v) || typeof v.path !== "string" || !/^\/[A-Za-z0-9_./-]*$/.test(v.path) || v.path.includes("..") || ["/", "/etc", "/proc", "/sys", "/dev", "/var/run", "/run"].includes(v.path)) bad(`app.volumes[${i}].path`, "a volume path is an absolute folder inside the app, not a system folder");
      });
    }
    if (a.env !== undefined) {
      if (!isObj(a.env) || Object.keys(a.env).length > LIMITS.env) bad("app.env", `env is an object of at most ${LIMITS.env} values`);
      else for (const [k, v] of Object.entries(a.env)) {
        if (!ENV_RE.test(k)) bad(`app.env.${k}`, "an environment name is capital letters, digits and underscores");
        else if (typeof v !== "string" || v.length > 500) bad(`app.env.${k}`, "a value is a short string");
        else for (const p of unknownPlaceholders(v)) bad(`app.env.${k}`, `{${p}} is not a placeholder (use ${PLACEHOLDERS.join(", ")})`);
      }
    }
    if (a.secrets !== undefined) {
      if (!Array.isArray(a.secrets) || a.secrets.length > 12) bad("app.secrets", "secrets are a short list");
      else a.secrets.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
        if (!isObj(s) || typeof s.env !== "string" || !ENV_RE.test(s.env)) bad(`app.secrets[${i}].env`, "the environment name the secret is given as");
        if (!isObj(s) || !GENERATORS.includes(s.generate)) bad(`app.secrets[${i}].generate`, `generate is one of ${GENERATORS.join(", ")}`);
        if (isObj(s) && isObj(a.env) && typeof s.env === "string" && s.env in a.env) bad(`app.secrets[${i}].env`, `${s.env} is also in env`);
      });
    }
    if (!isObj(a.health) || typeof a.health.path !== "string" || !a.health.path.startsWith("/") || /\s/.test(a.health.path)) bad("app.health.path", "a health path starts with /");
    else {
      if (!(Array.isArray(a.health.ok) && a.health.ok.length > 0 && a.health.ok.every((/** @type {any} */ c) => Number.isInteger(c) && c >= 100 && c <= 599))) bad("app.health.ok", "ok lists the status codes that mean healthy");
      if (a.health.startS !== undefined && !(Number.isInteger(a.health.startS) && a.health.startS >= 1 && a.health.startS <= 600)) bad("app.health.startS", "startS is 1 to 600 seconds");
    }
    const l = a.limits;
    if (!isObj(l)) bad("app.limits", "limits are required: memoryMb, cpus and pids");
    else {
      if (!num(l.memoryMb, /** @type {[number, number]} */ (LIMITS.memoryMb))) bad("app.limits.memoryMb", `memoryMb is ${LIMITS.memoryMb[0]} to ${LIMITS.memoryMb[1]}`);
      if (!num(l.cpus, /** @type {[number, number]} */ (LIMITS.cpus))) bad("app.limits.cpus", `cpus is ${LIMITS.cpus[0]} to ${LIMITS.cpus[1]}`);
      if (!num(l.pids, /** @type {[number, number]} */ (LIMITS.pids))) bad("app.limits.pids", `pids is ${LIMITS.pids[0]} to ${LIMITS.pids[1]}`);
    }
    // Static files a browser fetches without its cookies (a web app manifest): served to anyone who reaches the app's origin, GET only, nothing else.
    if (a.public !== undefined && !(Array.isArray(a.public) && a.public.length <= 8 && a.public.every((/** @type {any} */ p) => typeof p === "string" && /^\/[A-Za-z0-9_.\/-]{1,80}$/.test(p) && !p.includes("..")))) bad("app.public", "public lists the static paths served without a session");
    // The webhook door's port on a box where the host helper starts the app: fixed here, unique across the catalog, checked again by root when it records the catalog.
    if (a.hookPort !== undefined && !(Number.isInteger(a.hookPort) && a.hookPort >= 43000 && a.hookPort <= 43999)) bad("app.hookPort", "hookPort is a whole number from 43000 to 43999");
    if (a.egress !== undefined) {
      if (!Array.isArray(a.egress) || !a.egress.every((/** @type {any} */ e) => EGRESS_TARGETS.includes(e))) bad("app.egress", `egress lists what the app may reach, from: ${EGRESS_TARGETS.join(", ")}; nothing else is reachable`);
    }
    if (a.bootstrap !== undefined) {
      const b = a.bootstrap;
      if (!isObj(b)) bad("app.bootstrap", "bootstrap is an object");
      else {
        if (!(Array.isArray(b.exec) && b.exec.length > 0 && b.exec.every((/** @type {any} */ x) => typeof x === "string" && x.length < 200))) bad("app.bootstrap.exec", "exec is the command to run in the app, as a list");
        if (typeof b.script !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(b.script)) bad("app.bootstrap.script", "script is the file in the catalog folder that is given to the command");
        if (!Array.isArray(b.outputs) || !b.outputs.every((/** @type {any} */ o) => isObj(o) && typeof o.name === "string" && /^[a-z][a-z0-9_]*$/.test(o.name))) bad("app.bootstrap.outputs", "outputs name what the command prints as NAME=value lines");
      }
    }
  }

  // How Vyre signs in to the app's own screens for the person (so Vyre's sign-in is the only one): a form post to the app's login page with the credentials the bootstrap made.
  if (isObj(a) && a.login !== undefined) {
    const l = a.login;
    if (!isObj(l)) bad("app.login", "login is an object");
    else {
      for (const k of Object.keys(l)) if (!["path", "token", "fields", "ok"].includes(k)) bad(`app.login.${k}`, `${k} is not part of login`);
      if (typeof l.path !== "string" || !l.path.startsWith("/")) bad("app.login.path", "path is the app's sign-in page, starting with /");
      if (typeof l.token !== "string" || !/^[a-z_]{1,40}$/.test(l.token)) bad("app.login.token", "token names the form's anti-forgery field");
      if (!isObj(l.fields) || !Object.values(l.fields).every(v => typeof v === "string" && [...v.matchAll(/\{([a-z_]+)\}/g)].every(x => ["login_email", "login_password"].includes(x[1])))) bad("app.login.fields", "fields are the form's fields; a value may use {login_email} and {login_password}");
      if (!(Array.isArray(l.ok) && l.ok.length > 0 && l.ok.every((/** @type {any} */ c) => Number.isInteger(c)))) bad("app.login.ok", "ok lists the status codes that mean signed in");
    }
  }

  if (m.connection !== undefined) {
    const c = m.connection;
    if (!isObj(c)) bad("connection", "connection is an object");
    else {
      for (const k of Object.keys(c)) if (!["label", "auth", "credential", "headers", "check", "operations"].includes(k)) bad(`connection.${k}`, `${k} is not part of connection (see IFACE-connection.md)`);
      if (typeof c.label !== "string" || !c.label || c.label.length > 80) bad("connection.label", "a label is at most 80 characters");
      if (!isObj(c.auth) || !["bearer", "header", "basic", "query"].includes(c.auth.kind)) bad("connection.auth", "auth.kind is bearer, header, basic or query");
      else if (["header", "query"].includes(c.auth.kind) && typeof c.auth.name !== "string") bad("connection.auth.name", "name the header or the parameter");
      if (typeof c.credential !== "string" || !/^[a-z][a-z0-9_]*$/.test(c.credential)) bad("connection.credential", "credential names the bootstrap output that is the API key");
      else if (isObj(a) && isObj(a.bootstrap) && Array.isArray(a.bootstrap.outputs) && !a.bootstrap.outputs.some((/** @type {any} */ o) => o.name === c.credential)) bad("connection.credential", `the bootstrap prints no output called ${c.credential}`);
      if (!isObj(c.check) || c.check.method !== "GET" || typeof c.check.path !== "string" || !c.check.path.startsWith("/")) bad("connection.check", "check is one GET request that proves the key works");
      if (c.operations !== undefined) {
        if (!Array.isArray(c.operations) || c.operations.length > 40) bad("connection.operations", "operations are a list");
        else c.operations.forEach((/** @type {any} */ o, /** @type {number} */ i) => {
          if (!isObj(o) || typeof o.name !== "string" || !OP_RE.test(o.name)) bad(`connection.operations[${i}].name`, "an operation name is words joined by dots");
          if (!isObj(o) || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(o.method)) bad(`connection.operations[${i}].method`, "method is an HTTP method");
          if (!isObj(o) || typeof o.path !== "string" || !o.path.startsWith("/")) bad(`connection.operations[${i}].path`, "path starts with /");
          if (!isObj(o) || !["read", "draft", "change", "send", "spend", "delete"].includes(o.kind)) bad(`connection.operations[${i}].kind`, "kind is read, draft, change, send, spend or delete");
        });
      }
    }
  }

  if (m.events !== undefined) {
    if (!Array.isArray(m.events) || m.events.length > LIMITS.events) bad("events", `events are a list of at most ${LIMITS.events}`);
    else {
      const seen = new Set();
      m.events.forEach((/** @type {any} */ e, /** @type {number} */ i) => {
        if (!isObj(e)) { bad(`events[${i}]`, "an event is an object"); return; }
        for (const k of Object.keys(e)) if (!["webhook", "event", "flow", "data", "files"].includes(k)) bad(`events[${i}].${k}`, `${k} is not part of an event`);
        if (typeof e.webhook !== "string" || !/^[a-z][a-z0-9._-]{0,60}$/.test(e.webhook)) bad(`events[${i}].webhook`, "webhook names the app's own event");
        if (typeof e.event !== "string" || !EVENT_RE.test(e.event)) bad(`events[${i}].event`, "event is the Vyre event it becomes: noun.verb");
        else if (typeof m.name === "string" && !e.event.startsWith(`${m.name}.`)) bad(`events[${i}].event`, `an event of this module starts with ${m.name}.`);
        if (e.flow !== undefined && (typeof e.flow !== "string" || !FLOW_PATH_RE.test(e.flow))) bad(`events[${i}].flow`, "flow is the path of a Flow's web trigger");
        if (e.data !== undefined && !(isObj(e.data) && Object.values(e.data).every(v => typeof v === "string" && /^[A-Za-z0-9_.[\]]+$/.test(v)))) bad(`events[${i}].data`, "data maps a name to a dotted path in the webhook body");
        if (e.files !== undefined) {
          const f = e.files;
          if (!isObj(f)) bad(`events[${i}].files`, "files is an object");
          else {
            for (const k of Object.keys(f)) if (!["list", "url", "name", "saveTo"].includes(k)) bad(`events[${i}].files.${k}`, `${k} is not part of files`);
            for (const k of ["list", "url", "name"]) if (typeof f[k] !== "string" || !/^[A-Za-z0-9_.[\]]+$/.test(f[k])) bad(`events[${i}].files.${k}`, `${k} is a dotted path in the webhook body`);
            if (typeof f.saveTo !== "string" || !f.saveTo.includes("{name}") || f.saveTo.includes("..") || f.saveTo.startsWith("/") || /[^A-Za-z0-9 _{}./-]/.test(f.saveTo)) bad(`events[${i}].files.saveTo`, "saveTo is a Drive path with {name}, no leading slash and no dot segments");
            else if (!Array.isArray(m.drive) || !m.drive.some((/** @type {string} */ d) => f.saveTo.startsWith(`${d}/`))) bad(`events[${i}].files.saveTo`, "saveTo is inside a folder the manifest lists under drive");
            for (const p of [...String(f.saveTo).matchAll(/\{([a-z_]+)\}/g)].map(x => x[1])) if (p !== "name" && !(isObj(e.data) && p in e.data)) bad(`events[${i}].files.saveTo`, `{${p}} is neither {name} nor a name in data`);
          }
        }
        if (seen.has(e.webhook)) bad(`events[${i}].webhook`, `${e.webhook} is mapped twice`);
        seen.add(e.webhook);
      });
    }
  }

  if (m.screens !== undefined) {
    if (!Array.isArray(m.screens) || m.screens.length > LIMITS.screens) bad("screens", `screens are a list of at most ${LIMITS.screens}`);
    else {
      const ids = new Set();
      m.screens.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
        if (!isObj(s)) { bad(`screens[${i}]`, "a screen is an object"); return; }
        for (const k of Object.keys(s)) if (!["id", "label", "path", "icon"].includes(k)) bad(`screens[${i}].${k}`, `${k} is not part of a screen`);
        if (typeof s.id !== "string" || !/^[a-z][a-z0-9-]{0,30}$/.test(s.id)) bad(`screens[${i}].id`, "a screen id is lowercase letters, digits and dashes");
        else if (ids.has(s.id)) bad(`screens[${i}].id`, `${s.id} is used twice`);
        else ids.add(s.id);
        if (typeof s.label !== "string" || !s.label || s.label.length > 40) bad(`screens[${i}].label`, "a label is at most 40 characters");
        if (typeof s.path !== "string" || !s.path.startsWith("/") || s.path.includes("..") || /[\s?#]/.test(s.path)) bad(`screens[${i}].path`, "path is relative to /m/<module>/ and starts with /");
        if (s.icon !== undefined && !(typeof s.icon === "string" && /^[a-z][a-z0-9-]{0,30}$/.test(s.icon))) bad(`screens[${i}].icon`, "icon is a system symbol name");
      });
    }
  }
  return out;
}

/** The manifest, or a thrown Error naming every problem. @param {any} m */
export function parseAppModule(m) {
  const problems = checkAppModule(m);
  if (problems.length) throw Object.assign(new Error(`not an app module: ${problems.map(p => `${p.path || "manifest"}: ${p.message}`).join("; ")}`), { code: "bad_manifest", problems });
  return /** @type {any} */ (m);
}

/**
 * The install card for a manifest, built by Vyre from the manifest and nothing the app says: what runs, what it may use, what it may reach.
 * @param {any} m
 */
export function cardOf(m) {
  const a = m.app;
  return {
    name: m.name, version: m.version, description: m.description, license: m.license || null, source: m.source || null,
    runs: `${String(a.image).split("@")[0]} in a container on this server`,
    pinned: String(a.image).split("@")[1],
    uses: [`up to ${a.limits.memoryMb} MB of memory`, `${a.limits.cpus} CPU`, ...(a.volumes || []).map((/** @type {any} */ v) => `a folder of its own for ${v.path}`), ...(a.secrets || []).length ? ["its own keys, made now and kept in your Vault"] : []],
    reaches: (a.egress || []).length ? (a.egress || []).map((/** @type {string} */ e) => e === "vyred" ? "your Vyre, to tell it a document was signed" : e) : ["nothing outside this server"],
    saves: (m.drive || []).length ? `the files it gets back, in ${(m.drive || []).map((/** @type {string} */ d) => `${d}/`).join(" and ")} in your Drive` : null,
    opensFor: "the owner and the admins of this Space",
    notes: m.notes || [],
    shows: (m.screens || []).map((/** @type {any} */ s) => s.label),
    tells: (m.events || []).map((/** @type {any} */ e) => e.event),
    connection: m.connection ? m.connection.label : null,
  };
}
