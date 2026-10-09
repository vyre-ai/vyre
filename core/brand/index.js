// @ts-check
// brand: the space's identity, kept once and read by everything that makes something with the space's name on it (core/artifacts today; documents, signing pages and Publish read brand.resolve).
//
//   brand.get      the profile as saved
//   brand.resolve  what a surface uses: names, the theme part the app takes, the colour as drawn in each scheme (with a note when it moved), fonts, logos, letterhead
//   brand.draft    a draft from a page's HTML (the caller fetched it: a box module has no network of its own); nothing is saved
//   brand.set      the person's save. Only a person sets it; an agent drafts and the person says yes
//
// The profile is SPACE-level identity, not a per-person preference, so it lives here and not in appearance (which is set per account and per device).
import { brandFromHtml, normalizeBrand, resolveBrand } from "../../lib/brand/profile.js";

const MIGRATIONS = [`CREATE TABLE brand_profile (id INTEGER PRIMARY KEY CHECK (id = 1), profile TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)`];
const ANYONE = ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "module", "mcp", "harness"];

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const read = () => { const r = /** @type {any} */ (db.prepare("SELECT * FROM brand_profile WHERE id = 1").get()); return r ? { profile: JSON.parse(String(r.profile)), version: Number(r.version), updatedAt: Number(r.updated_at) } : { profile: {}, version: 0, updatedAt: 0 }; };

    ctx.tool("brand.get", { callers: ANYONE, description: "The space's brand profile as saved: { profile, version }. Empty when none was set.", input: { type: "object", properties: {} }, run: async () => read() });
    ctx.tool("brand.resolve", {
      callers: ANYONE,
      description: "What to use for this space by default: { names, theme, accent (as drawn in dark and paper, with a note when it moved), fonts, logos, letterhead, version }. Use it for every artifact, preview, document and message unless told otherwise.",
      input: { type: "object", properties: {} },
      run: async () => { const { profile, version } = read(); return { ...resolveBrand(profile), version }; },
    });
    ctx.tool("brand.draft", {
      callers: ANYONE,
      description: "A draft brand profile from a company website's HTML: { html, url }. Fetch the page yourself and pass it in. Returns { draft, found, logoUrl }; nothing is saved. Show the person the draft; they save it with brand.set.",
      input: { type: "object", required: ["html"], properties: { html: { type: "string", maxLength: 600000 }, url: { type: "string", maxLength: 500 } } },
      run: async (/** @type {any} */ i) => brandFromHtml(String(i.html), i.url ? String(i.url) : ""),
    });
    ctx.tool("brand.set", {
      description: "Save the space's brand profile (a person's act): { profile } with any of name, legalName, address, phone, colors { primary, secondary }, fonts { heading, body }, density, logos { light, dark, mark } (small png, jpeg or webp as data: URLs), letterhead { on, text }. Replaces the whole profile.",
      input: { type: "object", required: ["profile"], properties: { profile: { type: "object" } } },
      run: async (/** @type {any} */ i) => {
        const r = normalizeBrand(i.profile);
        if (!r.ok) return { problems: r.problems };
        const cur = read(), version = cur.version + 1, now = Date.now();
        db.prepare("INSERT INTO brand_profile (id, profile, version, updated_at) VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET profile = excluded.profile, version = excluded.version, updated_at = excluded.updated_at").run(JSON.stringify(r.profile), version, now);
        ctx.events.emit("brand.changed", { version });
        return { saved: true, version, ...resolveBrand(r.profile) };
      },
    });
    return { async stop() {} };
  },
};
