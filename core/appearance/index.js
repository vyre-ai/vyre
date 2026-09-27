// @ts-check
// appearance: the theme and the design tokens as hub values (ADR 0033, section 3, "One hub").
//
// It declares two settings in module.json, group "appearance":
//   appearance.theme   system | dark | paper, kept by the settings module like any plain key.
//   appearance.tokens  the person's partial tokens.json, kept here, behind this module's own tools
//                      (a tool store, core/config/settings.js), so every write is checked first:
//                      appearance.tokens.set refuses, naming each problem, any override that
//                      lib/theme's applyOverride and check reject (a group outside ALLOWED, a key
//                      the tokens lack, the attention role reused, the status model, a text pair
//                      under AA, the focus ring under 3:1, text under 12, a target under 44).
//
// Surfaces read appearance.resolve (or GET /v1/appearance/theme, the same answer): the theme, the
// merged tokens, their custom properties for dark and paper, and a short version. They repaint on
// appearance.changed, which this module emits after every change to either key, however it came.
//
// The older config.theme.colors is folded in for one release (lib/theme fromLegacy): under the
// person's tokens, only when the result still keeps every rule. GET /theme.css in vyred still
// serves it as before.
//
// Switched off, the two keys leave the settings list, the route answers 404, and every surface
// keeps the shipped tokens it already has. Nothing else depends on this module.

import * as theme from "../../lib/theme/index.js";
import * as config from "../config/index.js";

