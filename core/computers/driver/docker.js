// @ts-check
// docker: agent computers as containers, through the Docker Engine API (v1.43, JSON over HTTP).
//
// vyred never holds the raw Docker socket: whoever holds it is root on the box. It talks to a
// restricted proxy (config `computers.docker`, `http://host:port` or `unix:///path`) that lets
// through container create, start, pause, stop, inspect and list, and nothing else. There is no
// default: without the setting there is no Docker driver at all.
//
// The proxy decides which endpoints; this file decides which containers. Every operation first
// reads the container and refuses unless it carries `<prefix>.managed=true` and
// `<prefix>.computer=<agent>`, so a bug or a bad id can never stop, pause or delete someone's
// database container, whatever the proxy would allow.

import http from "node:http";
import { PORTS, SIZE } from "./index.js";
import { REQUIRED_CAPS, BOOT, bootTar, AGENT_TOKENS, agentTokensTar } from "./policy.js";

const API = "/v1.43";

export class DockerDriver {
  /**
   * @param {{ url: string, bearer: string, labelPrefix?: string, network?: string, capAdd?: string[], timeoutMs?: number }} opts
   */
  constructor(opts) {
    if (!opts || !opts.url) throw new Error("the docker driver needs computers.docker (the restricted proxy's URL)");
    this.name = "docker";
    this.prefix = opts.labelPrefix || "vyre";
    this.network = opts.network || null;
    // The image starts as root only to put the agent and Chrome under different users, which
    // needs SETUID and SETGID (REQUIRED_CAPS) and nothing more; a box that finds it needs another
    // adds exactly that one through computers.capAdd rather than this file growing a list.
    this.capAdd = [...new Set([...REQUIRED_CAPS, ...(Array.isArray(opts.capAdd) ? opts.capAdd.map(String) : [])])];
    this.timeoutMs = opts.timeoutMs || 30_000;
    const u = String(opts.url);
    if (u.startsWith("unix://")) this.target = { socketPath: u.slice("unix://".length) };
    else {
      const p = new URL(u);
      if (p.protocol !== "http:") throw new Error(`computers.docker must be http://host:port or unix:///path, not ${p.protocol}`);
      this.target = { host: p.hostname, port: Number(p.port || 80) };
    }
    if (!opts.bearer) throw new Error("the docker driver needs a bearer for the proxy -- there is no unauthenticated mode");
    this.bearer = String(opts.bearer);
  }

  get managedLabel() { return `${this.prefix}.managed`; }
  get computerLabel() { return `${this.prefix}.computer`; }

