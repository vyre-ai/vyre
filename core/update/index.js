// @ts-check
// update: is a newer Vyre out (ADR 0033 section 4, PLAN R2). One look at the releases a day, well
// inside the 60 s rule, kept in <home>/update.json so a restart does not ask again. It only READS:
// it never downloads, installs or restarts anything. The person runs the update themselves (the one
// command on a box, the app's own updater on a Mac), so vyred holds no channel to its own host (R2h).
//
// `update.auto` in config.json: "notify" (the default, look and say so), "off" (never look).
// "install" at a quiet hour needs the host side and is not built; it behaves as "notify".

import fs from "node:fs";
import path from "node:path";
import { build } from "../daemon/build.js";
import * as R from "../../lib/releases.js";

const DAY = 24 * 3600_000;
const FIRST_LOOK_MS = 2 * 60_000;
const MIN_ASK_MS = 60_000;
const MAX_NOTES = 8;
const MAX_NOTE = 2000;
const FILE = "update.json";

/** The one command a box person runs, or the words for an app that updates itself. @param {string} platform @param {string} role */
export function howToUpdate(platform, role) {
  if (platform === "darwin" && role === "local") return { how: "app", command: null };
  return { how: "command", command: "vyre update" };
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const file = path.join(ctx.paths.root, FILE);
    const api = () => (process.env.VYRE_RELEASES_API || "https://api.github.com").replace(/\/$/, "");
    const repo = () => process.env.VYRE_RELEASES_REPO || "vyre-ai/vyre";
    const now = () => Date.now();
    const auto = () => { const a = String((ctx.config.update || {}).auto || "notify"); return a === "off" || a === "install" ? a : "notify"; };
    const channel = () => { const c = (ctx.config.update || {}).channel; return c === "beta" || c === "stable" ? c : R.isPre(build().version) ? "beta" : "stable"; };

    /** @type {{ checkedAt: number, latest: string|null, channel: string, notes: { version: string, notes: string }[], announced: string|null, error: string|null }} */
    let seen = { checkedAt: 0, latest: null, channel: channel(), notes: [], announced: null, error: null };
    try { const j = JSON.parse(fs.readFileSync(file, "utf8")); if (j && typeof j === "object") seen = { ...seen, ...j }; } catch { /* first run */ }
    const save = () => { try { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(seen), { mode: 0o600 }); fs.renameSync(tmp, file); } catch (e) { ctx.log(`update: could not save ${FILE}: ${/** @type {Error} */ (e).message}`); } };

    /** @type {Promise<any>|null} */
    let looking = null;
    async function look() {
      const current = build().version, ch = channel();
      try {
        const r = await fetch(R.safeUrl(`${api()}/repos/${repo()}/releases?per_page=100`), { headers: { accept: "application/vnd.github+json", "user-agent": "vyre-update" }, signal: AbortSignal.timeout(30_000) });
        if (!r.ok) throw new Error(`${r.status} from the releases`);
        const list = R.releases(await r.json());
        const top = R.pick(list, ch);
        const newer = top && R.compare(top.version, current) > 0 ? top : null;
        seen = { ...seen, checkedAt: now(), channel: ch, error: null, latest: newer ? newer.version : null,
          notes: newer ? R.changelog(list, current, newer.version, ch).slice(0, MAX_NOTES).map(n => ({ version: n.version, notes: n.notes.slice(0, MAX_NOTE) })) : [] };
        if (newer && seen.announced !== newer.version) { seen.announced = newer.version; ctx.events.emit("update.available", { version: newer.version, current, channel: ch }); }
      } catch (e) {
        seen = { ...seen, checkedAt: now(), error: String(/** @type {Error} */ (e).message).slice(0, 200) };
      }
      save();
    }
    /** One look at a time; @param {boolean} force */
    const check = force => {
      if (auto() === "off") return Promise.resolve();
      if (!force && seen.checkedAt && now() - seen.checkedAt < DAY) return Promise.resolve();
      if (force && seen.checkedAt && now() - seen.checkedAt < MIN_ASK_MS) return Promise.resolve();
      return looking || (looking = look().finally(() => { looking = null; }));
    };

    const status = () => {
      const current = build().version;
      // A remembered answer that the running version has since caught up with is no longer news.
      const latest = seen.latest && R.compare(seen.latest, current) > 0 ? seen.latest : null;
      return { current, available: latest, channel: channel(), notes: latest ? seen.notes : [], checkedAt: seen.checkedAt || null, auto: auto(),
        error: seen.error, ...howToUpdate(process.platform, ctx.config.role), verifiedBy: "sha256" };
    };

    ctx.tool("update.status", {
      description: "Whether a newer Vyre is out: the running version, the newest one on this channel (null when up to date), what changed, when it was last looked up, and how to update (the one command a box person runs, or 'app' when the Mac app updates itself). Read only: nothing is downloaded or changed. Every surface's Update card draws from this.",
      input: { type: "object", properties: {} },
      run: async () => status(),
    });
    ctx.tool("update.check", {
      description: "Look at the releases now instead of waiting for the daily look (at most once a minute), then answer like update.status. Off when update.auto is off.",
      input: { type: "object", properties: {} },
      run: async () => { await check(true); return status(); },
    });

    // The first look a couple of minutes after start (so a start is never slowed by the network), then daily.
    const first = setTimeout(() => { check(false).catch(() => {}); }, FIRST_LOOK_MS); first.unref();
    const daily = setInterval(() => { check(false).catch(() => {}); }, DAY); daily.unref();
    return { async stop() { clearTimeout(first); clearInterval(daily); await looking?.catch(() => {}); } };
  },
};
