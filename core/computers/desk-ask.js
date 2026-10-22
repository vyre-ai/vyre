// @ts-check
// desk-ask: the two asks that use the agent's own desk. A command is typed into the desk terminal
// (tmux session "desk", the same socket and session the dock opens). A file is written into the
// agent's home through the folder Files already uses, so it shows under the agent's folder.
//
// An agent may ask only for its own computer. A person needs the right to edit the agent.
// Harness sessions still run on the server; this file does not move them.

import { agentClaim } from "../modules/index.js";
import { userNameOf } from "./agent-users.js";
import { homeOf } from "./image/agentd.js";

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const AGENT = /^[a-z][a-z0-9._-]{1,80}$/;
const DESK = "desk";

/**
 * @param {{ tool: (name: string, description: string, input: any, run: (i: any, meta: any) => Promise<any>, extra?: any) => void,
 *   users: import("./agent-users.js").AgentUsers, files: { write: (agent: string, path: string, bytes: Uint8Array, o?: { overwrite?: boolean }) => Promise<any>, mkdir: (agent: string, path: string) => Promise<any> },
 *   place: (agent: string) => Promise<any>, mayUse: (need: "use" | "edit", agent: string) => Promise<void>, callers: string[] }} d
 */
export function registerDeskAsk(d) {
  /** @param {any} i */
  const named = i => {
    const agent = String(i && i.agent || "");
    if (agent && !AGENT.test(agent)) throw Object.assign(new Error(`"${agent}" is not an agent`), { code: "bad_input" });
    return agent;
  };
  /** The agent on its own computer, or a person who may edit the named agent. @param {string} agent @param {string} caller */
  const allow = async (agent, caller) => {
    if (agentClaim(caller) === agent) return;
    await d.mayUse("edit", agent);
  };
  /** @param {any} i @param {string} caller */
  const who = (i, caller) => {
    const agent = named(i) || agentClaim(caller) || "";
    if (!AGENT.test(agent)) throw Object.assign(new Error("name the agent"), { code: "bad_input" });
    return agent;
  };

  d.tool("computers.agent.terminal.run", "Type one command into the agent's Terminal, the desk session, and press Enter. The session is the one the dock opens, so the person sees it on the agent's computer. One line. An agent may run it on its own computer; a person needs the right to edit the agent.",
    obj({ agent: str, command: str }, ["command"]), async (i, { caller }) => {
      const agent = who(i, String(caller || ""));
      await allow(agent, String(caller || ""));
      const command = String(i.command ?? "");
      if (!command || command.includes("\0") || command.includes("\n") || command.length > 2000) throw Object.assign(new Error("a command is one line, at most 2000 characters"), { code: "bad_input" });
      const row = await d.place(agent);
      const user = userNameOf(row.uid);
      const home = homeOf(user);
      const sock = `/var/lib/vyre/agents/${user}/tmux.sock`;
      await d.users.exec(agent, { argv: ["/usr/bin/tmux", "-S", sock, "new-session", "-d", "-A", "-s", DESK, "-c", home], cwd: home });
      await d.users.exec(agent, { argv: ["/usr/bin/tmux", "-S", sock, "send-keys", "-t", DESK, command, "Enter"], cwd: home });
      return { agent, session: DESK, command };
    }, { callers: d.callers });

  d.tool("computers.agent.file.make", "Make a file in the agent's Files, in the agent's own folder on its computer. The same bytes show in Vyre Files under the agent's folder. An agent may write its own folder; a person needs the right to edit the agent.",
    obj({ agent: str, path: str, text: str }, ["path", "text"]), async (i, { caller }) => {
      const agent = who(i, String(caller || ""));
      await allow(agent, String(caller || ""));
      const rel = String(i.path || "");
      if (!rel || rel.includes("\0") || /^[\\/~]/.test(rel) || rel.split(/[\\/]+/).includes("..")) throw Object.assign(new Error("path is inside the agent's folder"), { code: "bad_input" });
      const text = String(i.text ?? "");
      if (text.includes("\0")) throw Object.assign(new Error("the file is text"), { code: "bad_input" });
      await d.place(agent);
      const parts = rel.split("/");
      if (parts.length > 1) {
        let dir = "";
        for (const p of parts.slice(0, -1)) {
          dir = dir ? `${dir}/${p}` : p;
          try { await d.files.mkdir(agent, dir); } catch (e) { if (/** @type {any} */ (e).code !== "conflict") throw e; }
        }
      }
      const bytes = Buffer.from(text, "utf8");
      await d.files.write(agent, rel, bytes, { overwrite: true });
      return { agent, path: rel, size: bytes.length };
    }, { callers: d.callers });
}