  /**
   * One Engine API request. Errors carry the method, path and Docker's own message, never the
   * body: a create body holds the computer's passwords.
   * @returns {Promise<{ status: number, body: any }>}
   */
  request(method, path, body) {
    return new Promise((resolve, reject) => {
      // A Buffer goes as it is (the .boot tar); anything else as JSON.
      const tar = Buffer.isBuffer(body);
      const data = body === undefined ? null : tar ? body : Buffer.from(JSON.stringify(body));
      const req = http.request({ ...this.target, method, path: API + path, timeout: this.timeoutMs,
        headers: { host: "docker", authorization: `Bearer ${this.bearer}`,
          ...(data ? { "content-type": tar ? "application/x-tar" : "application/json", "content-length": data.length } : {}) } }, res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      });
      req.on("timeout", () => req.destroy(new Error(`docker ${method} ${path} timed out`)));
      req.on("error", e => reject(new Error(`docker ${method} ${path}: ${e.message}`)));
      if (data) req.write(data);
      req.end();
    });
  }

  /**
   * Watch the Engine's die/oom/kill/stop events for this box's computers (through the proxy's /events). Calls
   * onEvent({ id, agent, action, exitCode, at }) for each; reconnects with a growing pause and asks for what it missed
   * with since=; calls onGap() after a reconnect so the caller can look at every computer once (an event can be lost
   * while the stream is down). Returns { stop() }.
   * @param {(e: { id: string, agent: string, action: string, exitCode: number|null, at: number }) => void} onEvent
   * @param {{ onGap?: () => void, log?: (m: string) => void }} [o]
   */
  watchEvents(onEvent, o = {}) {
    let stopped = false, req = null, last = 0, delay = 1000, timer = null, first = true;
    const open = () => {
      if (stopped) return;
      const path = `${API}/events${last ? `?since=${last}` : ""}`;
      req = http.request({ ...this.target, method: "GET", path, headers: { host: "docker", authorization: `Bearer ${this.bearer}` } }, res => {
        // An answer that is not a stream (an older proxy, an error): nothing is being heard, so look at every computer once now.
        if (res.statusCode !== 200) { res.resume(); if (o.onGap) o.onGap(); retry(`status ${res.statusCode}`); return; }
        delay = 1000;
        if (!first && o.onGap) o.onGap();
        first = false;
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", d => {
          buf += d;
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            let e; try { e = JSON.parse(line); } catch { continue; }
            const a = (e && e.Actor && e.Actor.Attributes) || {};
            if (e.time) last = Math.max(last, Number(e.time));
            if (!e.Actor || !e.Actor.ID || e.Type !== "container") continue;
            try { onEvent({ id: String(e.Actor.ID), agent: String(a[this.computerLabel] || ""), action: String(e.Action || e.status || ""), exitCode: a.exitCode != null ? Number(a.exitCode) : null, at: Number(e.time || 0) }); } catch { /* a listener's error is its own */ }
          }
        });
        res.on("end", () => retry("the stream ended"));
        res.on("error", e => retry(e.message));
      });
      req.on("error", e => retry(e.message));
      req.end();
    };
    const retry = why => {
      if (stopped) return;
      if (o.log) o.log(`docker events: ${why}; trying again in ${Math.round(delay / 1000)} s`);
      timer = setTimeout(open, delay);
      if (timer.unref) timer.unref();
      delay = Math.min(delay * 2, 30_000);
    };
    open();
    return { stop() { stopped = true; if (timer) clearTimeout(timer); if (req) req.destroy(); } };
  }

  /** A request that must succeed (2xx, or one of `ok`). */
  async must(method, path, body, ok = []) {
    const r = await this.request(method, path, body);
    if ((r.status >= 200 && r.status < 300) || ok.includes(r.status)) return r.body;
    const msg = r.body && typeof r.body === "object" && r.body.message ? r.body.message : `status ${r.status}`;
    throw new Error(`docker ${method} ${path}: ${msg}`);
  }

  /** Is this a container Vyre made? Reads its labels from the Engine, never from our own table. */
  managed(labels) {
    return Boolean(labels && labels[this.managedLabel] === "true" && labels[this.computerLabel]);
  }

  /**
   * Read a container and refuse it unless it is one of ours. Null when it does not exist.
   * @param {string} id
   */
  async guard(id) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(String(id))) throw new Error(`"${id}" is not a container id`);
    const r = await this.request("GET", `/containers/${encodeURIComponent(id)}/json`);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error(`docker GET /containers/${id}/json: ${(r.body && r.body.message) || "status " + r.status}`);
    const labels = (r.body && r.body.Config && r.body.Config.Labels) || {};
    if (!this.managed(labels)) throw new Error(`container ${id} does not carry ${this.managedLabel}=true and ${this.computerLabel}; Vyre refuses to touch it`);
    return r.body;
  }

  /** A container that must exist and be ours. */
  async own(id) {
    const c = await this.guard(id);
    if (!c) throw new Error(`no such container: ${id}`);
    return c;
  }

  /**
   * @param {import("./index.js").CreateSpec} spec
   *
   * Hardening (docs/adr/0009-container-hardening.md): the restricted proxy (box's
   * docker-socket-proxy) filters which Engine *endpoints* are reachable, not the *bodies* of the
   * requests it lets through. A create body could still ask for Privileged, a docker.sock bind,
   * host network or PID, extra capabilities or host devices, and the proxy would forward every
   * one of them. So none of those is ever read from `spec`, or from anything else — they are
   * hard-coded off here, the one place a create body is built.
   */
  async create(spec) {
    // The secrets go by seed(), never in Env: Docker hands Env to every exec in the container.
    for (const k of Object.keys(spec.env || {})) {
      if (k === "COMPUTERD_TOKEN" || k === "VNC_PASSWORD") throw new Error(`${k} must not be in a computer's Env; seed() puts it in /var/lib/vyre/.boot`);
    }
    const agent = String(spec.agent);
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(agent)) throw new Error(`"${agent}" is not an agent name`);
    if (String(spec.network || this.network || "") === "host") throw new Error("a computer never runs on the host network");
    const size = spec.size || SIZE;
    // Our labels win over anything passed in, so a computer is always recognisably ours.
    // run.vyre=1 is a fixed marker the box's compose stack filters on, independent of whatever
    // computers.labelPrefix is configured to (the box also expects that set to
    // "run.vyre.computers" so the prefix-based labels below read run.vyre.computers.computer=…).
    const labels = { ...(spec.labels || {}), [this.managedLabel]: "true", [this.computerLabel]: agent, "run.vyre": "1" };
    const network = spec.network || this.network;
    const body = {
      Image: spec.image,
      Hostname: agent,
      Env: Object.entries(spec.env || {}).map(([k, v]) => `${k}=${v}`),
      Labels: labels,
      // Exposed so the ports are documented on the container; never bound on the host.
      ExposedPorts: { [`${PORTS.vnc}/tcp`]: {}, [`${PORTS.helper}/tcp`]: {} },
      HostConfig: {
        ...(network ? { NetworkMode: network } : {}),
        // Never host PID: an agent's computer must never see the box's own processes. "" is the
        // Engine's own private namespace; "container" alone is not a mode (it needs ":<id>") and
        // the Engine refuses the create with "invalid PID mode".
        PidMode: "",
        NanoCpus: Math.round((spec.cpus || 2) * 1e9),
        Memory: Math.round((spec.memoryMb || 3072) * 1024 * 1024),
        PortBindings: {},
        PublishAllPorts: false,
        // Never privileged. Every capability is dropped but SETUID and SETGID, which entrypoint.sh
        // uses once to start Xvnc, computerd and Chrome as one user and the agent's desktop as
        // another; setpriv leaves each of those processes no capability at all. Privileged is not
        // a field CreateSpec has, and never will be: there is no parameter that can turn it on.
        Privileged: false,
        CapDrop: ["ALL"],
        CapAdd: this.capAdd,
        // No host devices: an agent's computer has no business touching /dev on the box.
        Devices: [],
        SecurityOpt: ["no-new-privileges"],
        // No custom seccomp: Docker applies its own default profile (already deny-by-default for
        // the syscalls that matter here, e.g. mount, ptrace, the kernel keyring) whenever
        // SecurityOpt carries no seccomp= entry. A hand-written profile risks silently breaking
        // Xvnc/xdotool/AT-SPI in ways that can't be diagnosed without a real container to run it
        // against, which this workstream does not have yet; the default is the safer choice
        // until there is one to test a tighter profile with.
        // Read-only root: only the agent's own home volume and the tmpfs mounts below are
        // writable. Xvnc's socket and lock live under /tmp (the X11 display), the session bus
        // dbus-launch starts needs /tmp and /run, and nothing outside /home/agent (the Chrome
        // profile, .vnc, .fluxbox, the log files entrypoint.sh writes) needs to persist or write
        // anywhere else.
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": "mode=1777,exec", "/run": "mode=0755", "/var/run": "mode=0755" },
        // Chrome keeps its renderers' shared memory in /dev/shm; Docker's 64 MB default crashes tabs.
        ShmSize: 1024 * 1024 * 1024,
        // Two named volumes: the agent's home, and computerd's and Chrome's own (the Chrome profile,
        // the VNC password), which the agent's uid cannot open.
        Mounts: [
          { Type: "volume", Source: spec.volume, Target: "/home/agent",
            VolumeOptions: { Labels: { [this.managedLabel]: "true", [this.computerLabel]: agent, "run.vyre": "1" } } },
          { Type: "volume", Source: spec.browserVolume || `${this.prefix}-browser-${agent}`, Target: "/var/lib/vyre",
            VolumeOptions: { Labels: { [this.managedLabel]: "true", [this.computerLabel]: agent, "run.vyre": "1" } } },
        ],
        RestartPolicy: { Name: "no" },
      },
    };
    if (size && !body.Env.some(e => e.startsWith("SCREEN="))) body.Env.push(`SCREEN=${size.w}x${size.h}`);
    const name = `${this.prefix}-computer-${agent}`;
    const r = await this.must("POST", `/containers/create?name=${encodeURIComponent(name)}`, body);
    return { id: String(r.Id) };
  }

  /**
   * The computer's secrets, as /var/lib/vyre/.boot in its own volume (0400, vyre), never in Env.
   * @param {string} id @param {{ computerd_token: string, vnc_password: string }} secrets
   */
  async seed(id, secrets) {
    await this.own(id);
    await this.must("PUT", `/containers/${encodeURIComponent(id)}/archive?path=${encodeURIComponent(BOOT.dir)}`, bootTar(secrets));
  }

  /**
   * A shared (browser-kind) computer's per-agent identity, as /var/lib/vyre/.agent-tokens (0400,
   * vyre), the same archive-API write .boot gets and the same directory. computerd's own
   * identifyClient (index.js) reads this once at start; it is not live-reloaded by this call
   * alone -- a caller that changes who is on a running computer must also make computerd notice
   * (team/archive/work-journals/glass.md's own note on revocation).
   * @param {string} id @param {Array<{ name: string, token: string }>} agents
   */
  async seedAgentTokens(id, agents) {
    await this.own(id);
    await this.must("PUT", `/containers/${encodeURIComponent(id)}/archive?path=${encodeURIComponent(AGENT_TOKENS.dir)}`, agentTokensTar(agents));
  }

  async start(id) { await this.own(id); await this.must("POST", `/containers/${encodeURIComponent(id)}/start`, undefined, [304]); }
  async pause(id) { await this.own(id); await this.must("POST", `/containers/${encodeURIComponent(id)}/pause`); }
  async unpause(id) { await this.own(id); await this.must("POST", `/containers/${encodeURIComponent(id)}/unpause`); }
  async stop(id) { await this.own(id); await this.must("POST", `/containers/${encodeURIComponent(id)}/stop?t=10`, undefined, [304]); }

  /** Remove the container. Its home volume is named, so it stays (v=false says so outright). */
  async remove(id) {
    if (!(await this.guard(id))) return;
    await this.must("DELETE", `/containers/${encodeURIComponent(id)}?v=false&force=true`, undefined, [404]);
  }

  /** @returns {Promise<import("./index.js").Inspection>} */
  async inspect(id) {
    const c = await this.guard(id);
    if (!c) return { state: "missing", host: null };
    const nets = (c.NetworkSettings && c.NetworkSettings.Networks) || {};
    const net = (this.network && nets[this.network]) || Object.values(nets)[0];
    const host = (net && net.IPAddress) || (c.Name ? String(c.Name).replace(/^\//, "") : null);
    const state = stateOf(c.State && c.State.Status);
    return { state, host, ...(state === "exited" && c.State && typeof c.State.ExitCode === "number" ? { exitCode: c.State.ExitCode } : {}) };
  }

  /**
   * One CPU/RAM/network sample (vitals, ADR 0014 part 9's follow-on: docker stats?stream=false
   * gives one pair of counters an interval apart already, so a single request is enough — no
   * polling loop, no streaming connection held open). Null fields when the container is not
   * running (docker answers 200 with zeroed counters while stopped; this returns null instead
   * of reporting 0% of nothing).
   * @returns {Promise<{ cpu: number|null, ram: number|null, ramLimit: number|null, netRx: number|null, netTx: number|null }>}
   */
  async stats(id) {
    const c = await this.own(id);
    if (String(c.State && c.State.Status) !== "running") return { cpu: null, ram: null, ramLimit: null, netRx: null, netTx: null };
    const body = await this.must("GET", `/containers/${encodeURIComponent(id)}/stats`);
    return reduceStats(body);
  }

  async list() {
    const filters = encodeURIComponent(JSON.stringify({ label: [`${this.managedLabel}=true`] }));
    const rows = await this.must("GET", `/containers/json?all=true&filters=${filters}`);
    // The filter is the proxy's to honour; the label check is ours, so it is done again here.
    return (Array.isArray(rows) ? rows : []).filter(c => this.managed(c.Labels))
      .map(c => ({ id: String(c.Id), agent: String(c.Labels[this.computerLabel]), state: stateOf(c.State) }));
  }
}

/** Docker's many states, folded into the four the pool reasons about. */
function stateOf(s) {
  if (s === "running" || s === "restarting") return "running";
  if (s === "paused") return "paused";
  return "exited";
}

/**
 * Pure: one Engine `/stats?stream=false` body to vitals' shape. cpu is the standard Docker CPU%
 * formula (the delta between the two samples the Engine already took, over the delta of the
 * whole system's, times the online CPUs) — never a second request. Anything missing or
 * non-finite comes back null rather than a misleading 0.
 * @param {any} s
 */
export function reduceStats(s) {
  const num = v => typeof v === "number" && Number.isFinite(v) ? v : null;
  const cpu = s && s.cpu_stats && s.cpu_stats.cpu_usage, precpu = s && s.precpu_stats && s.precpu_stats.cpu_usage;
  const cpuTotal = cpu && num(cpu.total_usage), precpuTotal = precpu && num(precpu.total_usage);
  const sysNow = s && s.cpu_stats && num(s.cpu_stats.system_cpu_usage), sysBefore = s && s.precpu_stats && num(s.precpu_stats.system_cpu_usage);
  const cpuDelta = cpuTotal !== null && cpuTotal !== undefined && precpuTotal !== null && precpuTotal !== undefined ? cpuTotal - precpuTotal : null;
  const sysDelta = sysNow !== null && sysNow !== undefined && sysBefore !== null && sysBefore !== undefined ? sysNow - sysBefore : null;
  const online = (s && s.cpu_stats && num(s.cpu_stats.online_cpus)) || (cpu && Array.isArray(cpu.percpu_usage) ? cpu.percpu_usage.length : null) || 1;
  const cpuPct = cpuDelta !== null && sysDelta !== null && sysDelta > 0 ? Math.round(cpuDelta / sysDelta * online * 100 * 10) / 10 : null;
  const mem = s && s.memory_stats;
  const usage = mem && num(mem.usage), limit = mem && num(mem.limit);
  const ram = usage !== null && usage !== undefined && limit ? Math.round(usage / limit * 100 * 10) / 10 : null;
  const nets = (s && s.networks && typeof s.networks === "object") ? Object.values(s.networks) : [];
  const sum = key => nets.length ? nets.reduce((a, n) => a + (num(n && n[key]) || 0), 0) : null;
  return { cpu: cpuPct, ram, ramLimit: limit || null, netRx: sum("rx_bytes"), netTx: sum("tx_bytes") };
}
