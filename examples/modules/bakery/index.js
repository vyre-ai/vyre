// @ts-check
// bakery: Northwind Bakery's orders, the daily target and the flour order. The complete example
// of module API 1 (docs/adr/0047-module-contract-v1.md): every tool says who may call it, the flour
// order acts as the person outside and so passes the Gate, and everything else goes through ctx.
//
//   bakery.orders   today's orders (or another day's)
//   bakery.add      record an order; a big one becomes a memory note, the target a push
//   bakery.target   change the daily target: an agent may, only when the person asked
//   bakery.flour    order flour through the supplier's API, with a key the module never sees
//   bakery.today    the Now card: today's items against the target

/** Orders of this many items or more are worth remembering. */
const BIG = 20;

/** Today's date where the bakery is, as the orders table keeps it. */
const today = () => new Date().toLocaleDateString("en-CA");

/** A refusal the caller can act on: an Error with a short lowercase code. @param {string} code @param {string} message */
const refuse = (code, message) => Object.assign(new Error(message), { code });

/** @type {import("@vyre/module-sdk").Module} */
export default {
  async start(ctx) {
    // Forward only: a new column is a new step, never an edit to one that ran.
    ctx.store.migrate([
      "CREATE TABLE bakery_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, customer TEXT NOT NULL, items INTEGER NOT NULL, at INTEGER NOT NULL)",
      "CREATE INDEX bakery_orders_day ON bakery_orders (day)",
    ]);
    const db = ctx.store.db;
    const list = db.prepare("SELECT id, customer, items, at FROM bakery_orders WHERE day = ? ORDER BY id");
    const total = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(items), 0) AS items FROM bakery_orders WHERE day = ?");
    const insert = db.prepare("INSERT INTO bakery_orders (day, customer, items, at) VALUES (?, ?, ?, ?)");
    const target = async () => Number(await ctx.settings.get("bakery.target")) || 40;
    const day = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };

    ctx.tool("bakery.orders", {
      description: "Northwind Bakery's orders for a day, today unless one is named",
      input: { type: "object", properties: { day }, additionalProperties: false },
      examples: [{ input: {} }, { input: { day: "2026-09-30" } }],
      run: ({ day: d = today() } = {}) => {
        const orders = /** @type {any[]} */ (list.all(d));
        return { day: d, count: orders.length, items: orders.reduce((n, o) => n + Number(o.items), 0), orders };
      },
    });

    ctx.tool("bakery.add", {
      description: "Record an order: who it is for and how many items",
      input: { type: "object", required: ["customer", "items"], additionalProperties: false,
        properties: { customer: { type: "string", minLength: 1, maxLength: 80 }, items: { type: "integer", minimum: 1, maximum: 1000 } } },
      examples: [{ input: { customer: "Harlow Legal", items: 24 } }, { input: { customer: "juno", items: 2 } }],
      run: async ({ customer, items }) => {
        const d = today();
        const before = Number(/** @type {any} */ (total.get(d)).items);
        const id = Number(insert.run(d, customer, items, Date.now()).lastInsertRowid);
        // Every module can read the event log, so the event carries no customer's name.
        ctx.events.emit("bakery.order-added", { id, items, big: items >= BIG });
        if (items >= BIG) {
          // source_ref makes a retry one note, not two.
          await ctx.memory.write({ kind: "note", text: `${customer} ordered ${items} items on ${d}.`, subject: customer, source_ref: `bakery:order:${id}` });
        }
        const goal = await target(), after = before + items;
        const reached = before < goal && after >= goal;
        if (reached) {
          // A push is an offer: core/push decides against its daily budget and quiet hours.
          try { await ctx.push.offer({ title: "Daily target reached", body: `${after} items today, over the target of ${goal}.`, kind: "bakery.target" }); }
          catch (e) { ctx.log.warn("push offer failed", { message: /** @type {Error} */ (e).message }); }
        }
        return { id, day: d, items: after, target: goal, reached };
      },
    });

    ctx.tool("bakery.target", {
      description: "Change the daily target, in items",
      input: { type: "object", required: ["target"], additionalProperties: false, properties: { target: { type: "integer", minimum: 1, maximum: 10000 } } },
      examples: [{ input: { target: 50 } }],
      run: async ({ target: next }) => {
        const was = await target();
        await ctx.settings.set("bakery.target", next);
        // Only a declared inverse is ever replayed: setting the old value back.
        await ctx.undo.record({ tool: "bakery.target", input: { target: next }, inverse: { tool: "bakery.target", input: { target: was } } });
        return { target: next, was };
      },
    });

    ctx.tool("bakery.flour", {
      description: "Order flour from the supplier, in kilograms",
      input: { type: "object", required: ["kg"], additionalProperties: false, properties: { kg: { type: "integer", minimum: 1, maximum: 500 } } },
      examples: [{ input: { kg: 25 } }],
      // outward "pay": this only runs after the person tapped it, asked for it, or approved it at
      // the Gate. meta.gate says which. The vault attaches the supplier key in vyred.
      run: async ({ kg }, meta) => {
        const r = await ctx.vault.request("supplier", { method: "POST", url: "https://api.flourco.example/orders", body: { product: "flour", kg } });
        if ("held" in r) return { held: r.held };
        if (r.status >= 400) throw refuse("supplier_refused", `the supplier said ${r.status}`);
        return { ordered: true, kg, status: r.status, cleared: meta.gate || null };
      },
    });

    ctx.tool("bakery.today", {
      description: "The Now card: today's items against the target",
      input: { type: "object", additionalProperties: false },
      examples: [{ input: {} }],
      run: async () => {
        const t = /** @type {any} */ (total.get(today()));
        const goal = await target();
        return { title: "Northwind Bakery", detail: `${t.items} of ${goal} items today`, meta: `${t.count} ${t.count === 1 ? "order" : "orders"}` };
      },
    });

    // An event, not a timer: note when memory kept one of this module's notes.
    const off = ctx.events.on("memory.written", e => {
      const ref = e.payload && e.payload.source_ref;
      if (typeof ref === "string" && ref.startsWith("bakery:")) ctx.log.debug("memory kept a note", { ref });
    });
    return { async stop() { off(); } };
  },
};
