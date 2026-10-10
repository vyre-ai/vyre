// @ts-check
// update: is a newer Vyre out, and asking for it (ADR 0033 section 4, PLAN R2 and R2h, reopened 30 Sep).
// One look at the releases a day, well inside the 60 s rule, kept in <home>/update.json so a restart
// does not ask again. Looking only READS.
//
// Asking for the update (update.apply) never gives vyred a way to run anything on its host: it drops
// the one-line file `update` into a folder the box's compose file mounts (./update on the host), and a
// root-owned systemd path unit there (box/vyre, `vyre updater`) runs the signed `vyre update`, with
// the channel it picks itself. What comes back is a small file the host writes into a folder mounted
// read-only here. No socket, no arguments. Where there is no such unit (a Mac, a box without systemd)
// the request cannot be made and the card shows the command; a Mac server updates through vyre-core's
// signed updater.
//
// config.json, `update`: auto "notify" (default; look and say so) or "off" (never look); install true
// (Settings: "Update automatically") asks for a new release itself at a quiet hour, once per version.

import fs from "node:fs";
import path from "node:path";
import { build } from "../daemon/build.js";
import * as R from "../../lib/releases.js";
import { httpFetch } from "../../lib/http.js";

const DAY = 24 * 3600_000;
const FIRST_LOOK_MS = 2 * 60_000;
const MIN_ASK_MS = 60_000;
const MAX_NOTES = 8;
const MAX_NOTE = 2000;
const FILE = "update.json";
/** The hours, on the server's clock, in which an automatic update may start. */
const QUIET = [2, 5];
const RUN_STATES = new Set(["running", "ok", "failed", "rolled_back"]);
const STAGES = new Set(["start", "checking", "downloading", "verifying", "backing-up", "installing", "restarting", "rolling-back", "finished", "too-soon", "none"]);
/** A run that says it is running after this long is not: the host stopped without saying. */
const STALE_MS = 3 * 3600_000;
/** The person's own callers. */
const PEOPLE = ["cli", "local", "deck", "capsule"];

/** Where the plain-words release notes ship (release/notes/<version>.md). */
const NOTES_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "release", "notes");
const WHATS_NEW_MAX = 3000;

/**
 * The notes of a version for a person to read after an update: the headline and the bullets in the notes' own words, cut at a paragraph so it ends cleanly, never more than WHATS_NEW_MAX
 * characters. Null when this build has no notes for the version (then nothing is shown). @param {string} version @param {string} [dir]
 */
