// @ts-check
// docgen: a template plus a record gives a file in the Drive. Written against the public SDK only: `ctx.tool`, `ctx.events.emit`, `ctx.kernel.records` (needs.kernel.records) and `ctx.kernel.files`
// (needs.kernel.files). The template is a `doc_template` record: { name, folder, body } where `{{field}}` in the body is replaced by the record's field of that name. A field the record does not
// have, or one the Space keeps sealed (the module sees only a placeholder), is left as the placeholder: a document never carries a value this module was not allowed to read.

const refuse = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const SAFE = /[^A-Za-z0-9._ -]/g;

/** Fill `{{field}}` with the record's text fields. @param {string} body @param {Record<string, unknown>} data */
export function fill(body, data) {
  return body.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi, (whole, key) => {
    const v = data[key];
    return typeof v === "string" || typeof v === "number" ? String(v) : whole;
  });
}

/** @type {import("@vyre/module-sdk").Module} */
export default {
  async start(ctx) {
    ctx.tool("docgen.make", {
      description: "Fill a template with one record's fields and file the result in the Drive: { template, record, name? } answers { path, version }.",
      input: { type: "object", required: ["template", "record"], additionalProperties: false,
        properties: { template: { type: "string", minLength: 8, maxLength: 300 }, record: { type: "string", minLength: 8, maxLength: 300 }, name: { type: "string", maxLength: 120 } } },
      examples: [{ input: { template: "vyre://test/doc_template/r1", record: "vyre://test/contact/r1", name: "Engagement letter" } }],
      run: async (/** @type {any} */ { template, record, name }) => {
        const tpl = await ctx.kernel.records.get(template);
        if (!tpl) throw refuse("not_found", "no such template");
        const rec = await ctx.kernel.records.get(record);
        if (!rec) throw refuse("not_found", "no such record");
        const folder = String(tpl.data.folder || "").replace(/^\/+|\/+$/g, "");
        if (!folder) throw refuse("bad_input", "the template names no folder");
        const file = String(name || tpl.data.name || "document").replace(SAFE, "-").slice(0, 100).trim() || "document";
        const written = await ctx.kernel.files.write({ path: `${folder}/${file}.txt`, text: fill(String(tpl.data.body || ""), rec.data) });
        await ctx.events.emit("docgen.made", { path: written.path, version: written.version });
        return { path: written.path, version: written.version };
      },
    });
    return { async stop() {} };
  },
};
