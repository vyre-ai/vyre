// @ts-check
// agent-files: vyred's side of an agent's folder on its computer (owner decision, 20 Oct 2026: the folder on the agent's computer is the ONE real copy; Files reads and writes it there, nothing
// syncs and nothing is copied). One file operation is one ticket: vyred registers it with agentd (the operation rides with the ticket and is checked there), connects to the relay, says the
// ticket, sends a write's bytes, and reads back one header line and the answer. The helper inside (image/agentd-fs.js) runs as the agent's own Linux user with computerd's /fs routes, so the
// path rules are the computer's, not this file's: this file only carries bytes and caps what it takes in.
//
// Who may ask is decided before this (core/files/agent-folder.js, then the computers.agent.files tool, which only the files module may call).

import crypto from "node:crypto";
import net from "node:net";

/** What one read brings back at most; a larger file is refused as too_large rather than cut. The same 8 MB as one Files download (core/files/space-drive.js MAX_UPLOAD). */
export const READ_MAX = 8 * 1024 * 1024;
/** The longest one operation may take, end to end. */
const OP_MS = 60_000;

const CODES = /** @type {Record<string, string>} */ ({ bad_path: "bad_input", bad_request: "bad_input", not_a_folder: "bad_input", not_a_file: "bad_input", wrong_size: "bad_input", range: "bad_input",
  denied: "denied", missing: "not_found", exists: "conflict", too_large: "too_large" });

/** A refusal from the computer, in the codes the rest of Vyre uses, with its message (which never carries an absolute path). @param {number} status @param {any} json */
function refusal(status, json) {
  const e = json && json.error ? json.error : {};
  const code = CODES[String(e.code)] || (status === 404 ? "not_found" : status === 403 ? "denied" : status === 409 ? "conflict" : status === 413 ? "too_large" : status >= 500 ? "failed" : "bad_input");
  return Object.assign(new Error(String(e.message || `the agent's computer answered ${status}`)), { code });
}

/**
 * One exchange with the relay: say the ticket, send the bytes, read the header line and up to `max` bytes of answer.
 * @param {{ host: string, port: number, hello: string }} at @param {Buffer | null} body @param {number} max
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: Buffer }>}
 */
export function exchange(at, body, max) {
  return new Promise((resolve, reject) => {
    const s = net.connect(at.port, at.host);
    /** @type {Buffer[]} */ const parts = []; let size = 0, done = false;
    const end = (/** @type {Error | null} */ err, /** @type {any} */ value) => { if (done) return; done = true; clearTimeout(timer); s.destroy(); err ? reject(err) : resolve(value); };
    const timer = setTimeout(() => end(Object.assign(new Error("the agent's computer did not answer in time: try again in a moment"), { code: "unavailable" })), OP_MS);
    s.on("connect", () => { s.write(at.hello); if (body && body.length) s.write(body); });
    s.on("data", c => {
      parts.push(c); size += c.length;
      // the header line is short; the body is held to `max` (one byte over is enough to know it is too large)
      if (size > max + 64 * 1024) end(Object.assign(new Error(`that file is larger than ${Math.round(max / 1048576)} MB, more than one Files call carries; open it on the agent's computer instead`), { code: "too_large" }), null);
    });
    // a refusal can come back before a write's bytes are all sent (the helper checks the path first): then the send fails, and the answer already here is still the answer
    s.on("error", e => { if (Buffer.concat(parts).indexOf(10) >= 0) return answer(); end(Object.assign(new Error(`the agent's computer could not be reached (${/** @type {any} */ (e).code || "error"}): try again in a moment`), { code: "unavailable" }), null); });
    s.on("close", () => answer());
    function answer() {
      if (done) return;
      const all = Buffer.concat(parts), nl = all.indexOf(10);
      if (nl < 0) return end(Object.assign(new Error("the agent's computer closed the connection without an answer: try again"), { code: "unavailable" }), null);
      let head; try { head = JSON.parse(all.subarray(0, nl).toString("utf8")); } catch { head = null; }
      if (!head || !Number.isInteger(head.status)) return end(Object.assign(new Error("the agent's computer gave an answer that is not one: try again, and if it repeats ask the owner to run computers.update"), { code: "unavailable" }), null);
      end(null, { status: head.status, headers: head.headers && typeof head.headers === "object" ? head.headers : {}, body: all.subarray(nl + 1) });
    }
  });
}

