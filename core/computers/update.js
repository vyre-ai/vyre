// @ts-check
// update: bring the Space's one agent computer to the image that matches this Vyre, without losing anything an agent keeps.
//
// A Vyre update changes the image the computer runs from (box/compose.yml names it, and the updater pulls and verifies it before vyred
// starts; vyred itself is never allowed to pull, core/computers/driver/policy.js). A container keeps running the old image until it is
// made again, so after an update this file notices that, closes every agent's screen (its Chrome writes its profile), stops the
// container and makes a new one on the same state volume. The volume is never touched: logins, files and tmux state stay. What the new
// image expects inside the volume is then made true, as each agent's own user, because the computer's root is read-only and agentd
// holds no right to change an owner (agentd.js planCreate does the work and is safe to repeat).
//
// It runs on its own at start when the stamp it keeps (image, Vyre version, layout) no longer matches, and as the owner's tool
// computers.update. A terminal job that was running when the container was replaced ends; the result says how many agents had one open.

import { SHARED_COMPUTER_ID } from "../../lib/browser-access.js";
import { userNameOf } from "./agent-users.js";
import { LAYOUT_VERSION } from "./driver/policy.js";

/** The shape of the state volume this code expects (driver/policy.js owns the number and the folders). A computer recorded with less has its folders put right once. */
export const LAYOUT = LAYOUT_VERSION;

export const MIGRATIONS = [
  `CREATE TABLE computers_update (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     image TEXT NOT NULL,
     version TEXT NOT NULL,
     layout INTEGER NOT NULL,
     container TEXT,
     at INTEGER NOT NULL
   );`,
];

/**
 * @typedef {{ id: string, user: string, uid: number, display: number }} Place
 * @typedef {{ db: import("node:sqlite").DatabaseSync, pool: import("./pool.js").Pool, users: import("./agent-users.js").AgentUsers,
 *   version: string, turns?: () => number, wait?: (ms: number) => Promise<void>, held?: (agent: string) => boolean, log?: (m: string) => void, emit?: (type: string, payload: any) => void, now?: () => number }} Deps
 */

/**
 * Is this call the Space's owner, in person and nobody else? One hop on the chain, a person, whose canonical id is the kernel's owner. An admin, a member, an agent, the owner's assistant (two hops), a module and
 * an MCP caller all fail, and so does a chain that cannot be read. A build with no kernel denies too: a packaged daemon always has one, and a dev build must not have a weaker door.
 * @param {any} kernel ctx.kernel @param {any} meta the tool call's meta
 */
export async function assertOwner(kernel, meta) {
  const deny = () => Object.assign(new Error("only the owner of this Space updates its agent computer"), { code: "denied" });
  if (!kernel || typeof kernel.chain !== "function") throw deny();
  const chain = await kernel.chain(meta).catch(() => null);
  const hop = chain && Array.isArray(chain.hops) ? chain.hops[0] : null;
  if (!hop || !hop.actor || hop.actor.kind !== "person" || chain.hops.length !== 1) throw deny();
  const canon = typeof kernel.canonicalPerson === "function" ? (/** @type {string} */ x) => kernel.canonicalPerson(x) : (/** @type {string} */ x) => x;
  if (!kernel.owner || canon(String(hop.actor.id)) !== canon(String(kernel.owner))) throw deny();
}

/**
 * The global "any agent mid-turn" signal: the switchboard's own events, kept as a set of thread ids. A turn that never reports its end stays in the set, which is why the automatic update caps its wait.
 * @param {(pattern: string, fn: (e: any) => void) => () => void} on ctx.events.on
 * @returns {{ size: () => number, stop: () => void }}
 */
export function trackTurns(on) {
  const running = new Set();
  const idOf = (/** @type {any} */ e) => { const p = e && e.payload; const t = p && (p.thread || p.id); return t ? String(t) : null; };
  const offs = [on("thread.sent", e => { const t = idOf(e); if (t) running.add(t); }), on("thread.finished", e => { const t = idOf(e); if (t) running.delete(t); })];
  return { size: () => running.size, stop: () => { for (const off of offs) if (typeof off === "function") off(); } };
}

