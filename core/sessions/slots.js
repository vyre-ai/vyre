// @ts-check
// slots: how many teammates and subagents run at once (the user's concurrency limits, ADR 0030
// with ADR 0031 section 14).
//
// Two kinds of slot, each with a limit per project and one for the whole box:
//   teammate   an active project teammate, held from its summon starting to its turn ending
//   subagent   a subagent (Claude Code's Agent or Task tool) from any session in a project, the
//              person's own sessions included
// A take that finds no room waits in a queue: oldest first within a project, projects served in
// turn across the box, so one busy project cannot starve another. Every change is an event
// (slot.taken, slot.released, slot.queued with the position), so a surface can say "third in
// line". Slots live in memory: a restart ends every session that held one.

/** @typedef {{ kind: "teammate"|"subagent", project: string, owner: string, key: string }} Want */
/** @typedef {Want & { id: string, at: number }} Slot */
/** @typedef {{ box: Record<string, number>, project: (slug: string) => Record<string, number> }} Limits */

export const KINDS = ["teammate", "subagent"];
/** Box-wide defaults (ADR 0031 section 14): 6 active teammates, 8 subagents. */
export const BOX_DEFAULTS = { teammate: 6, subagent: 8 };

export class Slots {
  /**
   * @param {{ limits: () => Limits, emit: (type: string, payload: any) => void, now?: () => number }} o
   */
  constructor(o) {
    this.o = o;
    this.now = o.now || (() => Date.now());
    /** @type {Map<string, Slot>} */ this.held = new Map();
    /** @type {Map<string, Map<string, { want: Want, at: number, resolve: (s: Slot) => void, reject: (e: Error) => void, timer: any }[]>>} kind -> project -> waiters */
    this.waiting = new Map(KINDS.map(k => [k, new Map()]));
    /** @type {Map<string, number>} kind -> the next project's turn, for round robin */
    this.turn = new Map();
    this.n = 0;
  }

  /** How many of a kind are held, box-wide or in one project. */
  count(kind, project = null) {
    let c = 0;
    for (const s of this.held.values()) if (s.kind === kind && (project == null || s.project === project)) c++;
    return c;
  }

  /** Is there room for one more of this kind in this project? */
  room(kind, project) {
    const l = this.o.limits();
    const box = l.box[kind] ?? BOX_DEFAULTS[kind];
    const mine = l.project(project)[kind];
    return (box <= 0 || this.count(kind) < box) && (mine == null || mine <= 0 || this.count(kind, project) < mine);
  }

  /**
   * Take a slot. Resolves at once when there is room and nobody of this kind waits ahead in the
   * project; otherwise waits its turn (or, with `wait` false, answers where it would be).
   * @param {Want} want @param {{ wait?: boolean, timeoutMs?: number }} [o]
   * @returns {Promise<Slot>|{ queued: true, position: number }}
   */
  take(want, { wait = true, timeoutMs = 10 * 60_000 } = {}) {
    if (!KINDS.includes(want.kind)) throw new Error(`a slot is a ${KINDS.join(" or ")}`);
    const again = [...this.held.values()].find(s => s.owner === want.owner && s.key === want.key && s.kind === want.kind);
    if (again) return Promise.resolve(again);
    const q = this.queue(want.kind, want.project);
    if (!q.length && this.room(want.kind, want.project)) return Promise.resolve(this.grant(want));
    const position = this.position(want.kind, want.project) + 1;
    if (!wait) { this.o.emit("slot.queued", { kind: want.kind, project: want.project, owner: want.owner, key: want.key, position, waiting: false }); return { queued: true, position }; }
    return new Promise((resolve, reject) => {
      const w = { want, at: this.now(), resolve, reject, timer: /** @type {any} */ (null) };
      w.timer = setTimeout(() => { if (this.drop(w)) reject(Object.assign(new Error(`no ${want.kind} slot came free in ${Math.round(timeoutMs / 60000)} minutes`), { code: "slot_timeout" })); }, timeoutMs);
      w.timer.unref?.();
      q.push(w);
      this.o.emit("slot.queued", { kind: want.kind, project: want.project, owner: want.owner, key: want.key, position, waiting: true });
    });
  }

