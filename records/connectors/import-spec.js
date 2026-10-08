// @ts-check
// A draft Connection from an API description (OpenAPI 3 or 2 as JSON, Postman collection v2): the operations the description lists, as the form takes them. Nothing is saved or called here: the
// person looks at the list, keeps the operations they want, and the form makes the Connection. The draft never relabels anything (a POST is a change, whatever the description says it is for) and
// takes no key, no example value and no server variable from the description.

const METHODS = ["get", "head", "post", "put", "patch", "delete"];
const MAX_OPS = 200;
const isObj = (/** @type {any} */ v) => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = (/** @type {string} */ m) => Object.assign(new Error(m), { code: "bad_input" });

/** A name the Connection format takes: lower case words joined by dots. "getContactById" becomes "get_contact_by_id", "Contacts / Create" becomes "contacts.create". @param {string} s */
export function opName(s) {
  const parts = String(s).split(/[\/>|]+/).map(p => p.trim()).filter(Boolean).slice(0, 4);
  const words = parts.map(p => p.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[0-9]+/, "")).filter(Boolean);
  return words.join(".") || "operation";
}

/** @param {any} schema @returns {{ type: string, enum?: any[] }} */
function shapeOf(schema) {
  const t = isObj(schema) ? schema.type : undefined;
  const type = t === "integer" || t === "number" ? "number" : t === "boolean" ? "boolean" : t === "array" ? "array" : t === "object" ? "object" : "string";
  return { type, ...(isObj(schema) && Array.isArray(schema.enum) && schema.enum.length && schema.enum.every((/** @type {any} */ e) => typeof e === "string") ? { enum: schema.enum.slice(0, 50) } : {}) };
}

/** @param {any} root @param {string} ref */
function deref(root, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  let cur = root;
  for (const k of ref.slice(2).split("/")) { cur = isObj(cur) ? cur[k.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined; }
  return cur;
}

/** The most an API description may weigh, as JSON or YAML. */
export const MAX_SPEC_BYTES = 5_000_000;

/**
 * The description as data: JSON, or YAML (the `yaml` package, loaded only here and only when the text is not JSON). YAML is read with the core schema and no custom tags (a tag is never code here), at
 * most 100 alias expansions (a document that folds anchors into each other to grow without end is refused before it grows), strict, and only its first document.
 * @param {any} text @returns {Promise<any>}
 */
async function parseDoc(text) {
  if (isObj(text)) return text;
  const t = String(text || "").trim();
  if (!t) throw fail("give the API description (an OpenAPI or Postman file)");
  if (t.length > MAX_SPEC_BYTES) throw fail("that description is larger than 5 MB");
  if (t.startsWith("{")) { try { return JSON.parse(t); } catch { throw fail("that is not valid JSON"); } }
  const YAML = await import("yaml");
  let docs;
  try { docs = YAML.parseAllDocuments(t, { schema: "core", version: "1.2", strict: true, maxAliasCount: 100, customTags: [], merge: false, keepSourceTokens: false, prettyErrors: false, uniqueKeys: true }); }
  catch { throw fail("that is not valid YAML or JSON"); }
  const first = Array.isArray(docs) ? docs[0] : docs;
  if (!first || (first.errors && first.errors.length)) throw fail(`that is not valid YAML or JSON${first && first.errors && first.errors[0] ? ` (${String(first.errors[0].message).split("\n")[0].slice(0, 120)})` : ""}`);
  try { return first.toJS({ maxAliasCount: 100 }); }
  catch (e) { throw fail(/alias/i.test(String(/** @type {Error} */ (e).message)) ? "that file expands its aliases too far to read (more than 100)" : "that is not valid YAML or JSON"); }
}

/** @param {string} u @returns {{ base_url: string, prefix: string } | null} */
function splitServer(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== "https:" || x.username || x.password || /[{}]/.test(u)) return null;
    return { base_url: x.origin, prefix: x.pathname.replace(/\/+$/, "") };
  } catch { return null; }
}

/**
 * @param {any} input the file's text, or its parsed JSON
 * @returns {Promise<{ source: "openapi" | "postman", label: string, base_url: string, operations: any[], notes: string[], skipped: number }>}
 */