export function whatsNewText(version, dir = NOTES_DIR) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return null;
  let text;
  try { text = fs.readFileSync(path.join(dir, `${version}.md`), "utf8"); } catch { return null; }
  text = text.replace(/\r\n/g, "\n").trim();
  if (!text) return null;
  if (text.length <= WHATS_NEW_MAX) return text;
  const cut = text.slice(0, WHATS_NEW_MAX);
  const at = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf("\n- "));
  return `${cut.slice(0, at > 200 ? at : WHATS_NEW_MAX).trimEnd()}\n\n(and more: the release notes have the rest)`;
}

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

    /** @type {{ checkedAt: number, latest: string|null, channel: string, notes: { version: string, notes: string }[], announced: string|null, requestedFor: string|null, error: string|null }} */
    let seen = { checkedAt: 0, latest: null, channel: channel(), notes: [], announced: null, requestedFor: null, error: null };
    try { const j = JSON.parse(fs.readFileSync(file, "utf8")); if (j && typeof j === "object") seen = { ...seen, ...j }; } catch { /* first run */ }
    const save = () => { try { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(seen), { mode: 0o600 }); fs.renameSync(tmp, file); } catch (e) { ctx.log(`update: could not save ${FILE}: ${/** @type {Error} */ (e).message}`); } };

    /** @type {Promise<any>|null} */
    let looking = null;
    async function look() {
      const current = build().version, ch = channel();
      try {
        const r = await httpFetch(R.safeUrl(`${api()}/repos/${repo()}/releases?per_page=100`), { headers: { accept: "application/vnd.github+json", "user-agent": "vyre-update" }, signal: AbortSignal.timeout(30_000) });
        if (!r.ok) throw new Error(`${r.status} from the releases`);
        const list = R.releases(await r.json());
        const top = R.pick(list, ch);
        const newer = top && R.compare(top.version, current) > 0 ? top : null;
        seen = { ...seen, checkedAt: now(), channel: ch, error: null, latest: newer ? newer.version : null,
          notes: newer ? R.changelog(list, current, newer.version, ch).slice(0, MAX_NOTES).map(n => ({ version: n.version, notes: n.notes.slice(0, MAX_NOTE) })) : [] };
        if (newer && seen.announced !== newer.version) { seen.announced = newer.version; ctx.events.emit("update.available", { version: newer.version, current, channel: ch }); }
        autoAsk().catch(() => {});
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

    // ---- asking the host: one file in, one file out ----
    const reqDir = () => process.env.VYRE_UPDATE_DIR || "/run/vyre-update";
    const stateDir = () => process.env.VYRE_UPDATE_STATE || "/run/vyre-update-state";
    const isFile = f => { try { const st = fs.lstatSync(f); return st.isFile(); } catch { return false; } };
    /** Whether a path unit on the host will act on a request: the host marks its state folder `ready` when it installs the unit. */
    const canApply = () => {
      if (!isFile(path.join(stateDir(), "ready"))) return false;
      try { fs.accessSync(reqDir(), fs.constants.W_OK); return true; } catch { return false; }
    };
    const pending = () => isFile(path.join(reqDir(), "request"));
    const line = (v, n = 200) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").slice(0, n);
    /** What the host wrote about the update it is running or last ran, or null. It is read as untrusted text: known words only, capped. */
    const readRun = () => {
      let j;
      try { const f = path.join(stateDir(), "status.json"); if (!isFile(f)) return null; j = JSON.parse(fs.readFileSync(f, "utf8").slice(0, 4096)); } catch { return null; }
      if (!j || typeof j !== "object" || !RUN_STATES.has(j.state)) return null;
      const at = Number(j.at) * 1000 || 0;
      const stale = j.state === "running" && at && now() - at > STALE_MS;
      return { state: stale ? "failed" : j.state, stage: STAGES.has(j.stage) ? j.stage : "none", message: stale ? "the update stopped without saying why" : line(j.message), from: line(j.from, 40) || null, to: line(j.to, 40) || null, at: at || null };
    };
    const busy = () => { const r = readRun(); return pending() || Boolean(r && r.state === "running"); };
    /** Drop the request: the one word, through a rename so the host never reads half of it. */
    const request = version => {
      const dir = reqDir(), tmp = path.join(dir, `.request.${process.pid}`);
      fs.writeFileSync(tmp, "update\n", { mode: 0o600 });
      fs.renameSync(tmp, path.join(dir, "request"));
      ctx.events.emit("update.requested", { version: version || null });
    };
    const autoAsk = async () => {
      if (!(ctx.config.update && ctx.config.update.install === true)) return;
      const st = status();
      if (!st.available || seen.requestedFor === st.available || !st.canApply || busy()) return;
      const [from, to] = /^(\d+)-(\d+)$/.test(process.env.VYRE_UPDATE_QUIET || "") ? String(process.env.VYRE_UPDATE_QUIET).split("-").map(Number) : QUIET; // the env only for tests
      const h = new Date(now()).getHours();
      if (h < from || h >= to) return;
      // Once per version: a release that failed is the person's to look at, not a loop.
      seen.requestedFor = st.available; save();
      request(st.available);
    };

    const status = () => {
      const current = build().version;
      // A remembered answer that the running version has since caught up with is no longer news.
      const latest = seen.latest && R.compare(seen.latest, current) > 0 ? seen.latest : null;
      return { current, available: latest, channel: channel(), notes: latest ? seen.notes : [], checkedAt: seen.checkedAt || null, auto: auto(),
        error: seen.error, ...howToUpdate(process.platform, ctx.config.role), canApply: canApply(), pending: pending(), run: readRun(), install: Boolean(ctx.config.update && ctx.config.update.install === true) };
    };

    ctx.tool("update.status", {
      effect: "read",
      description: "Whether a newer Vyre is out: running version, newest on this channel (null when current), what changed, last check, and how to update. Read only.",
      input: { type: "object", properties: {} },
      run: async () => status(),
    });
    // What's new after an update (R031-47): shown once to each person, in the release notes' own words. A person who has never been asked is recorded at the running version without a word
    // (a new install has nothing "new"); after that, a different running version is an update, and its notes come back until the person says they have seen them.
    const newFile = path.join(ctx.paths.root, "whatsnew.json");
    const readSeen = () => { try { const j = JSON.parse(fs.readFileSync(newFile, "utf8")); return j && typeof j === "object" && j.seen && typeof j.seen === "object" ? j.seen : {}; } catch { return {}; } };
    const writeSeen = (/** @type {Record<string, string>} */ seenBy) => { fs.writeFileSync(newFile, JSON.stringify({ seen: seenBy }), { mode: 0o600 }); };
    const personKey = (/** @type {any} */ meta) => { const p = meta && (meta.person || (meta.chain && meta.chain.hops && meta.chain.hops[0] && meta.chain.hops[0].actor && meta.chain.hops[0].actor.id)); return typeof p === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(p) ? p : "owner"; };
    ctx.tool("update.whats-new", {
      effect: "read", callers: PEOPLE,
      description: "What changed in the version that is running, once, after an update: { show, version, from?, notes? }. show is false on a first run and when this person has already seen it. Say it in the notes' own words, then call update.whats-new-seen.",
      input: { type: "object", properties: {} },
      run: async (/** @type {any} */ _i, /** @type {any} */ meta) => {
        const version = build().version, key = personKey(meta), all = readSeen(), was = all[key];
        if (was === undefined) { writeSeen({ ...all, [key]: version }); return { show: false, version }; }
        if (was === version) return { show: false, version };
        const notes = whatsNewText(version);
        return notes ? { show: true, version, from: was, notes } : { show: false, version };
      },
    });
    ctx.tool("update.whats-new-seen", {
      effect: "write", callers: PEOPLE,
      description: "The person has read what is new in the running version: it is not shown again.",
      input: { type: "object", properties: { version: { type: "string" } } },
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => { const version = build().version; if (i && i.version && String(i.version) !== version) return { ok: false, version }; writeSeen({ ...readSeen(), [personKey(meta)]: version }); return { ok: true, version }; },
    });
    ctx.tool("update.apply", {
      effect: "write",
      description: "Ask for the update now: drops the one-line request the box's own update unit acts on, which installs the newest release only if its signature matches Vyre's release key, and puts the old version back if the new one does not start. Answers at once; update.status shows the progress and the result. Where this server has no such unit (a Mac, or no systemd) it says so and the command `vyre update` is the way. The person's own action.",
      input: { type: "object", properties: {} },
      callers: PEOPLE,
      run: async () => {
        if (!canApply()) throw Object.assign(new Error("this server does not take update requests from here: run vyre update"), { code: "unavailable" });
        if (busy()) return { requested: false, reason: "an update is already running", ...status() };
        request(seen.latest);
        return { requested: true, ...status() };
      },
    });
    ctx.tool("update.check", {
      effect: "write",
      callers: [...PEOPLE, "module"], // a release lookup is network and a saved answer; a model reads update.status instead
      description: "Look at the releases now instead of waiting for the daily look (at most once a minute), then answer like update.status. Off when update.auto is off.",
      input: { type: "object", properties: {} },
      run: async () => { await check(true); return status(); },
    });

    // The first look a couple of minutes after start (so a start is never slowed by the network), then daily.
    const first = setTimeout(() => { check(false).catch(() => {}); }, FIRST_LOOK_MS); first.unref();
    const daily = setInterval(() => { check(false).catch(() => {}); }, DAY); daily.unref();
    // Automatic updates wait for the quiet hours: an hourly look at the clock and the saved answer, never the network.
    const hourly = setInterval(() => { autoAsk().catch(() => {}); }, 3600_000); hourly.unref();
    return { async stop() { clearTimeout(first); clearInterval(daily); clearInterval(hourly); await looking?.catch(() => {}); } };
  },
};
