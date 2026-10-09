// @ts-check
// documents: make a document from a template and a record (R032-01) and file it (R032-03). One job: Flows orchestrate, Documents generates and files, Comms delivers.
//
//   Templates are Word files in the Space's Drive under Templates/<name>.docx; the Drive keeps every version, and a document remembers which version made it.
//   documents.generate fills one from values (and the fields of records named by their references), refuses with the name of every value that is missing, and files the result: the file in the
//   Drive (under Documents/<project>/), and a Document record linked to the client and the project when the Space has that record type. Every call is the CALLER'S own chain in the Space
//   (lib/gateway-door.js): a call that proved no person is refused, and the kernel's grants decide what may be read and written.
import crypto from "node:crypto";
import { createDoor } from "../../lib/gateway-door.js";
import { safePath } from "../../kernel/seal/uses.js";
import { segments } from "../../kernel/core/urn.js";
import { fill, placeholders, MAX_BYTES } from "./fill.js";
import { toPdf } from "./pdf.js";
import { signingFlow } from "./signing.js";

const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });
const str = { type: "string" };
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const CALLERS = ["cli", "local", "deck", "capsule", "mobile", "device", "module", "mcp", "harness"];
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,80}$/;
const SLUG = (/** @type {string} */ s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "document";

/**
 * Register the Documents tools. Exported for the tests, which hand in a ctx with a stand-in kernel.
 * @param {any} ctx
 */
export function registerDocuments(ctx) {
  const door = createDoor(ctx);
  const cfg = (/** @type {any} */ () => (ctx.config && ctx.config.documents) || {});
  /** @param {string} name @param {string} description @param {any} input @param {(i: any, d: any) => Promise<any>} fn @param {any} [more] */
  const tool = (name, description, input, fn, more = {}) => ctx.tool(name, { description, input, callers: CALLERS, ...more, run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
    const d = await door.open(i || {}, meta);
    if (!d.gateway.drive) throw refuse("this Space has no Drive yet", "unavailable");
    return fn(i || {}, d);
  } });
  const pathOf = (/** @type {string} */ p) => { try { return safePath(p); } catch { throw refuse("that is not a path in the Drive", "bad_input"); } };
  const nameOf = (/** @type {any} */ n) => { const s = String(n ?? "").trim(); if (!NAME.test(s)) throw refuse("a template name is letters, numbers, spaces, dots, dashes and underscores (up to 81)", "bad_input"); return s; };
  const templatePath = (/** @type {string} */ n) => pathOf(`Templates/${n}.docx`);
  /** The newest version number of a Drive file, or 0. */
  const latest = async (/** @type {any} */ d, /** @type {string} */ p) => { try { const h = await d.gateway.drive.history(d.chain, p); const v = Array.isArray(h) ? h : h && h.versions; return v && v.length ? Number(v[v.length - 1].ver) : 0; } catch (e) { if (/** @type {any} */ (e).code === "not_found") return 0; throw e; } };

  tool("documents.template.add", "Save a Word template in the Space's Drive as Templates/<name>.docx, a new version if the name exists. Answers its {placeholders}.",
    obj({ space: str, name: str, base64: { type: "string", description: `the file's bytes, standard base64, at most ${MAX_BYTES / 1048576} MB` } }, ["name", "base64"]), async (i, d) => {
      const name = nameOf(i.name), text = String(i.base64 ?? "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) throw refuse("base64 is the file's bytes, standard base64", "bad_input");
      if (Math.floor(text.length / 4) * 3 > MAX_BYTES + 3) throw refuse(`a template is at most ${MAX_BYTES / 1048576} MB`, "too_large");
      const bytes = Buffer.from(text, "base64");
      const p = placeholders(bytes);
      const r = await d.gateway.drive.put(d.chain, templatePath(name), new Uint8Array(bytes), { base: null });
      return { name, version: r.version, placeholders: p.names, loops: p.loops, loopFields: p.loopFields };
    });

  tool("documents.template.list", "The Word templates in the Space's Drive: { templates: [{ name, size }] }.", obj({ space: str }), async (_i, d) => {
    const out = [];
    let after = null;
    do {
      const r = await d.gateway.drive.listPage(d.chain, "Templates/", { limit: 500, after });
      for (const e of r.entries || []) { const m = /^Templates\/([^/]+)\.docx$/.exec(String(e.path || e.name || "")); if (m) out.push({ name: m[1], size: e.size ?? null }); }
      after = r.next || null;
    } while (after && out.length < 2000);
    return { templates: out };
  }, { effect: "read" });

  tool("documents.template.get", "One template and what it asks for: { name, version?, space? } -> { name, version, placeholders, loops }.", obj({ space: str, name: str, version: { type: "integer" } }, ["name"]), async (i, d) => {
    const name = nameOf(i.name), p = templatePath(name);
    const version = i.version ?? (await latest(d, p));
    if (!version) throw refuse(`no template named ${name}`, "not_found");
    const bytes = Buffer.from(await d.gateway.drive.get(d.chain, p, { version, maxBytes: MAX_BYTES }));
    return { name, version, ...(({ names, loops, loopFields }) => ({ placeholders: names, loops, loopFields }))(placeholders(bytes)) };
  }, { effect: "read" });

  tool("documents.generate", "Make a document from a template, values and records, and file it in the Drive. A missing value stops it and names every one.",
    obj({ space: str, template: str, values: { type: "object", description: "fills the {placeholders}" }, records: { type: "object", description: "alias to record reference; its fields fill {alias.field}" }, name: str, project: { type: "string", description: "files under Documents/<project>/ and links the Document record" }, contact: { type: "string", description: "links the Document record to this contact" }, format: { type: "string", enum: ["docx", "pdf"] }, version: { type: "integer" } }, ["template"]), async (i, d) => {
      const tname = nameOf(i.template), tpath = templatePath(tname);
      const tver = i.version ?? (await latest(d, tpath));
      if (!tver) throw refuse(`no template named ${tname}`, "not_found");
      const tbytes = Buffer.from(await d.gateway.drive.get(d.chain, tpath, { version: tver, maxBytes: MAX_BYTES }));
      /** @type {Record<string, any>} */ const values = { ...(i.values && typeof i.values === "object" && !Array.isArray(i.values) ? i.values : {}) };
      // Records named by reference give their fields under their alias, read under the caller's own grants. One the caller may not see is missing, and said so.
      for (const [alias, urn] of Object.entries(i.records && typeof i.records === "object" ? i.records : {})) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(alias)) throw refuse(`${alias} is not a name a placeholder can use`, "bad_input");
        const s = segments(String(urn));
        if (!s || s.length !== 3) throw refuse(`${alias}: that is not a record reference`, "bad_input");
        const rec = await d.gateway.records.get(d.chain, s[1], s[2]);
        if (!rec) throw refuse(`${alias}: the record is not there, or is not yours to see`, "not_found");
        values[alias] = rec.data || {};
      }
      const { buffer, used } = fill(tbytes, values);
      const format = i.format === "pdf" ? "pdf" : "docx";
      const out = format === "pdf" ? await toPdf(buffer, { url: cfg().pdf }) : buffer;
      const sha256 = crypto.createHash("sha256").update(out).digest("hex");
      const scope = i.project ? SLUG(String(i.project)) : "general";
      const title = String(i.name || tname).replace(/\s+/g, " ").trim().slice(0, 100);
      const path = pathOf(`Documents/${scope}/${SLUG(title)}-${sha256.slice(0, 8)}.${format}`);
      if (out.length > 8 * 1024 * 1024) throw refuse("the document is more than 8 MB; it was not filed", "too_large");
      const put = await d.gateway.drive.put(d.chain, path, new Uint8Array(out), { base: null });
      const rec = await filed(d, { name: title, status: "Draft", template: tname, template_version: tver, file: path, sha256, source: "generated", ...(i.contact ? { contact: String(i.contact) } : {}), ...(i.project ? { project: String(i.project) } : {}) });
      return { path, version: put.version, size: out.length, sha256, format, template: tname, template_version: tver, used, ...(rec ? { record: rec } : { record: null, note: "no Document record type here yet: install Documents from Apps to file these on the client" }) };
    });

  ctx.tool("documents.signing.flow", {
    description: "Build the Flow definition that sends a document for signature when a record enters a stage. Creates nothing: define it with the Flows tools.",
    input: obj({ type: str, out_stage: { type: "string", description: "entering it asks for the signature and emails the signer their link, held for your yes" }, signed_stage: { type: "string", description: "the record moves here once signed" }, template_id: { type: "integer" }, base: str, email_field: str, name_field: str, submission_field: str, wait_days: { type: "integer" }, subject: str }, ["type", "out_stage", "signed_stage", "template_id", "base"]),
    callers: CALLERS, effect: "read",
    run: async (/** @type {any} */ i) => ({ flow: signingFlow(i || {}) }),
  });

  /** The Document record, when the Space has that type; null when it does not (the file is filed all the same). */
  async function filed(/** @type {any} */ d, /** @type {Record<string, any>} */ data) {
    let defs;
    try { defs = (await d.gateway.definitions(d.chain)) || []; } catch { return null; }
    const t = defs.find((/** @type {any} */ x) => x.name === "document");
    if (!t) return null;
    const known = new Set((t.fields || []).map((/** @type {any} */ f) => f.name));
    const row = Object.fromEntries(Object.entries(data).filter(([k]) => known.has(k)));
    const r = await d.gateway.records.create(d.chain, "document", row);
    return r && (r.urn || r.id || (r.record && (r.record.urn || r.record.id))) || null;
  }
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default { async start(ctx) { registerDocuments(ctx); return { async stop() {} }; } };
