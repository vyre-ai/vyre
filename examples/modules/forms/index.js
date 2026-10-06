// @ts-check
// forms: a public form that files each answer as a lead. Written against the public SDK only: `ctx.tool`, `ctx.events.emit` and `ctx.kernel.records` (declared under needs.kernel.records).
// The page itself is public/form.html (a plain page that posts to the form's webhook route). Nothing here reads the answer's words into an event: the event says only that one arrived.

const refuse = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const text = (/** @type {unknown} */ v, /** @type {number} */ max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** @type {import("@vyre/module-sdk").Module} */
export default {
  async start(ctx) {
    ctx.tool("forms.submit", {
      description: "File one answer from the public form as a lead. Reached only by the form's webhook route, never by a person or an assistant.",
      input: { type: "object", required: ["name", "email"], additionalProperties: false,
        properties: { name: { type: "string", minLength: 1, maxLength: 120 }, email: { type: "string", minLength: 3, maxLength: 200 }, message: { type: "string", maxLength: 2000 } } },
      examples: [{ input: { name: "Dana Reyes", email: "dana@harlow.test", message: "my landlord changed the locks" } }],
      run: async (/** @type {any} */ input) => {
        const name = text(input.name, 120), email = text(input.email, 200), message = text(input.message, 2000);
        if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw refuse("bad_input", "a name and an email address are needed");
        const lead = await ctx.kernel.records.create("lead", { name, email, ...(message ? { message } : {}) });
        await ctx.events.emit("forms.answer-received", { lead: lead.urn });
        return { received: true };
      },
    });
    ctx.tool("forms.leads", {
      description: "The leads the form has filed, newest page first.",
      input: { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 100 } } },
      examples: [{ input: {} }, { input: { limit: 5 } }],
      run: async (/** @type {any} */ { limit = 20 } = {}) => {
        const page = await ctx.kernel.records.list("lead", { limit });
        return { count: page.rows.length, leads: page.rows.map((/** @type {any} */ r) => ({ urn: r.urn, name: r.data.name, email: r.data.email })) };
      },
    });
    return { async stop() {} };
  },
};