const MIGRATIONS = [
  `CREATE TABLE appearance_tokens (scope TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL)`,
];
const PEOPLE = ["cli", "local", "deck", "capsule"];
const THEMES = ["system", "dark", "paper"];
const HEAD = "Vyre's design tokens from appearance.tokens (the appearance module).";

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const shipped = theme.tokens();

    /** The person's stored override, or undefined. */
    const stored = () => {
      const row = /** @type {any} */ (db.prepare("SELECT value FROM appearance_tokens WHERE scope = 'account'").get());
      return row ? JSON.parse(String(row.value)) : undefined;
    };

    /**
     * The shipped tokens with config.theme.colors folded in, when there are any and the result
     * keeps every rule. Read on each call, so a changed config.json needs no restart.
     */
    const ground = () => {
      let colors;
      try { colors = (config.load(ctx.paths.root).theme || {}).colors; } catch { colors = undefined; }
      if (!colors || typeof colors !== "object") return { base: shipped, legacy: null };
      const { override, unknown } = theme.fromLegacy(colors, shipped);
      const { tokens, problems } = theme.applyOverride(shipped, override);
      return problems.length ? { base: shipped, legacy: { applied: false, unknown, problems } }
        : { base: tokens, legacy: { applied: true, unknown, problems: [] } };
    };

    /** An override checked over the ground it will be merged onto. @param {any} override */
    const checkOver = override => {
      const { base } = ground();
      if (override === undefined || override === null) return { ok: true, problems: [], tokens: base };
      const { tokens, problems } = theme.applyOverride(base, override);
      return { ok: !problems.length, problems, tokens };
    };

    /** The theme in effect: the hub's value, or the default when the settings module is off. */
    const currentTheme = async () => {
      const r = await ctx.call("settings.get", { key: "appearance.theme" });
      const v = r && r.data && r.data.value;
      return THEMES.includes(v) ? v : "system";
    };

    const resolve = async () => {
      const { base, legacy } = ground();
      const own = stored();
      let tokens = base, problems = /** @type {string[]} */ ([]);
      if (own !== undefined) {
        // Checked when it was saved; checked again here, since the legacy colours under it may
        // have changed since. A set that no longer holds is left out, never half applied.
        const r = theme.applyOverride(base, own);
        if (r.problems.length) problems = r.problems; else tokens = r.tokens;
      }
      return {
        theme: await currentTheme(), tokens, css: theme.css(tokens, HEAD), version: theme.version(tokens),
        ...(legacy ? { legacy } : {}), ...(problems.length ? { problems } : {}),
      };
    };

    const changed = async () => {
      try { const r = await resolve(); ctx.events.emit("appearance.changed", { version: r.version, theme: r.theme }); }
      catch (e) { ctx.log(`appearance.changed not sent: ${/** @type {Error} */ (e).message}`); }
    };

    ctx.tool("appearance.check", {
      description: "Check a theme override (a partial tokens.json) without saving it: ok, and each problem by name (a group or key that may not change, a text pair under AA, the focus ring under 3:1, the attention colour reused, text under 12, a target under 44, an empty font).",
      input: { type: "object", required: ["override"], properties: { override: {} } },
      run: async i => {
        const { ok, problems } = checkOver(i.override);
        return { ok, problems };
      },
    });

    ctx.tool("appearance.resolve", {
      description: "The theme in effect (system, dark or paper), the full merged design tokens, their CSS custom properties for dark and paper, and a short version that changes when the tokens do. Surfaces paint from this and read it again on appearance.changed.",
      input: { type: "object", properties: {} },
      run: async () => resolve(),
    });

    // The store behind appearance.tokens. Reading is harmless and open to anyone. Writing is a
    // person's change: the settings module relays it here under the person's label, and a
    // person's own surface may call it too. Either way it is checked first, and emits
    // appearance.changed.
    ctx.tool("appearance.tokens.get", {
      description: "The person's own theme override (appearance.tokens), as saved, or nothing when there is none. appearance.resolve gives the merged tokens.",
      input: { type: "object", properties: {} },
      run: async () => ({ value: stored() }),
    });

    ctx.tool("appearance.tokens.set", {
      description: "Save the person's theme override (appearance.tokens), or remove it with null. It is checked first and refused whole, with each problem named, if it breaks a rule. Change it with settings.set, which calls this.",
      input: { type: "object", required: ["value"], properties: { value: {} } },
      callers: PEOPLE,
      run: async i => {
        const v = i.value;
        if (v === null) {
          db.prepare("DELETE FROM appearance_tokens WHERE scope = 'account'").run();
        } else {
          if (typeof v !== "object" || Array.isArray(v)) throw Object.assign(new Error("appearance.tokens is an object shaped like a partial tokens.json"), { code: "bad_input" });
          const { ok, problems } = checkOver(v);
          if (!ok) throw Object.assign(new Error(`appearance.tokens refused: ${problems.join("; ")}`), { code: "bad_input", detail: { problems } });
          db.prepare(`INSERT INTO appearance_tokens (scope, value, at) VALUES ('account', ?, ?)
            ON CONFLICT(scope) DO UPDATE SET value = excluded.value, at = excluded.at`).run(JSON.stringify(v), Date.now());
        }
        await changed();
        return { value: stored() };
      },
    });

    // The theme key lives in the settings module's table: follow its change. A tokens change
    // already emitted from the set above.
    const off = ctx.events.on("settings.changed", (/** @type {any} */ ev) => {
      if (ev && ev.payload && ev.payload.key === "appearance.theme") void changed();
    });

    // The same answer as appearance.resolve, over plain HTTP, for the Capsule and the phone. The
    // version is the ETag, so a surface that polls gets a 304 until something changes.
    ctx.route("theme", async (/** @type {any} */ req, /** @type {any} */ res) => {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "application/json", allow: "GET" });
        return res.end(JSON.stringify({ error: { code: "bad_input", message: "GET only" } }));
      }
      const r = await resolve();
      const etag = `"${r.version}-${r.theme}"`;
      if (req.headers["if-none-match"] === etag) { res.writeHead(304, { etag }); return res.end(); }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache", etag, "x-content-type-options": "nosniff" });
      return res.end(JSON.stringify({ data: r }));
    });

    return { async stop() { off(); } };
  },
};
