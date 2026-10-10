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
// Levels: all three are set at account and device level (ADR 0035): a dark phone beside a paper
// Mac. The hub keeps every value in hub.json (a key set per device has no store), and the hub
// calls appearance.check, as the settings module, before it stores appearance.theme or
// appearance.tokens, and refuses the change when the check says no, is off, or is slow.
//
// Old values: before the hub kept appearance.tokens, this module kept it in its own table. That
// row is still read for one release, only while the hub holds no value of its own, and is
// dropped the first time the person changes appearance.tokens through the hub (set or reset).
// It is not copied into the hub at start: only a person writes a setting, and a module has no
// path to settings.set.
//
// Surfaces read vyred's GET /theme.css?device= and GET /v1/theme?device= (core/daemon), which
// call appearance.resolve { device } and carry the hub's rev as the ETag. resolve's answer: the
// preset, the scheme, the whole merged tokens.json, its custom properties (css, always), a
// version, the hub's rev and the device it resolved. format "css" is only the custom properties.
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
// Switched off, the keys leave the settings list and the tools are gone: vyred's /theme.css paints
// the Deck's own colours (and config.theme.colors), and /v1/theme answers 404. Nothing else
// depends on this module.

import * as theme from "../../lib/theme/index.js";
import * as config from "../config/index.js";

const MIGRATIONS = [
  `CREATE TABLE appearance_tokens (scope TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL)`,
];
const SCHEMES = ["system", "dark", "paper"];
const DEFAULT_PRESET = "vyre";
/** Old appearance.theme values, read as the vyre preset and a scheme, for one release. */
const LEGACY_THEME = /** @type {Record<string, string>} */ ({ system: "system", dark: "dark", paper: "paper" });
const KEYS = ["appearance.theme", "appearance.scheme", "appearance.tokens"];
const HEAD = "Vyre's design tokens from the hub (the appearance module).";

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const shipped = theme.tokens();

    /** An old value in this module's table, from before the hub kept appearance.tokens. */
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
     * The three values from the hub, for one device and project, and where each came from:
     * settings.snapshot (device beats project beats account beats default), else settings.get,
     * else the defaults (the settings module is off). An old table value fills in only where the
     * hub has none of its own.
     * @param {{ device?: string, project?: string }} at
     */
    const fromHub = async at => {
      const snap = await ctx.call("settings.snapshot", { ...(at.device ? { device: at.device } : {}), ...(at.project ? { project: at.project } : {}) });
      if (snap && !snap.error && snap.data && snap.data.values) {
        const d = snap.data;
        const values = { ...d.values }, sources = { ...(d.sources || {}) };
        oldTokens(values, sources);
        return { values, sources, rev: d.rev, device: d.device };
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
      oldTokens(values, sources);
      return { values, sources, rev: undefined, device: undefined };
    };

    /** The old table value, where the hub has none of its own. @param {Record<string, any>} values @param {Record<string, string>} sources */
    const oldTokens = (values, sources) => {
      const src = sources["appearance.tokens"];
      if (src && src !== "default" && src !== "unset") return;
      const old = stored();
      if (old !== undefined) { values["appearance.tokens"] = old; sources["appearance.tokens"] = "account"; }
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

    // appearance.changed, when the account's answer moves: sent once per real change.
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
      effect: "read",
      description: "Check a proposed appearance value without saving it: give key and value, or override. Returns ok, each problem by name, and a message.",
      input: { type: "object", properties: { override: { description: "a partial tokens.json to check" }, value: { description: "the proposed value for key" }, key: { type: "string", description: "appearance.theme or appearance.tokens" }, level: { type: "string" }, device: { type: "string" } } },
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
      effect: "read",
      description: "The theme presets installed, the choices for appearance.theme: [{id, label, schemes}]. Vyre's own for now; a module's themes/<name>.json joins once the module loader lists them.",
      input: { type: "object", properties: {} },
      run: async () => ({ presets: presets() }),
    });

    ctx.tool("appearance.resolve", {
      description: "What a surface paints for one device (and project): preset, scheme, merged tokens.json, CSS custom properties, version, and problems with any stored value.",
      input: { type: "object", properties: { device: { type: "string" }, project: { type: "string" }, format: { type: "string", enum: ["json", "css"], description: "css returns only the CSS text" } } },
      run: async i => {
        const r = await resolve({ device: i.device, project: i.project });
        return i.format === "css" ? r.css : r;
      },
    });

    const off = ctx.events.on("settings.changed", (/** @type {any} */ ev) => {
      const key = ev && ev.payload && ev.payload.key;
      if (typeof key !== "string" || !key.startsWith("appearance.")) return;
      // The person has spoken through the hub: the old table value is done with.
      if (key === "appearance.tokens") db.prepare("DELETE FROM appearance_tokens").run();
      void changed();
    });

    return { async stop() { off(); } };
  },
};
