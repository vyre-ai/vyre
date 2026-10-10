// @ts-check
// vitals: how the server and this device are doing (docs/design/vitals.md). Person-level only:
// vitals.status and vitals.watch refuse an agent outright; vitals.summary is the one tool an
// agent may call, and it structurally has no field a process name or a window title could ever
// occupy, not a filter applied after the fact.
//
// Idle (nobody watching): one sample a minute, only to feed the rollup. Watched
// (vitals.watch open, at least one subscriber): ~2 s, the same pace Glass already uses for a
// live viewer. Both cadences share one collector; only how often it is asked changes. Nothing
// here runs before the first ask (SPEC principle 8): the sampling timer starts on this module's
// first tick request, not at start().

import os from "node:os";
import { CpuSampler, NetSampler, ramNow, diskNow, batteryNow, gpuNow } from "./collect.js";
import { Store, MIGRATIONS, fold, minuteKey, hourKey } from "./store.js";

const isAgent = caller => /(?:^|[\s:])agent:/.test(String(caller || ""));
const refuse = (message, code = "denied") => Object.assign(new Error(message), { code });
const owner = (caller, what) => { if (isAgent(caller)) throw refuse(`"${caller}" is an agent; ${what} is the person's to read`); };

const IDLE_MS = 60_000;
const WATCH_MS = 2_000;
/** Kept in memory only, for a watcher's sparkline; never written to disk (docs/design/vitals.md, "Cadence and cost"). */
const BUFFER_MAX = Math.ceil(IDLE_MS / WATCH_MS) + 2;
/** A metric stays over its threshold for most of the last N samples: a `vitals.trouble` episode. */
const TROUBLE_WINDOW = 15;
const TROUBLE_FRACTION = 2 / 3;

const str = { type: "string" };
const obj = (properties = {}, required = []) => ({ type: "object", properties, required });

/**
 * Test seams, keyed by the VYRE_HOME a registry runs with (the same shape core/hooks/index.js
 * uses): `now`, `own` to stand in for this device's own real OS reads, and `computers` to stand
 * in for ctx.call("computers.list"/"computers.stats") without a real driver. Production never
 * sets them.
 * @type {Map<string, { now?: () => number, own?: () => { cpu: number|null, ram: number|null, gpu: number|null, disk: number|null, netRx: number|null, netTx: number|null, battery: number|null },
 *   computers?: () => Promise<Array<{ scope: string, cpu: number|null, ram: number|null, netRx: number|null, netTx: number|null }>> }>}
 */
export const seams = new Map();

