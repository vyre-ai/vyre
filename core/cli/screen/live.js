// @ts-check
// What the screen knows, from vyred: the lists, one event stream, and the link line.
//
// The lists come from tools (projects.list, threads.list, threads.asks, gate.held, agents.list)
// and are read again only when an event says they changed, a quarter second after the last such
// event, so a burst of events costs one refresh. Nothing polls, apart from the link line once a
// minute. The stream is one connection for the whole screen, from `since=latest`; when it drops
// it comes back with Last-Event-ID, so vyred replays what was missed and nothing is lost.

import { backoff } from "../../resilience/backoff.js";
import http from "node:http";
import * as config from "../../config/index.js";
import { call, request } from "../../daemon/client.js";
import { parseSSE } from "../commands/threads.js";

/** @typedef {import("./model.js").Data} Data */

const list = r => (Array.isArray(r) ? r : []);

/** agents.list, or null when the switchboard has not brought agents yet. */
async function agentsNow() {
  const r = await call("agents.list", {});
  if (r.error) return null;
  return Array.isArray(r.data) ? r.data : Array.isArray(r.data?.agents) ? r.data.agents : [];
}

/**
 * Everything the list shows, except each project's sessions (see `sessions`).
 * @param {{ cwd?: string, sessions?: Record<string, any[]> }} [o]
 * @returns {Promise<Data>}
 */
export async function load({ cwd = process.cwd(), sessions = {} } = {}) {
  const [projects, agents, here, threads, asks, drafts, health] = await Promise.all([
    call("projects.list", {}), agentsNow(), call("projects.of", { cwd }), call("threads.list", {}), call("threads.asks", {}),
    call("gate.held", {}), request("GET", "/v1/health"),
  ]);
  if (projects.error) throw new Error(projects.error.message);
  return {
    projects: list(projects.data && projects.data.projects), agents, here: here.data?.slug || null,
    threads: threads.error ? [] : list(threads.data), asks: asks.error ? [] : list(asks.data),
    // No Gate module: no drafts section at all, rather than an empty one that can never fill.
    drafts: drafts.error ? null : list(drafts.data), sessions, health: health.data || null,
  };
}

/** One project's sessions, newest first. */
export async function sessions(slug) {
  const r = await call("projects.threads", { project: slug });
  return r.error ? [] : list(r.data);
}

/** Events that change what the lists show. Text deltas do not: they only touch a transcript. */
export const REFRESH = /^(thread\.(started|stopped|finished|sent)|ask\.|gate\.|lease\.changed|agent\.)/;

/**
 * The link line: one short phrase from link.health, when vyred has that tool. Kept apart so its
 * shape can change without touching anything else. Returns "" when there is nothing to say.
 * @param {string[]} tools names from GET /v1/tools
 */
export async function linkStatus(tools) {
  if (!tools.includes("link.health")) return "";
  const r = await call("link.health", {});
  if (r.error || !r.data) return "";
  return formatLink(r.data);
}

/** link.health's data as a phrase. Tolerant of shape: the tailnet team owns it. */
export function formatLink(d) {
  if (typeof d === "string") return "link " + d;
  // link.health as the tailnet team built it: { path: direct|relay|peer-relay|unknown, latencyMs, why }.
  if (d && typeof d.path === "string") {
    if (d.path === "unknown") return /not paired|say which node/.test(String(d.why || "")) ? "" : "link down";
    const ms = typeof d.latencyMs === "number" ? ` ${Math.round(d.latencyMs)} ms` : "";
    return `link ${d.path === "direct" ? "direct" : "relayed"}${ms}`;
  }
  const up = d.ok ?? d.up ?? d.healthy ?? (d.state ? ["up", "ok", "running", "connected"].includes(String(d.state)) : undefined);
  const where = d.address || d.name || d.host || "";
  const peers = typeof d.peers === "number" ? `${d.peers} peer${d.peers === 1 ? "" : "s"}` : Array.isArray(d.peers) ? `${d.peers.length} peers` : "";
  const word = up === undefined ? String(d.state || d.status || "") : up ? "up" : "down";
  return ["link " + (word || "?"), where, peers].filter(Boolean).join(" ");
}

/**
 * One event stream for the whole screen, reconnecting with backoff until stopped.
 * `since` is the last event the caller has already seen (vyred's last_event when it read the
 * lists), so events between that read and the stream opening are replayed, not lost. Without it
 * the stream starts from now.
 * @param {{ onEvent: (e: any) => void, onOpen?: () => void, onDown?: (why: string) => void, root?: string, since?: number }} o
 */
export function stream({ onEvent, onOpen, onDown, root, since = 0 }) {
  let last = Number(since) || 0;
  let gen = 0;
  // 2 s doubling to 60 s with jitter (ADR 0029, R3).
  const wait = backoff();
  let stopped = false;
  /** @type {http.ClientRequest|null} */
  let req = null;
  let timer = null;

  function connect() {
    if (stopped) return;
    const my = ++gen;
    const retry = why => again(why, my);
    const headers = { accept: "text/event-stream", "x-vyre-caller": "cli", ...(last ? { "last-event-id": String(last) } : {}) };
    req = http.request({ socketPath: config.paths(root).socket, path: `/v1/events/stream?type=*&since=${last ? last : "latest"}`, method: "GET", headers, agent: false }, res => {
      if (res.statusCode !== 200) { res.resume(); retry(`the event stream answered ${res.statusCode}`); return; }
      wait.reset();
      onOpen?.();
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", chunk => {
        const r = parseSSE(buf + chunk);
        buf = r.rest;
        for (const f of r.frames) {
          // vyred's `id:` on open and on each heartbeat: the cursor to resume from, before any event.
          if (!f.data) { const n = Number(f.id) || 0; if (n > last) last = n; continue; }
          let e;
          try { e = JSON.parse(f.data); } catch { continue; }
          const id = Number(e.id) || 0;
          // The box's log is behind this cursor: follow from where it says, and reload the lists.
          if (e.type === "stream.reset") { last = id; onOpen?.(); continue; }
          if (id && id <= last) continue;
          if (id) last = id;
          onEvent(e);
        }
      });
      res.on("end", () => retry("vyred closed the stream"));
      res.on("error", () => retry("lost the stream"));
    });
    req.on("error", err => retry(err.message));
    req.end();
  }
  function again(why, my) {
    // A dropped connection can report itself twice (end, then error): reconnect once.
    if (stopped || my !== gen) return;
    gen++;
    req = null;
    onDown?.(why);
    clearTimeout(timer);
    timer = setTimeout(connect, wait.delay());
  }
  connect();
  return {
    stop() { stopped = true; clearTimeout(timer); if (req) req.destroy(); req = null; },
    get last() { return last; },
  };
}