  /** @param {Want} want */
  grant(want) {
    const s = { ...want, id: `s${++this.n}`, at: this.now() };
    this.held.set(s.id, s);
    this.o.emit("slot.taken", { id: s.id, kind: s.kind, project: s.project, owner: s.owner, key: s.key, held: this.count(s.kind, s.project) });
    return s;
  }

  /** Give a slot back; the next in line gets it. Releasing twice is harmless. @param {string} id */
  release(id) {
    const s = this.held.get(id);
    if (!s) return false;
    this.held.delete(id);
    this.o.emit("slot.released", { id, kind: s.kind, project: s.project, owner: s.owner, key: s.key });
    this.pump(s.kind);
    return true;
  }

  /** Give back every slot an owner holds (its turn ended, it stopped), and drop what it waits for. */
  releaseOwner(owner, kind = null) {
    let n = 0;
    for (const s of [...this.held.values()]) if (s.owner === owner && (!kind || s.kind === kind) && this.release(s.id)) n++;
    for (const k of KINDS) for (const q of this.waiting.get(k).values()) for (const w of [...q]) {
      if (w.want.owner === owner && (!kind || k === kind) && this.drop(w)) w.reject(Object.assign(new Error("the session that asked for it ended"), { code: "slot_cancelled" }));
    }
    return n;
  }

  /** Give back one slot by what it was for. */
  releaseKey(owner, key) {
    const s = [...this.held.values()].find(x => x.owner === owner && x.key === key);
    return s ? this.release(s.id) : false;
  }

  /** Grant waiters while there is room: projects in turn, oldest first within each. @param {string} kind */
  pump(kind) {
    const byProject = this.waiting.get(kind);
    for (let guard = 0; guard < 1000; guard++) {
      const projects = [...byProject.keys()].filter(p => byProject.get(p).length);
      if (!projects.length) return;
      const start = (this.turn.get(kind) || 0) % projects.length;
      let granted = false;
      for (let i = 0; i < projects.length; i++) {
        const p = projects[(start + i) % projects.length];
        if (!this.room(kind, p)) continue;
        const w = byProject.get(p).shift();
        clearTimeout(w.timer);
        this.turn.set(kind, (start + i + 1) % Math.max(1, projects.length));
        w.resolve(this.grant(w.want));
        granted = true;
        break;
      }
      if (!granted) break;
    }
    this.reposition(kind);
  }

  /** Say every waiter's new place after the line moved. @param {string} kind */
  reposition(kind) {
    for (const [p, q] of this.waiting.get(kind)) q.forEach((w, i) => this.o.emit("slot.queued", { kind, project: p, owner: w.want.owner, key: w.want.key, position: i + 1, waiting: true }));
  }

  queue(kind, project) {
    const m = this.waiting.get(kind);
    if (!m.has(project)) m.set(project, []);
    return /** @type {any[]} */ (m.get(project));
  }

  position(kind, project) { return this.queue(kind, project).length; }

  /** Take a waiter out of its line. */
  drop(w) {
    const q = this.queue(w.want.kind, w.want.project);
    const i = q.indexOf(w);
    if (i < 0) return false;
    q.splice(i, 1);
    clearTimeout(w.timer);
    this.reposition(w.want.kind);
    return true;
  }

  /** What is held and what waits, per kind and project, with the limits in force. */
  status() {
    const l = this.o.limits();
    /** @type {Record<string, any>} */ const out = {};
    for (const k of KINDS) {
      const projects = new Set([...[...this.held.values()].filter(s => s.kind === k).map(s => s.project), ...this.waiting.get(k).keys()]);
      out[k] = { limit: l.box[k] ?? BOX_DEFAULTS[k], held: this.count(k),
        projects: Object.fromEntries([...projects].map(p => [p, { limit: l.project(p)[k] ?? null, held: this.count(k, p), waiting: this.position(k, p) }])) };
    }
    return out;
  }
}
