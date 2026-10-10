// @ts-check
// design: the design language's keeper (0.3.1, team/0.3.1/DESIGN-design-language-build.md).
//
//   design.catalogue   the block catalogue, in few tokens: index (one line per block), block (one in full), layouts
//   design.validate    a screen against the language: { ok, problems } naming the path and the fix
//   design.propose     an agent's (or the Engineer's) screen for a space screen id, with why. It checks the screen, then keeps it PENDING; nothing changes on a screen until the owner says yes
//   design.proposals   the pending (or decided) proposals, each with the screen it would replace, the new one and what the new one reads and runs
//   design.decide      the person's yes or no. A yes makes the proposal the space's screen (a new version); a no keeps the old one
//   design.screens     the space's own screens, which views.list shows beside the modules' own
//
// Only a person decides. A screen reads data and its buttons run a tool only when the person presses one, through views.act (an outward one previews its exact words first); the proposal
// lists every tool the screen reads and every button runs, so the yes is to a known set.
import { catalogue, validateScreen } from "../../lib/views/blocks.js";
import { lintCss, tokensVersion } from "../../lib/design/css.js";
import { agentName, isPerson } from "../../lib/caller.js";

const MIGRATIONS = [
  `CREATE TABLE design_screens (id TEXT PRIMARY KEY, title TEXT NOT NULL, screen TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE design_proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, screen_id TEXT NOT NULL, title TEXT NOT NULL, screen TEXT NOT NULL, why TEXT NOT NULL, by TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER)`,
  `ALTER TABLE design_proposals ADD COLUMN kind TEXT NOT NULL DEFAULT 'screen'`,
  `CREATE TABLE design_css (scope TEXT PRIMARY KEY, css TEXT NOT NULL, tokens TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, updated_at INTEGER NOT NULL)`,
];
/** Who may call the tools an agent may use: the person's own surfaces, other modules, and a model through the MCP or the harness. The rest default to the person's surfaces. */
const ANYONE = ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "module", "mcp", "harness"];
const ID = /^[a-z][a-z0-9-]{0,30}$/;
const MAX_BYTES = 256 * 1024;

