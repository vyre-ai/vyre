// Vyre gateway spike: one door to Twenty. Zero dependencies, Node 22.
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";

const TWENTY = process.env.TWENTY_URL;
const DATA = process.env.GW_DATA || "/data";
const PORT = 4000;
fs.mkdirSync(DATA, { recursive: true });
const f = (n) => `${DATA}/${n}`;
const readJson = (n, d) => { try { return JSON.parse(fs.readFileSync(f(n), "utf8")); } catch { return d; } };
const writeJson = (n, v, mode = 0o600) => fs.writeFileSync(f(n), JSON.stringify(v), { mode });

// ---- ids: time-ordered 128-bit ids minted here (UUIDv7 layout; version nibble 4 because Twenty rejects 6 to 8)
let lastMs = 0, seq = 0;
export function uuidv7() {
  let ms = Date.now();
  if (ms <= lastMs) { ms = lastMs; seq++; } else { lastMs = ms; seq = 0; }
  const b = crypto.randomBytes(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = 0x40 | ((seq >> 8) & 0x0f); b[7] = seq & 0xff;
  b[8] = 0x80 | (b[8] & 0x3f);
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---- sealed store: AES-256-GCM, key file and ciphertext live outside Twenty
let sealKey;
if (fs.existsSync(f("seal.key"))) sealKey = Buffer.from(fs.readFileSync(f("seal.key"), "utf8"), "hex");
else { sealKey = crypto.randomBytes(32); fs.writeFileSync(f("seal.key"), sealKey.toString("hex"), { mode: 0o600 }); }
const seal = (plain, aad) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", sealKey, iv); c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map((x) => x.toString("base64")).join(".");
};
const unseal = (blob, aad) => {
  const [iv, tag, ct] = blob.split(".").map((x) => Buffer.from(x, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", sealKey, iv); d.setAAD(Buffer.from(aad)); d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
};
const SEALED = readJson("sealed.json", {}); // { "<type>/<id>/<field>": blob }
const PLACEHOLDER = "[sealed]";

// ---- event log (append only JSONL)
const event = (e) => { const row = { id: uuidv7(), ts: new Date().toISOString(), ...e }; fs.appendFileSync(f("events.jsonl"), JSON.stringify(row) + "\n"); return row; };

// ---- Twenty client
let KEY = fs.existsSync(f("twenty.key")) ? fs.readFileSync(f("twenty.key"), "utf8").trim() : "";
async function gql(path, query, variables) {
  const r = await fetch(`${TWENTY}/${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error(`twenty ${path}: ${JSON.stringify(j.errors).slice(0, 500)}`);
  return j.data;
}

// ---- the definition compiler: Vyre manifest -> Twenty metadata
const KIND = { text: "TEXT", stage: "SELECT", choice: "SELECT", date: "DATE", number: "NUMBER" };
const camel = (s) => s[0].toLowerCase() + s.slice(1);
const COLORS = ["blue", "turquoise", "purple", "orange", "green", "gray"];
const SCHEMA = readJson("schema.json", {}); // type -> { twentyName, fields: {vyreName: {twenty, kind, sealed}} }

async function define(manifest) {
  const out = [];
  for (const t of manifest.types) {
    const tn = camel(t.name);
    const existing = await gql("metadata", `{objects(paging:{first:200}){edges{node{id nameSingular fields(paging:{first:200}){edges{node{id name}}}}}}}`);
    let obj = existing.objects.edges.map((e) => e.node).find((o) => o.nameSingular === tn);
    if (!obj) {
      const r = await gql("metadata", `mutation($i:CreateOneObjectInput!){createOneObject(input:$i){id nameSingular}}`, { i: { object: { nameSingular: tn, namePlural: camel(t.plural), labelSingular: t.name, labelPlural: t.plural, icon: t.icon || "IconBox" } } });
      obj = { ...r.createOneObject, fields: { edges: [] } }; out.push(`object ${tn} created`);
    }
    const have = new Set(obj.fields.edges.map((e) => e.node.name));
    const map = {};
    for (const fld of t.fields) {
      const tw = fld.primary ? "name" : fld.name;
      map[fld.name] = { twenty: tw, kind: fld.kind, sealed: !!fld.sealed };
      if (fld.primary || have.has(tw)) continue;
      const field = { objectMetadataId: obj.id, type: KIND[fld.kind], name: tw, label: fld.label || tw, isNullable: true };
      if (fld.kind === "stage" || fld.kind === "choice") field.options = fld.choices.map((c, i) => ({ value: c.toUpperCase().replace(/[^A-Z0-9]+/g, "_"), label: c, position: i, color: COLORS[i % COLORS.length] }));
      if (field.options) field.defaultValue = `'${field.options[0].value}'`;
      await gql("metadata", `mutation($i:CreateOneFieldMetadataInput!){createOneField(input:$i){id name}}`, { i: { field } });
      out.push(`field ${tn}.${tw} created`);
    }
    SCHEMA[t.name] = { twentyName: tn, plural: camel(t.plural), fields: map, choices: Object.fromEntries(t.fields.filter((x) => x.choices).map((x) => [x.name, x.choices])) };
  }
  writeJson("schema.json", SCHEMA);
  return out;
}

// ---- record translation
const choiceToTwenty = (c) => c.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
function toTwenty(type, fields) {
  const s = SCHEMA[type]; const o = {};
  for (const [k, v] of Object.entries(fields)) {
    const m = s.fields[k]; if (!m) throw new Error(`unknown field ${type}.${k}`);
    if (m.sealed) o[m.twenty] = PLACEHOLDER; // Twenty never sees the value
    else o[m.twenty] = m.kind === "stage" || m.kind === "choice" ? choiceToTwenty(v) : v;
  }
  return o;
}
const SEL = (type) => Object.values(SCHEMA[type].fields).map((m) => m.twenty).concat(["id", "createdAt", "updatedAt"]).join(" ");
function fromTwenty(type, rec, actor, { reveal } = {}) {
  const s = SCHEMA[type]; const out = { id: rec.id, createdAt: rec.createdAt, updatedAt: rec.updatedAt };
  for (const [k, m] of Object.entries(s.fields)) {
    let v = rec[m.twenty];
    if (m.sealed) {
      const blob = SEALED[`${type}/${rec.id}/${k}`];
      v = !blob ? null : (actor.startsWith("person:") && reveal !== false ? unseal(blob, `${type}/${rec.id}/${k}`) : PLACEHOLDER);
    } else if ((m.kind === "stage" || m.kind === "choice") && v) v = (s.choices[k] || []).find((c) => choiceToTwenty(c) === v) || v;
    out[k] = v;
  }
  return out;
}
const redact = (type, o) => { const r = { ...o }; for (const [k, m] of Object.entries(SCHEMA[type].fields)) if (m.sealed && r[k] != null) r[k] = PLACEHOLDER; return r; };
const SELF = new Map(); // `${id}@${updatedAt}` -> true: writes the gateway itself made

// ---- store interface
async function create(type, fields, actor) {
  const s = SCHEMA[type]; const id = uuidv7();
  const d = { id, ...toTwenty(type, fields) };
  const r = await gql("graphql", `mutation($d:${camel(type).replace(/^./, (c) => c.toUpperCase())}CreateInput!){create${type}(data:$d){${SEL(type)}}}`, { d });
  const rec = r[`create${type}`];
  if (rec.id !== id) throw new Error(`Twenty replaced our id: sent ${id} got ${rec.id}`);
  for (const [k, m] of Object.entries(s.fields)) if (m.sealed && fields[k] != null) SEALED[`${type}/${id}/${k}`] = seal(String(fields[k]), `${type}/${id}/${k}`);
  writeJson("sealed.json", SEALED);
  SELF.set(`${id}@${rec.updatedAt}`, 1);
  const after = fromTwenty(type, rec, "system:", { reveal: false });
  snap(type, after);
  event({ actor, kind: "record.created", ref: `vyre://${type}/${id}`, before: null, after: redact(type, after), source: "gateway" });
  return fromTwenty(type, rec, actor);
}
async function get(type, id, actor) {
  const r = await gql("graphql", `query($id:UUID){${SCHEMA[type].twentyName}(filter:{id:{eq:$id}}){${SEL(type)}}}`, { id });
  const rec = r[SCHEMA[type].twentyName]; if (!rec) return null;
  return fromTwenty(type, rec, actor);
}
async function query(type, where, actor) {
  const s = SCHEMA[type]; const parts = [];
  for (const [k, v] of Object.entries(where || {})) { const m = s.fields[k]; if (m.sealed) throw new Error("cannot filter on a sealed field"); parts.push(`${m.twenty}:{eq:${m.kind === "stage" ? choiceToTwenty(v) : JSON.stringify(v)}}`); }
  const r = await gql("graphql", `{${s.plural}(first:100${parts.length ? `,filter:{${parts.join(",")}}` : ""}){edges{node{${SEL(type)}}}}}`);
  return r[s.plural].edges.map((e) => fromTwenty(type, e.node, actor));
}
async function update(type, id, fields, actor) {
  const before = await get(type, id, "system:"); if (!before) throw new Error("not found");
  const Cap = type;
  const d = toTwenty(type, fields);
  const r = await gql("graphql", `mutation($id:UUID!,$d:${Cap}UpdateInput!){update${Cap}(id:$id,data:$d){${SEL(type)}}}`, { id, d });
  const rec = r[`update${Cap}`];
  for (const [k, m] of Object.entries(SCHEMA[type].fields)) if (m.sealed && fields[k] != null) SEALED[`${type}/${id}/${k}`] = seal(String(fields[k]), `${type}/${id}/${k}`);
  writeJson("sealed.json", SEALED);
  SELF.set(`${id}@${rec.updatedAt}`, 1);
  const after = fromTwenty(type, rec, "system:", { reveal: false });
  snap(type, after);
  event({ actor, kind: "record.updated", ref: `vyre://${type}/${id}`, before: redact(type, before), after: redact(type, after), source: "gateway" });
  return fromTwenty(type, rec, actor);
}

// ---- webhooks from Twenty: only changes the gateway did not make
const HOOK_SECRET = (() => { if (!fs.existsSync(f("hook.secret"))) fs.writeFileSync(f("hook.secret"), crypto.randomBytes(24).toString("hex"), { mode: 0o600 }); return fs.readFileSync(f("hook.secret"), "utf8"); })();
const SNAP = readJson("snap.json", {}); // last state the gateway saw per record (redacted), used as "before" for outside changes
const snap = (type, rec) => { SNAP[`${type}/${rec.id}`] = redact(type, rec); writeJson("snap.json", SNAP); };
function onTwentyWebhook(body, headers) {
  fs.appendFileSync(f("webhook-raw.jsonl"), JSON.stringify(body) + "\n");
  const ts = headers["x-twenty-webhook-timestamp"], sig = headers["x-twenty-webhook-signature"];
  const { secret, ...rest } = body;
  const want = crypto.createHmac("sha256", HOOK_SECRET).update(`${ts}:${JSON.stringify(rest)}`).digest("hex");
  const verified = sig === want;
  if (!verified) { event({ actor: "store:twenty", kind: "webhook.rejected", source: "twenty-webhook", reason: "bad signature" }); return false; }
  const kind = (body.eventName || "").split(".").pop();
  const typeName = Object.keys(SCHEMA).find((t) => SCHEMA[t].twentyName === body.objectMetadata?.nameSingular);
  const rec = body.record || {};
  if (!typeName) { event({ actor: "store:twenty", kind: `record.${kind}`, ref: `twenty://${body.objectMetadata?.nameSingular}/${rec.id}`, before: null, after: null, source: "twenty-webhook", note: "type not in manifest" }); return true; }
  const key = `${rec.id}@${rec.updatedAt}`;
  if (SELF.has(key)) { SELF.delete(key); return true; }
  const after = redact(typeName, fromTwenty(typeName, rec, "system:", { reveal: false }));
  const before = SNAP[`${typeName}/${rec.id}`] || null;
  event({ actor: "store:twenty", kind: `record.${kind}`, ref: `vyre://${typeName}/${rec.id}`, before, after, changed: body.updatedFields, source: "twenty-webhook", by: rec.updatedBy?.source });
  SNAP[`${typeName}/${rec.id}`] = after; writeJson("snap.json", SNAP);
  return true;
}

// ---- HTTP surface (the only thing that leaves the home network)
const send = (res, code, v) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString(); let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch {}
  if (req.url.startsWith("/_twenty")) fs.appendFileSync(f("hook-in.log"), `${req.method} ${req.url} ${JSON.stringify(Object.keys(req.headers))} ${raw.slice(0,3000)}\n`);
  const u = new URL(req.url, "http://x"); const p = u.pathname.split("/").filter(Boolean);
  const actor = req.headers["x-actor"] || "person:alex";
  try {
    if (req.method === "POST" && p[0] === "_twenty" && p[1] === "webhook") { const ok = onTwentyWebhook(body, req.headers); return send(res, ok ? 200 : 401, { ok }); }
    if (req.method === "POST" && p[0] === "_admin" && p[1] === "key") { KEY = body.key; fs.writeFileSync(f("twenty.key"), KEY, { mode: 0o600 }); return send(res, 200, { ok: true }); }
    if (req.method === "POST" && p[0] === "_admin" && p[1] === "webhook") { const r = await gql("metadata", `mutation($i:CreateWebhookInput!){createWebhook(input:$i){id}}`, { i: { targetUrl: process.env.GW_HOOK_URL || "http://gateway:4000/_twenty/webhook", operations: ["*.*"], description: "vyre gateway", secret: HOOK_SECRET } }); return send(res, 200, r); }
    if (req.method === "POST" && p[0] === "define") return send(res, 200, await define(body));
    if (p[0] === "events") return send(res, 200, fs.existsSync(f("events.jsonl")) ? fs.readFileSync(f("events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
    if (p[0] === "records") {
      const type = p[1];
      if (req.method === "POST") return send(res, 201, await create(type, body, actor));
      if (req.method === "GET" && p[2]) return send(res, 200, await get(type, p[2], actor));
      if (req.method === "GET") return send(res, 200, await query(type, Object.fromEntries(u.searchParams), actor));
      if (req.method === "PATCH") return send(res, 200, await update(type, p[2], body, actor));
    }
    send(res, 404, { error: "not found" });
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
}).listen(PORT, "0.0.0.0", () => console.log("gateway up"));