export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const seam = (ctx.paths && seams.get(ctx.paths.root)) || {};
    const now = seam.now || Date.now;
    const store = new Store(ctx.store.db, now);
    const isServer = ctx.config.role === "box";
    const deviceName = () => isServer ? "server" : String((ctx.config && ctx.config.name) || os.hostname());
    const cfg = () => (ctx.config && ctx.config.vitals) || {};
    const thresholds = () => ({ cpu: 90, ram: 90, gpu: 95, disk: 95, ...(cfg().thresholds || {}) });

    const cpuSampler = new CpuSampler();
    const netSampler = new NetSampler();
    const diskPath = () => (isServer ? "/work" : ".") ;

    /** One instant read of every metric this platform can answer, never null-coalesced to 0. */
    async function readOnce() {
      if (seam.own) return seam.own();
      const [cpuR, ramR, gpuR] = await Promise.all([cpuSampler.read(), ramNow(), gpuNow()]);
      const netR = netSampler.read();
      const diskR = diskNow(diskPath());
      const batR = batteryNow();
      return { cpu: cpuR.cpu, ram: ramR.ram, gpu: gpuR.gpu, disk: diskR.disk, netRx: netR.netRx, netTx: netR.netTx, battery: batR.battery,
        why: { cpu: cpuR.why, ram: ramR.why, gpu: gpuR.why, disk: diskR.why, net: netR.why, battery: batR.why } };
    }

    /** Every running computer's own sample, scope "agent:<name>" (docs/design/vitals.md). Server only; empty elsewhere. */
    async function computerSamples() {
      if (seam.computers) return seam.computers();
      if (!isServer) return [];
      const list = await ctx.call("computers.list", {});
      if (list.error) return [];
      const running = (list.data.computers || []).filter(c => c.state === "running");
      const out = [];
      for (const c of running) {
        const r = await ctx.call("computers.stats", { agent: c.agent });
        if (!r.error) out.push({ scope: `agent:${c.agent}`, cpu: r.data.cpu, ram: r.data.ram, netRx: r.data.netRx, netTx: r.data.netTx });
      }
      return out;
    }

    /** device -> { scope -> { buffer: Array<sample>, at: number, trouble: Map<metric, boolean> } } */
    const state = new Map();
    const scopeState = (device, scope) => {
      if (!state.has(device)) state.set(device, new Map());
      const byScope = state.get(device);
      if (!byScope.has(scope)) byScope.set(scope, { buffer: [], trouble: new Map() });
      return byScope.get(scope);
    };

    let watchers = 0, timer = null, sampling = false;
    const busy = () => watchers > 0;

    /** One tick: sample, buffer, watch for a sustained breach, and roll a finished minute. */
    async function tick() {
      const at = now();
      const device = deviceName();
      const own = await readOnce();
      const samples = [{ scope: "", ...own }, ...(await computerSamples())];
      for (const s of samples) {
        const st = scopeState(device, s.scope);
        st.buffer.push({ at, cpu: s.cpu, ram: s.ram, gpu: s.gpu, disk: s.disk, netRx: s.netRx, netTx: s.netTx, battery: s.battery });
        if (st.buffer.length > BUFFER_MAX) st.buffer.shift();
        ctx.events.emit("vitals.sample", { device, scope: s.scope, cpu: s.cpu, ram: s.ram, gpu: s.gpu, disk: s.disk, netRx: s.netRx, netTx: s.netTx, battery: s.battery, at });
        checkTrouble(device, s.scope, st);
      }
      // Persist once a minute (idle or watched, the buffer holds whatever landed since the last
      // persist), then roll the hour that just finished and prune, both cheap and rare.
      const persistNow = !state.get(device).get("").lastPersist || at - state.get(device).get("").lastPersist >= IDLE_MS;
      if (persistNow) {
        for (const [scope, st] of state.get(device)) {
          const win = st.buffer.filter(b => at - b.at < IDLE_MS);
          const row = { minute: minuteKey(at), device, scope };
          for (const m of ["cpu", "ram"]) { const f = fold(win.map(b => b[m])); row[m] = f.mean; row[`${m}Max`] = f.max; }
          for (const m of ["gpu", "disk", "netRx", "netTx", "battery"]) row[m] = win.length ? win[win.length - 1][m] : null;
          store.record(row);
        }
        state.get(device).get("").lastPersist = at;
        const finishedHour = hourKey(at - IDLE_MS);
        if (finishedHour !== state.get(device).get("").lastHour) {
          store.rollupHour(finishedHour);
          store.prune();
          state.get(device).get("").lastHour = finishedHour;
        }
      }
    }

    /** A metric over threshold for most of the trouble window: one event per episode. */
    function checkTrouble(device, scope, st) {
      for (const metric of ["cpu", "ram", "gpu", "disk"]) {
        const th = thresholds()[metric];
        const recent = st.buffer.slice(-TROUBLE_WINDOW).map(b => b[metric]).filter(v => typeof v === "number");
        const over = recent.filter(v => v >= th).length;
        const breaching = recent.length >= Math.min(TROUBLE_WINDOW, 3) && over / recent.length >= TROUBLE_FRACTION;
        const was = st.trouble.get(metric) || false;
        if (breaching && !was) {
          st.trouble.set(metric, true);
          ctx.events.emit("vitals.trouble", { device, scope, metric, value: recent[recent.length - 1], minutes: recent.length });
        } else if (!breaching && was) {
          st.trouble.set(metric, false);
        }
      }
    }

    const schedule = () => {
      timer = setTimeout(async () => {
        if (!sampling) { sampling = true; try { await tick(); } catch (e) { ctx.log(`vitals: sample failed: ${/** @type {Error} */ (e).message}`); } sampling = false; }
        schedule();
      }, busy() ? WATCH_MS : IDLE_MS);
      timer.unref();
    };
    schedule();

    const bufferOf = (device, scope) => (state.get(device) && state.get(device).get(scope) && state.get(device).get(scope).buffer) || [];

    /** Everything but the aggregate summary is the person's (owner() still refuses a named agent); watch opens a 2 s sampler, so it writes. */
    const PEOPLE = ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device"];
    const EFFECT = { "vitals.watch": "write" };
    const tool = (name, description, input, run) => ctx.tool(name, { description, input, run, effect: EFFECT[name] || "read", ...(name === "vitals.summary" ? {} : { callers: PEOPLE }) });

    tool("vitals.watch", "Open or close one live subscription to this device's vitals, at ~2s while at least one is open. Answers the current sample and the in-memory sparkline buffer.",
      obj({ action: { type: "string", enum: ["open", "close"] }, device: str, scope: str }, ["action"]), async (i, { caller }) => {
        owner(caller, "watching vitals");
        if (i.action === "open") watchers++; else watchers = Math.max(0, watchers - 1);
        const device = i.device || deviceName();
        return { watchers, device, buffer: bufferOf(device, i.scope || "") };
      });

    tool("vitals.status", "Full detail for one device: its latest sample, 24h minute history, and (on the server) each running computer's own breakdown. Person-level only.",
      obj({ device: str }), async (i, { caller }) => {
        owner(caller, "reading vitals in full");
        const device = i.device || deviceName();
        const latest = store.latest(device, "");
        const history = store.history(device, "", now() - 24 * 3600_000);
        const computers = isServer ? (await computerSamples()).map(c => ({ scope: c.scope, latest: store.latest(device, c.scope) })) : [];
        return { device, latest, history, computers };
      });

    tool("vitals.summary", "Aggregate numbers only, never process names or window titles: this device's latest sample, or an agent's own computer. Any caller.",
      obj({ device: str }), async (i, { caller }) => {
        const claim = /^mcp:agent:(.+)$/.exec(String(caller || ""));
        const device = i.device || deviceName();
        const scope = claim ? `agent:${claim[1]}` : "";
        const row = store.latest(device, scope);
        if (!row) return { device, scope, cpu: null, ram: null, gpu: null, disk: null, netRx: null, netTx: null, battery: null };
        return { device, scope, cpu: row.cpu, ram: row.ram, gpu: row.gpu, disk: row.disk, netRx: row.netRx, netTx: row.netTx, battery: row.battery };
      });

    tool("vitals.explain", "A compact digest for IQ: the top consumer over the last 15 minutes, any open trouble episode, and the trend. Person-level only.",
      obj({ device: str }), async (i, { caller }) => {
        owner(caller, "explaining vitals");
        const device = i.device || deviceName();
        const history = store.history(device, "", now() - 15 * 60_000);
        const trend = m => {
          const v = history.map(r => r[m]).filter(x => typeof x === "number");
          if (v.length < 2) return "flat";
          const d = v[v.length - 1] - v[0];
          return d > 10 ? "rising" : d < -10 ? "falling" : "flat";
        };
        const top = ["cpu", "ram", "gpu", "disk"].map(m => ({ metric: m, max: fold(history.map(r => r[`${m}Max`] ?? r[m])).max })).filter(x => x.max !== null).sort((a, b) => b.max - a.max)[0] || null;
        const byScope = state.get(device);
        const open = [];
        if (byScope) for (const [scope, st] of byScope) for (const [metric, on] of st.trouble) if (on) open.push({ scope, metric });
        return { device, top, trend: { cpu: trend("cpu"), ram: trend("ram") }, trouble: open };
      });

    tool("vitals.advice", "Sizing suggestions from the last 30 days of hourly rollups (for example, RAM at 90% or more on several days this week). Read on demand only, never pushed. Person-level only.",
      obj({ device: str }), async (i, { caller }) => {
        owner(caller, "reading sizing advice");
        const device = i.device || deviceName();
        const th = thresholds();
        const lines = [];
        for (const [metric, label] of [["ram", "RAM"], ["cpu", "CPU"]]) {
          const week = store.breaches(device, "", metric, th[metric], 7);
          if (week >= 3) lines.push(`${label} hit ${th[metric]}% or more ${week} times this week.`);
        }
        return { device, advice: lines };
      });

    return {
      // Test-only surface (mod.handle.tick(), .store): production never calls these directly,
      // the schedule() timer does. A test forces a tick instead of waiting up to 60s for one.
      tick, store,
      async stop() { if (timer) clearTimeout(timer); },
    };
  },
};