/** Every tool a screen reads and every button runs, as short words for the owner's yes. @param {any} screen */
export function usesOf(screen) {
  /** @type {Set<string>} */ const reads = new Set(), runs = new Set();
  for (const b of Object.values(screen && screen.blocks ? screen.blocks : {})) {
    const blk = /** @type {any} */ (b);
    if (blk && blk.data && blk.data.tool) reads.add(String(blk.data.tool));
    if (blk && blk.data && blk.data.operation) reads.add(`${blk.data.operation.connection}:${blk.data.operation.operation}`);
    if (blk && blk.detail && blk.detail.tool) reads.add(String(blk.detail.tool));
    for (const a of Array.isArray(blk && blk.actions) ? blk.actions : []) if (a && a.tool) runs.add(String(a.tool));
  }
  for (const f of Object.values(screen && screen.forms ? screen.forms : {})) { const t = /** @type {any} */ (f)?.submit?.tool; if (t) runs.add(String(t)); }
  return { reads: [...reads].sort(), runs: [...runs].sort() };
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    /** @param {any} r */
    const screenOf = r => r && ({ id: String(r.id), title: String(r.title), screen: JSON.parse(String(r.screen)), version: Number(r.version), updatedAt: Number(r.updated_at) });
    /** @param {any} r */
    const proposalOf = r => {
      if (r.kind === "css") {
        const cur = /** @type {any} */ (db.prepare("SELECT css FROM design_css WHERE scope = ?").get(r.screen_id));
        return { id: Number(r.id), kind: "css", screenId: String(r.screen_id), title: String(r.title), why: String(r.why), by: String(r.by), status: String(r.status), createdAt: Number(r.created_at), after: JSON.parse(String(r.screen)).css, before: cur ? String(cur.css) : null, uses: { reads: [], runs: [] }, appliesTo: "web" };
      }
      const after = JSON.parse(String(r.screen));
      const cur = screenOf(db.prepare("SELECT * FROM design_screens WHERE id = ?").get(r.screen_id));
      return { id: Number(r.id), kind: "screen", screenId: String(r.screen_id), title: String(r.title), why: String(r.why), by: String(r.by), status: String(r.status), createdAt: Number(r.created_at), after, before: cur ? cur.screen : null, uses: usesOf(after) };
    };

    ctx.tool("design.catalogue", {
      callers: ANYONE,
      description: "The design language's blocks, small: an index, one block in full with a sample, or the layout words and limits. Pick with level.",
      input: { type: "object", properties: { level: { type: "string", enum: ["index", "block", "layouts"], description: "index (default): one line per block; block: the block named by type, in full; layouts: layout words and limits" }, type: { type: "string", maxLength: 40, description: "the block type, for level block" } } },
      run: async (/** @type {any} */ i) => ({ text: catalogue(i.level || "index", i.type) }),
    });
    ctx.tool("design.validate", {
      callers: ANYONE,
      description: "Check a screen against the design language: { ok, problems }. Each problem names the path and the fix. Run it before design.propose.",
      input: { type: "object", required: ["screen"], properties: { screen: { type: "object" } } },
      run: async (/** @type {any} */ i) => { const problems = validateScreen(i.screen); return { ok: problems.length === 0, problems: problems.slice(0, 12), ...(problems.length > 12 ? { more: problems.length - 12 } : {}) }; },
    });
    ctx.tool("design.propose", {
      callers: ANYONE,
      description: "Propose a screen. It is checked and kept pending until its owner says yes. Returns { proposal } or { problems }.",
      input: { type: "object", required: ["id", "screen", "why"], properties: { id: { type: "string", description: "a word like \"orders\": lowercase letters, digits, dashes" }, title: { type: "string", maxLength: 60 }, screen: { type: "object" }, why: { type: "string", maxLength: 500 } } },
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        if (!ID.test(String(i.id))) throw Object.assign(new Error("id must be lowercase letters, digits and dashes, like \"orders\""), { code: "bad_input" });
        const problems = validateScreen(i.screen);
        if (problems.length) return { problems: problems.slice(0, 12), ...(problems.length > 12 ? { more: problems.length - 12 } : {}) };
        if (Buffer.byteLength(JSON.stringify(i.screen)) > MAX_BYTES) throw Object.assign(new Error("that screen is too large"), { code: "bad_input" });
        const title = String(i.title || i.screen.title || i.id).slice(0, 60);
        const by = String((meta && meta.caller) || "agent").slice(0, 80);
        const r = db.prepare("INSERT INTO design_proposals (screen_id, title, screen, why, by, status, created_at) VALUES (?,?,?,?,?,?,?)").run(String(i.id), title, JSON.stringify(i.screen), String(i.why).slice(0, 500), by, "pending", Date.now());
        const proposal = proposalOf(db.prepare("SELECT * FROM design_proposals WHERE id = ?").get(Number(r.lastInsertRowid)));
        ctx.events.emit("design.proposed", { id: proposal.id, screen: proposal.screenId, by });
        return { proposal: { id: proposal.id, status: proposal.status, replaces: Boolean(proposal.before), uses: proposal.uses } };
      },
    });
    ctx.tool("design.proposals", {
      description: "The proposals to change the space's screens, newest first, each with the screen it would replace (before), the new one (after), why and what it reads and runs.",
      input: { type: "object", properties: { status: { type: "string", enum: ["pending", "accepted", "rejected"] } } },
      run: async (/** @type {any} */ i) => ({ proposals: db.prepare(`SELECT * FROM design_proposals ${i.status ? "WHERE status = ?" : ""} ORDER BY id DESC LIMIT 50`).all(...(i.status ? [String(i.status)] : [])).map(proposalOf) }),
    });
    ctx.tool("design.decide", {
      description: "The owner's answer to a proposal. yes makes it the space's screen (a new version); no keeps what was there. Only a person answers.",
      input: { type: "object", required: ["id", "yes"], properties: { id: { type: "integer" }, yes: { type: "boolean" } } },
      run: async (/** @type {any} */ i) => {
        const row = /** @type {any} */ (db.prepare("SELECT * FROM design_proposals WHERE id = ?").get(Number(i.id)));
        if (!row) throw Object.assign(new Error("no such proposal (design.proposals lists them)"), { code: "not_found" });
        if (row.status !== "pending") throw Object.assign(new Error(`that proposal is already ${row.status}; design.proposals shows the ones still waiting`), { code: "conflict" });
        const now = Date.now();
        db.prepare("UPDATE design_proposals SET status = ?, decided_at = ? WHERE id = ?").run(i.yes ? "accepted" : "rejected", now, row.id);
        if (!i.yes) return { status: "rejected" };
        if (row.kind === "css") {
          const css = JSON.parse(String(row.screen)).css;
          // The stylesheet is checked again at the yes: the tokens may have moved since it was proposed.
          const again = lintCss(css, { scope: String(row.screen_id) });
          if (!again.ok) { db.prepare("UPDATE design_proposals SET status = 'rejected' WHERE id = ?").run(row.id); throw Object.assign(new Error(`that stylesheet no longer passes: ${again.problems[0]}`), { code: "bad_input" }); }
          db.prepare("INSERT INTO design_css (scope, css, tokens, status, reason, updated_at) VALUES (?,?,?,?,NULL,?) ON CONFLICT(scope) DO UPDATE SET css = excluded.css, tokens = excluded.tokens, status = 'on', reason = NULL, updated_at = excluded.updated_at").run(String(row.screen_id), css, tokensVersion(), "on", now);
          ctx.events.emit("design.changed", { css: String(row.screen_id) });
          return { status: "accepted", css: String(row.screen_id), appliesTo: "web" };
        }
        const cur = /** @type {any} */ (db.prepare("SELECT version FROM design_screens WHERE id = ?").get(row.screen_id));
        const version = cur ? Number(cur.version) + 1 : 1;
        db.prepare("INSERT INTO design_screens (id, title, screen, version, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, screen = excluded.screen, version = excluded.version, updated_at = excluded.updated_at")
          .run(row.screen_id, row.title, row.screen, version, now);
        ctx.events.emit("design.changed", { screen: row.screen_id, version });
        return { status: "accepted", screen: row.screen_id, version };
      },
    });
    ctx.tool("design.screens", {
      callers: ANYONE,
      description: "The space's own screens: [{ id, title, screen, version, updatedAt }]. views.list shows them as views of the module \"space\".",
      input: { type: "object", properties: {} },
      run: async () => ({ screens: db.prepare("SELECT * FROM design_screens ORDER BY id").all().map(screenOf) }),
    });
    ctx.tool("design.screen.remove", {
      description: "Take one of the space's own screens away. Only a person does.",
      input: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      run: async (/** @type {any} */ i) => { const r = db.prepare("DELETE FROM design_screens WHERE id = ?").run(String(i.id)); if (r.changes) ctx.events.emit("design.changed", { screen: String(i.id), removed: true }); return { removed: Number(r.changes) > 0 }; },
    });
    // Custom styling (R031-61): only the Engineer (or the person) writes it, the owner says yes with before and after, it is checked again at every start, and CSS that breaks is turned off with a reason.
    ctx.tool("design.css.propose", {
      callers: ANYONE,
      description: "Propose custom CSS for the space or one screen. Only the Engineer proposes it; the owner sees it before and after. Web app only.",
      input: { type: "object", required: ["scope", "css", "why"], properties: { scope: { type: "string", description: "space, or screen:<id>" }, css: { type: "string", maxLength: 9000, description: "Must pass the linter: hooks [data-screen] and [data-block], design tokens only. Phones and Lumen keep the tokens" }, why: { type: "string", maxLength: 500 } } },
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const who = agentName(meta);
        if (who !== "engineer" && !isPerson(meta)) throw Object.assign(new Error("custom styling goes through the Engineer: ask @Engineer"), { code: "denied" });
        const scope = String(i.scope);
        if (scope !== "space" && !/^screen:[a-z][a-z0-9-]{0,30}$/.test(scope)) throw Object.assign(new Error('scope is "space" or "screen:<id>"'), { code: "bad_input" });
        const lint = lintCss(String(i.css), { scope });
        if (!lint.ok) return { problems: lint.problems };
        const by = String((meta && meta.caller) || "agent").slice(0, 80);
        const r = db.prepare("INSERT INTO design_proposals (screen_id, title, screen, why, by, status, created_at, kind) VALUES (?,?,?,?,?,?,?,?)").run(scope, `Styling: ${scope}`.slice(0, 60), JSON.stringify({ css: String(i.css) }), String(i.why).slice(0, 500), by, "pending", Date.now(), "css");
        ctx.events.emit("design.proposed", { id: Number(r.lastInsertRowid), css: scope, by });
        return { proposal: { id: Number(r.lastInsertRowid), status: "pending", appliesTo: "web", note: "This styles the web app. Phones and Lumen keep the design tokens only." } };
      },
    });
    ctx.tool("design.css", {
      callers: ANYONE,
      description: "The custom CSS in force: [{ scope, css }] (only what is on). The web app draws it; nothing else needs it.",
      input: { type: "object", properties: {} },
      run: async () => ({ css: db.prepare("SELECT scope, css FROM design_css WHERE status = 'on' ORDER BY scope").all().map((/** @type {any} */ r) => ({ scope: String(r.scope), css: String(r.css) })) }),
    });
    ctx.tool("design.css.status", {
      description: "Every custom CSS with whether it is on, and when it was turned off, why.",
      input: { type: "object", properties: {} },
      run: async () => ({ css: db.prepare("SELECT scope, status, reason, updated_at FROM design_css ORDER BY scope").all().map((/** @type {any} */ r) => ({ scope: String(r.scope), status: String(r.status), reason: r.reason == null ? null : String(r.reason), updatedAt: Number(r.updated_at) })) }),
    });
    /** Check every stylesheet again: lint, and the tokens it was verified against. One that fails is turned off with the reason, and the screen draws as if it were not there. */
    const verify = () => {
      const now = tokensVersion(), turned = [];
      for (const r of /** @type {any[]} */ (db.prepare("SELECT * FROM design_css WHERE status = 'on'").all())) {
        const lint = lintCss(String(r.css), { scope: String(r.scope) });
        const why = lint.ok ? "" : lint.problems[0];
        if (why) { db.prepare("UPDATE design_css SET status = 'off', reason = ?, updated_at = ? WHERE scope = ?").run(String(why).slice(0, 200), Date.now(), r.scope); turned.push(String(r.scope)); ctx.events.emit("design.css-disabled", { scope: String(r.scope), reason: String(why).slice(0, 200) }); }
        else if (r.tokens !== now) db.prepare("UPDATE design_css SET tokens = ? WHERE scope = ?").run(now, r.scope);
      }
      return turned;
    };
    ctx.tool("design.css.verify", {
      description: "Check every custom CSS again (it also runs at every start). One that no longer passes is turned off with the reason; returns the scopes turned off.",
      input: { type: "object", properties: {} },
      run: async () => ({ off: verify() }),
    });
    verify();
    return { async stop() {} };
  },
};