/**
 * The agent's folder, operation by operation. `ticket(agent, hello, spec)` registers the one-use ticket with agentd (AgentUsers.fsTicket), `where()` is the relay's address (pinned to this
 * vyred first), and `ready(agent)` makes sure the agent has its place on the computer and the computer answers (or throws `waking` / `unavailable`).
 * @param {{ ready: (agent: string) => Promise<void>, ticket: (agent: string, hello: string, spec: any) => Promise<void>, where: () => Promise<{ host: string, port: number }>, exchange?: typeof exchange }} d
 */
export function makeAgentFiles(d) {
  const swap = d.exchange || exchange;
  /** @param {string} agent @param {any} spec @param {Buffer | null} [body] @param {number} [max] */
  async function op(agent, spec, body = null, max = 64 * 1024) {
    await d.ready(agent);
    const hello = crypto.randomBytes(24).toString("base64url");
    try { await d.ticket(agent, hello, spec); }
    catch (e) {
      const m = String(/** @type {Error} */ (e).message);
      // agentd refused the operation itself (a path out of the home): the caller's to read; anything else is the computer not answering
      throw Object.assign(new Error(/could not ticket \(400/.test(m) ? m.replace(/^.*?\(400: /, "").replace(/\)$/, "") : `the agent's computer could not take that (${m}): try again in a moment`), { code: /could not ticket \(400/.test(m) ? "bad_input" : "unavailable" });
    }
    const at = await d.where();
    const r = await swap({ host: at.host, port: at.port, hello: `${hello}\n` }, body, max);
    if (r.status >= 400) { let json = null; try { json = JSON.parse(r.body.toString("utf8")); } catch {} throw refusal(r.status, json); }
    return r;
  }
  const json = (/** @type {{ body: Buffer }} */ r) => { try { return JSON.parse(r.body.toString("utf8")); } catch { throw Object.assign(new Error("the agent's computer gave an answer that is not one: try again, and if it repeats ask the owner to run computers.update"), { code: "unavailable" }); } };
  return {
    /** The entries directly in a folder: { entries: [{ name, kind: "dir"|"file"|"link"|"other", size, mtime, to?, readOnly? }], truncated }. @param {string} agent @param {string} path */
    list: async (agent, path) => json(await op(agent, { op: "list", path })),
    /** @param {string} agent @param {string} path */
    stat: async (agent, path) => json(await op(agent, { op: "stat", path })),
    /** A whole file, at most `max` bytes (too_large beyond). @param {string} agent @param {string} path @param {{ max?: number }} [o] */
    read: async (agent, path, o = {}) => {
      const max = Math.min(o.max ?? READ_MAX, READ_MAX);
      const r = await op(agent, { op: "read", path, range: `bytes=0-${max}` }, null, max + 1);
      // a range answer says the whole size; a file past the cap is refused, never cut
      const total = /\/(\d+)$/.exec(String(r.headers["content-range"] || ""));
      if ((total && Number(total[1]) > max) || r.body.length > max) throw Object.assign(new Error(`that file is larger than ${Math.round(max / 1048576)} MB, more than one Files call carries; open it on the agent's computer instead`), { code: "too_large" });
      return r.body;
    },
    /** Write a file: it must not exist unless `overwrite`. Counted and renamed into place by the computer. @param {string} agent @param {string} path @param {Uint8Array} bytes @param {{ overwrite?: boolean }} [o] */
    write: async (agent, path, bytes, o = {}) => json(await op(agent, { op: "write", path, size: bytes.length, overwrite: o.overwrite === true }, Buffer.from(bytes))),
    /** @param {string} agent @param {string} path */
    mkdir: async (agent, path) => json(await op(agent, { op: "mkdir", path })),
    /** @param {string} agent @param {string} from @param {string} to */
    move: async (agent, from, to) => json(await op(agent, { op: "move", from, to })),
    /** A delete: the item moves to the home's trash (.vyre-trash, never listed). @param {string} agent @param {string} path */
    trash: async (agent, path) => json(await op(agent, { op: "trash", path })),
  };
}
