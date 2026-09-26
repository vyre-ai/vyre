// @ts-check
// fake: an in-memory driver with Docker's state transitions, for tests.
//
// It keeps the same rules the Engine enforces (you cannot pause a stopped container, unpause a
// running one, or touch one that was removed) so a pool bug that would fail on the box fails here
// too. With `local`, every computer answers at one fixed address: the hands modules can then be
// tested against a real Chrome on this machine without any container.
//
// Instances are shared per key (vyred's home) through FakeDriver.for, because a real Docker
// outlives vyred: a restart test needs the "containers" to still be there when vyred comes back.

import { PORTS } from "./index.js";

/** @typedef {import("./index.js").CreateSpec} CreateSpec */

const shared = new Map();

export class FakeDriver {
  /** @param {{ local?: { host?: string, ports?: { vnc?: number, helper?: number, tailnet?: number } } }} [opts] */
  constructor(opts = {}) {
    this.name = "fake";
    this.local = opts.local || null;
    /** @type {Map<string, { id: string, agent: string, state: "created"|"running"|"paused"|"exited", spec: CreateSpec }>} */
    this.containers = new Map();
    /** Every operation, in order, so tests can assert what the pool asked for. */
    /** @type {Array<{ op: string, id?: string, agent?: string }>} */
    this.calls = [];
    this.n = 0;
  }

  /** The driver for one vyred home, made on first use and kept across restarts in this process. */
  static for(key, opts = {}) {
    let d = shared.get(key);
    if (!d) { d = new FakeDriver(opts); shared.set(key, d); }
    else if (opts.local) d.local = opts.local;
    return d;
  }

  static forget(key) { shared.delete(key); }

  /** @param {string} id */
  must(id) {
    const c = this.containers.get(id);
    if (!c) throw new Error(`no such container: ${id}`);
    return c;
  }

  /** @param {CreateSpec} spec */
  async create(spec) {
    const id = `fake-${++this.n}-${spec.agent}`;
    this.containers.set(id, { id, agent: spec.agent, state: "created", spec: { ...spec, env: { ...spec.env }, labels: { ...spec.labels } } });
    this.calls.push({ op: "create", id, agent: spec.agent });
    return { id };
  }

  async start(id) {
    const c = this.must(id);
    if (c.state === "paused") throw new Error(`container ${id} is paused; unpause it first`);
    c.state = "running";
    this.calls.push({ op: "start", id });
  }

  async pause(id) {
    const c = this.must(id);
    if (c.state !== "running") throw new Error(`container ${id} is not running`);
    c.state = "paused";
    this.calls.push({ op: "pause", id });
  }

  async unpause(id) {
    const c = this.must(id);
    if (c.state !== "paused") throw new Error(`container ${id} is not paused`);
    c.state = "running";
    this.calls.push({ op: "unpause", id });
  }

  async stop(id) {
    const c = this.must(id);
    c.state = "exited";
    this.calls.push({ op: "stop", id });
  }

  async remove(id) {
    this.must(id);
    this.containers.delete(id);
    this.calls.push({ op: "remove", id });
  }

  /** @returns {Promise<import("./index.js").Inspection>} */
  async inspect(id) {
    const c = this.containers.get(id);
    if (!c) return { state: "missing", host: null };
    const state = c.state === "created" ? "exited" : c.state;
    if (this.local) {
      const p = this.local.ports || {};
      return { state, host: this.local.host || "127.0.0.1", ports: { vnc: p.vnc || PORTS.vnc, helper: p.helper || PORTS.helper, ...(p.tailnet ? { tailnet: p.tailnet } : {}) } };
    }
    return { state, host: `fake-${c.agent}` };
  }

  async list() {
    return [...this.containers.values()].map(c => ({ id: c.id, agent: c.agent, state: c.state === "created" ? "exited" : c.state }));
  }
}
