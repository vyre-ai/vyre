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
import { documentRow } from "./record.js";

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

  tool("documents.template.add", "Put a Word template in the Drive as Templates/<name>.docx, a new version if the name exists: { name, base64 }. Answers its placeholders.",
    obj({ space: str, name: str, base64: str }, ["name", "base64"]), async (i, d) => {
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

  tool("documents.generate", "Fill a template with values and records, and file the document: { template, values?, records?, project?, contact?, format? }. A missing value stops it, named.",
    obj({ space: str, template: str, values: { type: "object" }, records: { type: "object" }, name: str, project: str, contact: str, format: { type: "string", enum: ["docx", "pdf"] }, version: { type: "integer" } }, ["template"]), async (i, d) => {
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
      const out = format === "pdf" ? await toPdf(buffer, { url: cfg().pdf || process.env.VYRE_DOCUMENTS_PDF }) : buffer;
      const sha256 = crypto.createHash("sha256").update(out).digest("hex");
      const scope = i.project ? SLUG(String(i.project)) : "general";
      const title = String(i.name || tname).replace(/\s+/g, " ").trim().slice(0, 100);
      const path = pathOf(`Documents/${scope}/${SLUG(title)}-${sha256.slice(0, 8)}.${format}`);
      if (out.length > 8 * 1024 * 1024) throw refuse("the document is more than 8 MB; it was not filed", "too_large");
      const put = await d.gateway.drive.put(d.chain, path, new Uint8Array(out), { base: null });
      const rec = await filed(d, { name: title, status: "Draft", template: tname, template_version: tver, file: path, sha256, source: "generated", ...(i.contact ? { contact: String(i.contact) } : {}), ...(i.project ? { project: String(i.project) } : {}) });
      ctx.events.emit("documents.generated", { path, format, template: tname, template_version: tver, record: rec || null });
      return { path, version: put.version, size: out.length, sha256, format, template: tname, template_version: tver, used, ...(rec ? { record: rec } : { record: null, note: "no Document record type here yet: install Documents from Apps to file these on the client" }) };
    });

  ctx.tool("documents.signed-link", {
    description: "A link to a signed copy that stops working after 30 days: { slug, days? }. Whoever holds the link can open the file.",
    input: obj({ space: str, slug: str, days: { type: "integer" } }, ["slug"]),
    callers: CALLERS, effect: "write",
    run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      await door.open(i || {}, meta);
      const slug = String(i.slug || "");
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(slug)) throw refuse("slug is the signer's code from the signing request", "bad_input");
      const r = await ctx.call("appmods.signed.link", { name: "documents", slug, ...(i.days !== undefined ? { days: i.days } : {}) });
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code || "failed" });
      return r.data;
    },
  });

  /** One tool of another module, its refusal made ours. */
  const use = async (/** @type {string} */ tool, /** @type {any} */ input) => {
    const r = await ctx.call(tool, input);
    if (r && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code || "failed" });
    return r.data;
  };
  const address = (/** @type {any} */ i) => { const e = String(i.email || "").trim(); if (!e) throw refuse("email is the signer's address, such as dana@example.com", "bad_input"); return e; };

  ctx.tool("documents.send", {
    description: "Send a document for signature: { template_id, email, signer?, subject?, note? }. Makes the signing request and emails the signer their link; one yes.",
    input: obj({ space: str, template_id: { type: "integer" }, email: str, signer: str, subject: str, note: str }, ["template_id", "email"]),
    callers: CALLERS, effect: "write",
    run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      await door.open(i || {}, meta);
      const email = address(i);
      const text = String(i.note || "").trim();
      if (text.length > 1000) throw refuse("the note is at most 1000 characters", "bad_input");
      const note = text ? `${text}\n\n` : "";
      const asked = await use("appmods.signing.request", { name: "documents", template_id: i.template_id, email, ...(i.signer ? { signer: String(i.signer) } : {}) })
        .catch((/** @type {any} */ e) => { throw e && e.code === "not_found" ? refuse("Documents is not running on this server: install or start it from Apps, then send again", "unavailable") : e; });
      const sent = await use("comms.send", { via: "email", to: email, subject: String(i.subject || "Your document is ready to sign"), body: `${note}Your document is ready to sign: ${asked.url}`, why: "signing request" });
      ctx.events.emit("documents.sent", { submission: asked.submission, template_id: i.template_id });
      return { ...asked, sent };
    },
  });

  ctx.tool("documents.send-signed", {
    description: "Email the signer their signed copy: { slug, email, days? }. Makes the expiring link and emails it; one yes covers both.",
    input: obj({ space: str, slug: str, email: str, days: { type: "integer" } }, ["slug", "email"]),
    callers: CALLERS, effect: "write",
    run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      await door.open(i || {}, meta);
      const email = address(i), slug = String(i.slug || "");
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(slug)) throw refuse("slug is the signer's code from the signing request", "bad_input");
      const link = await use("appmods.signed.link", { name: "documents", slug, ...(i.days !== undefined ? { days: i.days } : {}) });
      const days = Math.max(1, Math.round((link.expires - Date.now()) / 86_400_000));
      const sent = await use("comms.send", { via: "email", to: email, subject: "Your signed copy", body: `Thank you for signing. Your signed copy is here, and the link works for ${days} days (reply if you need a new one): ${link.url}`, why: "signed copy" });
      ctx.events.emit("documents.copy-sent", { days });
      return { ...link, sent };
    },
  });

  ctx.tool("documents.signing.flow", {
    description: "The Flow that signs a document from a stage: { type, out_stage, signed_stage, template_id, email_field?, name_field?, submission_field?, wait_days?, subject? }. Creates nothing.",
    input: obj({ type: str, out_stage: str, signed_stage: str, template_id: { type: "integer" }, email_field: str, name_field: str, submission_field: str, wait_days: { type: "integer" }, subject: str }, ["type", "out_stage", "signed_stage", "template_id"]),
    callers: CALLERS, effect: "read",
    run: async (/** @type {any} */ i) => ({ flow: signingFlow(i || {}) }),
  });

  /** The Document record, when the Space has that type; null when it does not (the file is filed all the same). */
  async function filed(/** @type {any} */ d, /** @type {Record<string, any>} */ data) {
    let defs;
    try { defs = (await d.gateway.definitions(d.chain)) || []; } catch { return null; }
    const t = defs.find((/** @type {any} */ x) => x.name === "document");
    if (!t) return null;
    const project = async (/** @type {string} */ ref) => { const r = await ctx.call("work.project.ref", { project: ref }); return r && !r.error && r.data && typeof r.data.urn === "string" ? r.data.urn : null; };
    const row = await documentRow(t.fields || [], data, { space: String(ctx.kernel.space), project });
    const r = await d.gateway.records.create(d.chain, "document", row);
    return r && (r.urn || r.id || (r.record && (r.record.urn || r.record.id))) || null;
  }
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default { async start(ctx) { registerDocuments(ctx); return { async stop() {} }; } };