export class ComputerUpdater {
  /** @param {Deps} d */
  constructor(d) {
    this.db = d.db;
    this.pool = d.pool;
    this.users = d.users;
    this.version = String(d.version || "0.0.0");
    /** How many agent turns are running now. */
    this.turns = d.turns || (() => 0);
    this.held = d.held || (() => false);
    this.log = d.log || (() => {});
    this.emit = d.emit || (() => {});
    this.now = d.now || (() => Date.now());
    this.wait = d.wait || (ms => new Promise(r => setTimeout(r, ms)));
    /** @type {Promise<any> | null} */
    this.inflight = null;
  }

  /** What this Vyre wants the computer to be. */
  want() { return { image: String(this.pool.opts.image), version: this.version, layout: LAYOUT }; }

  /** What the computer was last made or migrated as, or null when nothing was recorded. */
  stamp() { return /** @type {any} */ (this.db.prepare("SELECT image, version, layout, container, at FROM computers_update WHERE id = 1").get()) || null; }

  /** @param {string|null} container */
  record(container) {
    const w = this.want();
    this.db.prepare(`INSERT INTO computers_update (id, image, version, layout, container, at) VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET image = excluded.image, version = excluded.version, layout = excluded.layout, container = excluded.container, at = excluded.at`)
      .run(w.image, w.version, w.layout, container, this.now());
  }

  /** The computer was just made from the current image: remember it, so the next start does not replace it again. */
  noteCreated() {
    const box = this.pool.row(SHARED_COMPUTER_ID);
    if (box && box.container) this.record(String(box.container));
  }

  /** A new container answers agentd a moment after it starts: try a few times, a second apart, before giving up. @param {() => Promise<any>} fn */
  async ready(fn) {
    for (let n = 1; ; n++) {
      try { return await fn(); }
      catch (e) { if (n >= 8) throw e; await this.wait(1000); }
    }
  }

  /** Where the computer stands against this Vyre, without changing anything. */
  status() {
    const box = this.pool.row(SHARED_COMPUTER_ID);
    const want = this.want(), have = this.stamp();
    if (!box || !box.container) return { present: false, current: true, want, have };
    const image = Boolean(have) && have.container === box.container && have.image === want.image && have.version === want.version;
    return { present: true, current: image && have.layout === want.layout, image, want, have };
  }

  /** What an update would interrupt: agent turns in progress and agents with a terminal job open. */
  async activity() {
    let terminals = 0;
    for (const r of this.users.list()) { try { if ((await this.users.terminals(r.agent_id)).length) terminals++; } catch { /* nothing answers, so nothing runs */ } }
    return { turns: this.turns(), terminals };
  }

  /**
   * The run that starts by itself: when the computer is behind it waits until no agent is mid-turn and no terminal job is open, looking once a minute, for at most `capMs` (30 minutes).
   * After that it updates anyway and says what it interrupted.
   * @param {{ capMs?: number, pollMs?: number }} [o]
   */
  async auto(o = {}) {
    const capMs = o.capMs ?? 30 * 60_000, pollMs = o.pollMs ?? 60_000, t0 = this.now();
    let said = false;
    for (;;) {
      const s = this.status();
      if (!s.present || s.current) return this.run();
      const busy = await this.activity();
      if (!busy.turns && !busy.terminals) return this.run();
      if (this.now() - t0 >= capMs) {
        const r = await this.run();
        return { ...r, interrupted: busy, message: `${r.message} It waited 30 minutes for work to finish; ${busy.turns} agent turn(s) and ${busy.terminals} agent(s) with a terminal job were interrupted.` };
      }
      if (!said) { said = true; this.log("agent computer update waits for running agent work to finish (at most 30 minutes)"); }
      await this.wait(pollMs);
    }
  }

