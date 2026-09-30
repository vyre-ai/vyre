// Frozen fixture, module contract 1.0 (test/fixtures/modules/v1.0/README.md). Never edit; add a
// new folder for a new contract minor.
//
// matters: Harlow Legal's open matters, counted by practice area.

/** @param {string} code @param {string} message */
const refuse = (code, message) => Object.assign(new Error(message), { code });

export default {
  async start(ctx) {
    ctx.store.migrate(["CREATE TABLE matters_open (id INTEGER PRIMARY KEY AUTOINCREMENT, area TEXT NOT NULL, title TEXT NOT NULL)"]);
    const db = ctx.store.db;

    ctx.tool("matters.count", {
      description: "How many matters are open, by practice area",
      input: { type: "object", properties: {} },
      examples: [{ input: {} }],
      run: () => {
        const rows = db.prepare("SELECT area, COUNT(*) AS n FROM matters_open GROUP BY area ORDER BY area").all();
        return { total: rows.reduce((t, r) => t + Number(r.n), 0), areas: rows.map(r => ({ area: r.area, open: Number(r.n) })) };
      },
    });

    ctx.tool("matters.open", {
      description: "Open a matter",
      input: { type: "object", required: ["title"], properties: { title: { type: "string", minLength: 1 }, area: { type: "string" } } },
      examples: [{ input: { title: "Northwind Bakery lease" } }, { input: { title: "alex, will", area: "estate" } }],
      run: async ({ title, area }) => {
        const a = area || String(await ctx.settings.get("matters.area"));
        const id = Number(db.prepare("INSERT INTO matters_open (area, title) VALUES (?, ?)").run(a, title).lastInsertRowid);
        ctx.events.emit("matters.opened", { id, area: a });
        return { id, area: a };
      },
    });

    ctx.tool("matters.close", {
      description: "Close a matter by its id",
      input: { type: "object", required: ["id"], properties: { id: { type: "integer", minimum: 1 } } },
      examples: [{ input: { id: 1 } }],
      run: ({ id }) => {
        const n = Number(db.prepare("DELETE FROM matters_open WHERE id = ?").run(id).changes);
        if (!n) throw refuse("not_found", `no open matter ${id}`);
        return { closed: id };
      },
    });

    return { async stop() {} };
  },
};