export async function importSpec(input) {
  const doc = await parseDoc(input);
  if (typeof doc.openapi === "string" || typeof doc.swagger === "string") return fromOpenApi(doc);
  if (Array.isArray(doc.item)) return fromPostman(doc);
  throw fail("that is neither an OpenAPI file (it has no `openapi` or `swagger`) nor a Postman collection (it has no `item`)");
}

/** @param {any} doc */
function fromOpenApi(doc) {
  /** @type {string[]} */ const notes = [];
  let server = null;
  if (typeof doc.openapi === "string") { const s = Array.isArray(doc.servers) ? doc.servers.find((/** @type {any} */ x) => isObj(x) && typeof x.url === "string" && splitServer(x.url)) : null; server = s ? splitServer(s.url) : null; }
  else if (typeof doc.host === "string" && (!Array.isArray(doc.schemes) || doc.schemes.includes("https"))) server = splitServer(`https://${doc.host}${typeof doc.basePath === "string" ? doc.basePath : ""}`);
  if (!server) notes.push("the description names no https server address: type the app's address yourself");
  const prefix = server ? server.prefix : "";
  /** @type {any[]} */ const operations = []; const used = new Set(); let skipped = 0;
  for (const [rawPath, item] of Object.entries(isObj(doc.paths) ? doc.paths : {})) {
    if (!isObj(item)) continue;
    for (const m of METHODS) {
      const op = item[m];
      if (!isObj(op)) continue;
      if (operations.length >= MAX_OPS) { skipped++; continue; }
      const path = `${prefix}${rawPath}`;
      if (!/^\/[A-Za-z0-9._~\/{}:-]{0,200}$/.test(path) || path.split("/").includes("..")) { skipped++; continue; }
      let name = opName(typeof op.operationId === "string" ? op.operationId : `${m} ${rawPath.replace(/[{}]/g, "").replace(/\//g, "_")}`);
      for (let n = 2; used.has(name); n++) name = `${name.replace(/_\d+$/, "")}_${n}`;
      used.add(name);
      /** @type {Record<string, any>} */ const params = {}, query = {}, body = {};
      for (const p0 of [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const p = isObj(p0) && typeof p0.$ref === "string" ? deref(doc, p0.$ref) : p0;
        if (!isObj(p) || typeof p.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_.\[\]-]{0,63}$/.test(p.name)) continue;
        const shape = { ...shapeOf(isObj(p.schema) ? p.schema : p), ...(p.required === true || p.in === "path" ? { required: true } : {}) };
        if (p.in === "path") params[p.name] = shape; else if (p.in === "query") query[p.name] = { ...shape, required: undefined };
      }
      for (const k of Object.keys(query)) if (query[k].required === undefined) delete query[k].required;
      // path parameters the path names but the description did not
      for (const mm of path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) if (!params[mm[1]]) params[mm[1]] = { type: "string", required: true };
      let hasBody = false;
      const rb = isObj(op.requestBody) && typeof op.requestBody.$ref === "string" ? deref(doc, op.requestBody.$ref) : op.requestBody;
      const js = isObj(rb) && isObj(rb.content) ? (rb.content["application/json"] || Object.values(rb.content)[0]) : null;
      const sch0 = isObj(js) ? js.schema : null;
      const sch = isObj(sch0) && typeof sch0.$ref === "string" ? deref(doc, sch0.$ref) : sch0;
      if (isObj(sch) && isObj(sch.properties)) {
        const req = Array.isArray(sch.required) ? sch.required : [];
        for (const [k, v] of Object.entries(sch.properties).slice(0, 60)) if (/^[A-Za-z_][A-Za-z0-9_.\[\]-]{0,63}$/.test(k)) body[k] = { ...shapeOf(isObj(v) && typeof v.$ref === "string" ? deref(doc, v.$ref) : v), ...(req.includes(k) ? { required: true } : {}) };
        hasBody = true;
      } else if (m !== "get" && m !== "head" && m !== "delete" && rb) hasBody = true;
      const input = { ...(Object.keys(params).length ? { params } : {}), ...(Object.keys(query).length ? { query } : {}), ...(Object.keys(body).length ? { body } : {}) };
      operations.push({ name, method: m.toUpperCase(), path, ...(typeof op.summary === "string" && op.summary.trim() ? { label: op.summary.replace(/\s+/g, " ").trim().slice(0, 80) } : {}), ...(Object.keys(input).length ? { input } : {}) });
      if (hasBody && !Object.keys(body).length) notes.push(`${name}: its body is not a plain object, so no body fields were listed; use the generic request for it`);
    }
  }
  if (!operations.length) throw fail("that description lists no operations");
  if (skipped) notes.push(`${skipped} operation${skipped === 1 ? " was" : "s were"} left out (more than ${MAX_OPS}, or a path this cannot use)`);
  return { source: "openapi", label: String(doc.info && doc.info.title || "").slice(0, 80), base_url: server ? server.base_url : "", operations, notes, skipped };
}