  /**
   * Bring the computer up to date now. Safe to call at any time and from two places at once (the second call gets the first one's answer).
   * @param {{ force?: boolean }} [o] force: replace the container even though it looks current
   */
  run(o = {}) {
    if (!this.inflight) this.inflight = this.#run(o.force === true).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** @param {boolean} force */
  async #run(force) {
    const pool = this.pool;
    if (!pool.driver) throw new Error("no computer driver is configured on this machine, so there is no computer to update");
    const s = this.status();
    if (!s.present) return { updated: false, state: "none", message: "This Space has no agent computer yet. It is made from the current image the first time an agent needs it." };
    if (s.current && !force) return { updated: false, state: "current", message: "The agent computer already matches this version of Vyre." };

    const places = this.users.list();
    const busy = places.filter(r => this.held(r.agent_id)).map(r => r.agent_id);
    if (busy.length) return { updated: false, state: "busy", busy, message: "Someone is watching or controlling an agent's computer. It is updated when they let go, or run the update again." };

    const replace = force || !s.image;
    const open = places.filter(r => r.state !== "asleep");
    // Close every screen first, as a person asking would: Chrome writes its profile when it is told to end, and the rows say asleep, which is true of a new container.
    for (const r of open) {
      try { await this.users.sleep(r.agent_id, "update"); }
      catch (e) {
        // A computer that is already gone cannot close a screen, and replacing it is the cure: the row still has to say asleep.
        this.log(`agent computer update: could not close ${r.agent_id}'s screen: ${/** @type {Error} */ (e).message}`);
        this.db.prepare("UPDATE computers_agent_users SET state = 'asleep' WHERE agent_id = ?").run(r.agent_id);
      }
    }
    let terminals = 0;
    if (replace) {
      for (const r of places) { try { if ((await this.users.terminals(r.agent_id)).length) terminals++; } catch { /* a computer that cannot answer has no terminals to lose */ } }
      await pool.stop(SHARED_COMPUTER_ID);
      await pool.serial(SHARED_COMPUTER_ID, async () => {
        const row = pool.row(SHARED_COMPUTER_ID);
        if (row && row.container) {
          try { await /** @type {any} */ (pool.driver).remove(String(row.container)); }
          catch (e) { throw new Error(`could not remove the old agent computer: ${/** @type {Error} */ (e).message}`); }
        }
        pool.set(SHARED_COMPUTER_ID, { state: "none", container: null });
        pool.hosts.delete(SHARED_COMPUTER_ID);
        await pool.ensure(SHARED_COMPUTER_ID);
      });
    }
    else {
      // a frozen or stopped computer is started, so agentd can be asked; the folders an older volume lacks are put there (directories only, fixed owners: driver/policy.js layoutTar)
      await pool.serial(SHARED_COMPUTER_ID, async () => {
        await pool.ensure(SHARED_COMPUTER_ID);
        const d = /** @type {any} */ (pool.driver);
        if (typeof d.migrateLayout === "function") await d.migrateLayout(String(pool.row(SHARED_COMPUTER_ID).container));
      });
    }
    // What the new image expects in the volume, made true as each agent's own user (planCreate is safe to repeat).
    /** @type {Array<{ agent: string, why: string }>} */
    const failed = [];
    for (const r of this.users.list()) {
      try { await this.ready(() => this.users.ctl.createUser({ agentId: r.agent_id, user: userNameOf(r.uid), uid: r.uid, display: r.display })); }
      catch (e) { failed.push({ agent: r.agent_id, why: /** @type {Error} */ (e).message }); }
    }
    if (failed.length) {
      this.log(`agent computer update: ${failed.length} agent folder(s) could not be made ready`);
      return { updated: replace, state: "partial", terminals, failed, message: `The agent computer was ${replace ? "replaced" : "checked"}, but ${failed.length} agent's folders could not be made ready. Their files are untouched.` };
    }
    this.record(String(this.pool.row(SHARED_COMPUTER_ID).container));
    this.emit("computer.updated", { replaced: replace, agents: places.length });
    this.log(`agent computer ${replace ? "replaced" : "migrated"} for ${this.version}, ${places.length} agent(s) kept`);
    return { updated: true, state: "updated", replaced: replace, agents: places.length, terminals,
      message: `The agent computer is on this version of Vyre. ${places.length} agent${places.length === 1 ? "" : "s"} kept their logins and files${terminals ? `; ${terminals} had terminal jobs, and those ended` : ""}.` };
  }
}
