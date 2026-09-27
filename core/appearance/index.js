// @ts-check
// appearance: the theme and the design tokens as hub values (ADR 0035, sections 3 to 5, "The
// settings hub"; ADR 0033, section 3). ADR 0035 calls this the theme module and its tools
// theme.check and theme.presets; here they are appearance.check and appearance.presets.
//
// It declares three settings in module.json, group "appearance":
//   appearance.theme   the preset: "vyre" or "<module>/<name>". A preset carries both schemes
//                      (color.dark and color.paper). Its choices come from appearance.presets
//                      (choicesFrom), and appearance.check refuses a preset that isn't installed.
//                      The old values system, dark and paper are read as "vyre" (with dark or
//                      paper as the scheme, when no scheme is set) for one release.
//   appearance.scheme  system (follow the OS), dark or paper. Usually set per device.
//   appearance.tokens  the person's partial tokens.json, merged over the preset, checked by
//                      appearance.check (check: { tool }): AA text pairs, a 3:1 focus ring, the
//                      attention role kept, text of 12 or more, 44 px targets, fonts not empty.
//                      The whole value is refused, naming the failing pair.
//
// Levels: account only for now. ADR 0035 gives all three account and device level; the
// registry (core/config/settings.js) accepts "device" once native-core's build step 2 lands, and
// then each declaration's levels become ["account", "device"].
//
// Where appearance.tokens lives: still this module's own table, behind appearance.tokens.get and
// appearance.tokens.set (a tool store), because the registry doesn't call check yet. When it
// does, the "store" line in module.json goes and the value moves to hub.json like any plain key;
// nothing here changes, since every read goes through the hub (settings.snapshot, or settings.get)
// and falls back to the table only when the settings module is off.
//
// Surfaces read appearance.resolve { device?, project?, format? } (or GET /v1/appearance/theme,
// the same answer): the preset, the scheme, the whole merged tokens.json, its custom properties,
// a version, and the hub's rev when settings.snapshot exists. format "css" is only the custom
// properties, so vyred can serve GET /theme.css?device= and GET /v1/theme?device= by calling it.
// resolve checks the merged tokens again on every read: a stored value that no longer passes
// paints the preset's tokens instead, and the answer names each problem. A bad value never paints.
//
// The contract for repainting is settings.changed for any appearance.* key (ADR 0035, section
// 5). appearance.changed {version, theme, scheme} is a convenience, sent when the account's
// resolved answer changes.
//
// The older config.theme.colors folds in under the preset for one release (lib/theme fromLegacy),
// only when the result still keeps every rule.
//
// Switched off, the keys leave the settings list, the tools and route are gone, and every surface
// keeps the shipped tokens it already has. Nothing else depends on this module.

import * as theme from "../../lib/theme/index.js";
import * as config from "../config/index.js";

const MIGRATIONS = [
  `CREATE TABLE appearance_tokens (scope TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL)`,
];
const PEOPLE = ["cli", "local", "deck", "capsule"];
const SCHEMES = ["system", "dark", "paper"];
const DEFAULT_PRESET = "vyre";
/** Old appearance.theme values, read as the vyre preset and a scheme, for one release. */
const LEGACY_THEME = /** @type {Record<string, string>} */ ({ system: "system", dark: "dark", paper: "paper" });
const KEYS = ["appearance.theme", "appearance.scheme", "appearance.tokens"];
const HEAD = "Vyre's design tokens from the hub (the appearance module).";