/** @param {any} doc */
function fromPostman(doc) {
  /** @type {string[]} */ const notes = [];
  /** @type {any[]} */ const operations = []; const used = new Set(); let skipped = 0, base = "";
  /** @param {any[]} items @param {string[]} trail */
  const walk = (items, trail) => {
    for (const it of items) {
      if (!isObj(it)) continue;
      if (Array.isArray(it.item)) { walk(it.item, [...trail, String(it.name || "")]); continue; }
      const r = it.request;
      if (!isObj(r)) continue;
      const method = String(r.method || "GET").toUpperCase();
      if (!METHODS.includes(method.toLowerCase())) { skipped++; continue; }
      if (operations.length >= MAX_OPS) { skipped++; continue; }
      const u = r.url;
      const raw = typeof u === "string" ? u : isObj(u) && typeof u.raw === "string" ? u.raw : "";
      const parts = isObj(u) && Array.isArray(u.path) ? u.path.map(String) : (raw.replace(/^https?:\/\/[^/]+/, "").split("?")[0].split("/").filter(Boolean));
      const host = isObj(u) && Array.isArray(u.host) ? u.host.join(".") : (/^https?:\/\/([^/{]+)/.exec(raw) || [])[1] || "";
      if (!base && host && !/[{}]/.test(host) && /\./.test(host)) base = `https://${host}`;
      const path = "/" + parts.map(p => (/^\{\{.*\}\}$/.test(p) ? "{" + p.slice(2, -2).replace(/[^A-Za-z0-9_]/g, "_") + "}" : p.startsWith(":") ? `{${p.slice(1)}}` : p)).join("/");
      if (!/^\/[A-Za-z0-9._~\/{}:-]{0,200}$/.test(path) || path.split("/").includes("..")) { skipped++; continue; }
      let name = opName([...trail, String(it.name || `${method} ${path}`)].filter(Boolean).join(" / "));
      for (let n = 2; used.has(name); n++) name = `${name.replace(/_\d+$/, "")}_${n}`;
      used.add(name);
      /** @type {Record<string, any>} */ const params = {}, query = {}, body = {};
      for (const mm of path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) params[mm[1]] = { type: "string", required: true };
      if (isObj(u) && Array.isArray(u.query)) for (const q of u.query) if (isObj(q) && typeof q.key === "string" && /^[A-Za-z_][A-Za-z0-9_.\[\]-]{0,63}$/.test(q.key) && q.disabled !== true) query[q.key] = { type: "string" };
      if (isObj(r.body) && r.body.mode === "raw" && typeof r.body.raw === "string") {
        try { const sample = JSON.parse(r.body.raw); if (isObj(sample)) for (const [k, v] of Object.entries(sample).slice(0, 60)) if (/^[A-Za-z_][A-Za-z0-9_.\[\]-]{0,63}$/.test(k)) body[k] = shapeOf({ type: Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v }); } catch { /* not JSON: no fields listed */ }
      }
      const input = { ...(Object.keys(params).length ? { params } : {}), ...(Object.keys(query).length ? { query } : {}), ...(Object.keys(body).length ? { body } : {}) };
      operations.push({ name, method, path, ...(it.name ? { label: String(it.name).slice(0, 80) } : {}), ...(Object.keys(input).length ? { input } : {}) });
    }
  };
  walk(doc.item, []);
  if (!operations.length) throw fail("that collection lists no requests");
  if (!base) notes.push("the collection names no plain https host: type the app's address yourself");
  if (skipped) notes.push(`${skipped} request${skipped === 1 ? " was" : "s were"} left out (an unusual method, a path this cannot use, or more than ${MAX_OPS})`);
  return { source: "postman", label: String(doc.info && doc.info.name || "").slice(0, 80), base_url: base, operations, notes, skipped };
}