const fault = (/** @type {string} */ code, /** @type {string} */ message, /** @type {any} */ detail) =>
  Object.assign(new Error(message), { code, ...(detail ? { detail } : {}) });

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const shipped = theme.tokens();

    /** The person's override as this module's table holds it, or undefined. */
    const stored = () => {
      const row = /** @type {any} */ (db.prepare("SELECT value FROM appearance_tokens WHERE scope = 'account'").get());
      return row ? JSON.parse(String(row.value)) : undefined;
    };

    /**
     * The vyre preset: the shipped tokens with config.theme.colors folded in, when there are any
     * and the result keeps every rule. Read on each call, so a changed config.json needs no restart.
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

    // The presets installed. Vyre's own only: a module's themes/<name>.json becomes a preset
    // once the module loader lists them to this module (it shows other modules' manifests only
    // to the settings module today).
    const presets = () => [{ id: DEFAULT_PRESET, label: "Vyre", schemes: ["dark", "paper"] }];
    /** A preset's tokens, or null when it isn't installed. @param {string} id */
    const presetTokens = id => (id === DEFAULT_PRESET ? ground() : null);

    /** An override checked over the preset it will be merged onto. @param {any} override @param {string} [preset] */
    const checkOver = (override, preset = DEFAULT_PRESET) => {
      const { base } = presetTokens(preset) || ground();
      if (override === undefined || override === null) return { ok: true, problems: [], tokens: base };
      const { tokens, problems } = theme.applyOverride(base, override);
      return { ok: !problems.length, problems, tokens };
    };

    /** Problems with a proposed appearance.theme. @param {any} v */
    const checkPreset = v => {
      if (typeof v !== "string" || !v) return ["appearance.theme is a preset's id, like vyre"];
      if (LEGACY_THEME[v]) return [`appearance.theme: ${v} is a scheme now; set appearance.scheme to ${v} and appearance.theme to vyre`];
      if (!presets().some(p => p.id === v)) return [`appearance.theme: no preset ${v}; appearance.presets lists the installed ones`];
      return [];
    };

    /**
     * The three values from the hub, for one device and project, and where each came from.
     * settings.snapshot when native-core has it (the hub's rev and the device level too), else
     * settings.get (account and project), else this module's own table and the defaults.
     * @param {{ device?: string, project?: string }} at
     */
    const fromHub = async at => {
      const snap = await ctx.call("settings.snapshot", { ...(at.device ? { device: at.device } : {}), ...(at.project ? { project: at.project } : {}) });
      if (snap && !snap.error && snap.data && snap.data.values) {
        const d = snap.data;
        return { values: d.values, sources: d.sources || {}, rev: d.rev, device: d.device };
      }
      /** @type {Record<string, any>} */ const values = {};
      /** @type {Record<string, string>} */ const sources = {};
      for (const key of KEYS) {
        const r = await ctx.call("settings.get", { key, ...(at.project ? { project: at.project } : {}) });
        if (!r || r.error || !r.data) continue;
        if (r.data.available === false) continue;
        values[key] = r.data.value;
        sources[key] = r.data.source;
      }
      if (!("appearance.tokens" in values)) {
        const own = stored();
        if (own !== undefined) { values["appearance.tokens"] = own; sources["appearance.tokens"] = "account"; }
      }
      return { values, sources, rev: undefined, device: undefined };
    };

    /** @param {{ device?: string, project?: string }} [at] */
    const resolve = async (at = {}) => {
      const hub = await fromHub(at);
      /** @type {string[]} */ const problems = [];
      let preset = hub.values["appearance.theme"] ?? DEFAULT_PRESET;
      let scheme = hub.values["appearance.scheme"];
      const schemeSet = hub.sources["appearance.scheme"] && hub.sources["appearance.scheme"] !== "default" && hub.sources["appearance.scheme"] !== "unset";
      if (typeof preset === "string" && LEGACY_THEME[preset]) {
        if (!schemeSet) scheme = LEGACY_THEME[preset];
        preset = DEFAULT_PRESET;
      }
      if (!SCHEMES.includes(scheme)) scheme = "system";
      let p = typeof preset === "string" ? presetTokens(preset) : null;
      if (!p) {
        problems.push(`appearance.theme: no preset ${JSON.stringify(preset)}; painting vyre`);
        preset = DEFAULT_PRESET;
        p = ground();
      }
      const { base, legacy } = p;
      let tokens = base;
      const own = hub.values["appearance.tokens"];
      if (own !== undefined && own !== null && !(typeof own === "object" && !Array.isArray(own) && !Object.keys(own).length)) {
        // Checked when it was saved; checked again here, since the preset or the legacy colours
        // under it may have changed, and a hand edit may not have been. A set that no longer holds
        // is left out whole, never half applied: the preset paints, and the problems are named.
        const r = theme.applyOverride(base, own);
        if (r.problems.length) problems.push(...r.problems); else tokens = r.tokens;
      }
      return {
        theme: preset, scheme, tokens, css: theme.css(tokens, HEAD), version: theme.version(tokens),
        ...(hub.rev !== undefined ? { rev: hub.rev } : {}), ...(hub.device ? { device: hub.device } : {}),
        ...(legacy ? { legacy } : {}), ...(problems.length ? { problems } : {}),
      };
    };

    // appearance.changed, when the account's answer moves. Many paths lead here for one change
    // (appearance.tokens.set, then the hub's settings.changed for the same key): send it once.
    let last = "";
    const changed = async () => {
      try {
        const r = await resolve();
        const at = `${r.version} ${r.theme} ${r.scheme}`;
        if (at === last) return;
        last = at;
        ctx.events.emit("appearance.changed", { version: r.version, theme: r.theme, scheme: r.scheme });
      } catch (e) { ctx.log(`appearance.changed not sent: ${/** @type {Error} */ (e).message}`); }
    };
    try { const r = await resolve(); last = `${r.version} ${r.theme} ${r.scheme}`; } catch {}

    ctx.tool("appearance.check", {
      description: "Check a proposed appearance value without saving it. The hub calls it as the settings module with { key, value } before it stores appearance.theme or appearance.tokens; a direct caller gives { override } (a partial tokens.json). Returns ok, each problem by name (a group or key that may not change, a text pair under AA, the focus ring under 3:1, the attention colour reused, text under 12, a target under 44, an empty font, a preset that isn't installed), and a message naming them when it fails.",
      input: { type: "object", properties: { override: {}, value: {}, key: { type: "string" } } },
      run: async i => {
        let problems;
        if ("override" in (i || {})) problems = checkOver(i.override).problems;
        else if (i.key === "appearance.theme" || (i.key === undefined && typeof i.value === "string")) problems = checkPreset(i.value);
        else if (i.key !== undefined && i.key !== "appearance.tokens") problems = [`appearance.check checks appearance.theme and appearance.tokens, not ${i.key}`];
        else if (i.value !== undefined && i.value !== null && (typeof i.value !== "object" || Array.isArray(i.value))) problems = ["appearance.tokens is an object shaped like a partial tokens.json"];
        else problems = checkOver(i.value).problems;
        return problems.length ? { ok: false, message: problems.join("; "), problems } : { ok: true, problems };
      },
    });

    ctx.tool("appearance.presets", {
      description: "The theme presets installed, the choices for appearance.theme: [{id, label, schemes}]. Vyre's own for now; a module's themes/<name>.json joins once the module loader lists them.",
      input: { type: "object", properties: {} },
      run: async () => ({ presets: presets() }),
    });

    ctx.tool("appearance.resolve", {
      description: "What a surface paints, for one device (and project): the preset (theme), the scheme (system, dark or paper), the whole merged tokens.json, its CSS custom properties, a version that changes when the tokens do, and the hub's rev when there is one. A stored value that breaks a rule paints the preset instead and is named under problems. format css returns only the CSS text. Surfaces read it again on settings.changed for appearance.* keys.",
      input: { type: "object", properties: { device: { type: "string" }, project: { type: "string" }, format: { type: "string", enum: ["json", "css"] } } },
      run: async i => {
        const r = await resolve({ device: i.device, project: i.project });
        return i.format === "css" ? r.css : r;
      },
    });

    // The store behind appearance.tokens, until the hub keeps it. Reading is harmless and open to
    // anyone. Writing is a person's change: the settings module relays it here under the person's
    // label, and a person's own surface may call it too. Either way it is checked first.
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
          if (typeof v !== "object" || Array.isArray(v)) throw fault("bad_input", "appearance.tokens is an object shaped like a partial tokens.json");
          const { ok, problems } = checkOver(v);
          if (!ok) throw fault("bad_input", `appearance.tokens refused: ${problems.join("; ")}`, { problems });
          db.prepare(`INSERT INTO appearance_tokens (scope, value, at) VALUES ('account', ?, ?)
            ON CONFLICT(scope) DO UPDATE SET value = excluded.value, at = excluded.at`).run(JSON.stringify(v), Date.now());
        }
        await changed();
        return { value: stored() };
      },
    });

    const off = ctx.events.on("settings.changed", (/** @type {any} */ ev) => {
      const key = ev && ev.payload && ev.payload.key;
      if (typeof key === "string" && key.startsWith("appearance.")) void changed();
    });

    // The same answer as appearance.resolve, over plain HTTP: ?device=, ?project=, ?format=css.
    // The ETag is the hub's rev when there is one (a surface sends If-None-Match: <rev> from the
    // last settings.changed), else the version with the preset and scheme.
    ctx.route("theme", async (/** @type {any} */ req, /** @type {any} */ res) => {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "application/json", allow: "GET" });
        return res.end(JSON.stringify({ error: { code: "bad_input", message: "GET only" } }));
      }
      const q = new URL(req.url || "/", "http://vyre").searchParams;
      const css = q.get("format") === "css";
      const r = await resolve({ device: q.get("device") || undefined, project: q.get("project") || undefined });
      const etag = r.rev !== undefined ? `"${r.rev}"` : `"${r.version}-${r.theme}-${r.scheme}"`;
      if (req.headers["if-none-match"] === etag) { res.writeHead(304, { etag }); return res.end(); }
      res.writeHead(200, { "content-type": css ? "text/css; charset=utf-8" : "application/json", "cache-control": "no-cache", etag, "x-content-type-options": "nosniff" });
      return res.end(css ? r.css : JSON.stringify({ data: r }));
    });

    return { async stop() { off(); } };
  },
};
