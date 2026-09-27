// @ts-check
// The security floor, as far as a PreToolUse hook can enforce it (docs/SPEC.md section 11).
//
// Only two answers exist here: "deny" and "ask". Anything else is null, no opinion, and Claude
// Code's own permission settings decide as they would without Vyre. The floor never loosens
// Claude Code; it can only hold a call back.
//
// What is enforced now:
//   rule 8   no vault value on any screen: nothing reads, lists or copies the vault folder, and
//            nothing reaches Vyre's own internals (vyre.db, the socket, config, keys, logs).
//   rules 1, 2  nothing goes out as the user unseen: a tool that sends, posts or replies asks
//            first, and the question names where it is going. And the model cannot approve for
//            the user: no human-only `vyre` command, no raw client on vyred's socket, no forged
//            caller or presence header (docs/adr/0004-presence.md, layer 2).
// The Gate (M9) takes over outbound control properly; until then this is the backstop.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { socketPath } from "../config/index.js";
import { HUMAN_ONLY, PERSON_ONLY } from "../presence/index.js";
import { ownerDevice } from "../modules/index.js";
import { flatten, words, dynamic, globReaches } from "./shell.js";

/** Words in an MCP tool's own name that mean it sends something as the user. */
const SENDS = /(^|[_-])(send|post|reply|forward|publish|share|invite|tweet|dm|comment)([_-]|$)/i;
/**
 * The MCP hub's tools inside Vyre's own MCP server (ADR 0016), as `vyre mcp` or as the plugin:
 * a hub server name, then its tool. The hub holds their outward calls at the Gate itself, and its
 * rule is stricter than the name rule (unknown is outward), so rule 1 steps aside for them.
 */
const HUB = /^mcp__(?:vyre|plugin_vyre_vyre)__[a-z][a-z0-9-]{0,31}__./;
/**
 * Vyre module tools with a send word that hold at the Gate themselves, so rule 1 would only ask
 * about a call that already waits for the person. google.mail.send is always held (ADR 0016
 * decision 6). A Vyre tool that really sends, such as threads_send, is not listed and still asks.
 */
const GATED = new Set(["google_mail_send"].flatMap(t => [`mcp__vyre__${t}`, `mcp__plugin_vyre_vyre__${t}`]));
/** Where a sending tool keeps its destination, in the order worth showing. */
const DEST_KEYS = ["to", "channel", "channel_id", "recipient", "recipients", "email", "thread_id", "chat_id", "user", "url"];

/**
 * @param {{ tool: string, input: Record<string, any>, cwd?: string, home?: string, userHome?: string }} call
 * @returns {{ decision: "deny"|"ask"|null, reason?: string, rule?: number }}
 */
export function rules({ tool, input, cwd, home, userHome }) {
  const vyreHome = path.resolve(home || process.env.VYRE_HOME || path.join(os.homedir(), ".vyre"));
  const vault = path.join(vyreHome, "vault");

  // Rule 8. Paths in the input, or anywhere in a shell command, that reach into the vault.
  const text = mentions(input);
  const tilde = vault.startsWith(os.homedir()) ? "~" + vault.slice(os.homedir().length) : null;
  const hits = [vault, tilde].filter(Boolean).some(v => text.includes(/** @type {string} */ (v)))
    || candidatePaths(input).some(p => within(path.resolve(cwd || os.homedir(), untilde(p)), vault));
  // The Vault's master key on a Mac is a keychain item; a shell command that names it could print
  // it with the `security` tool, which the keychain trusts for items it wrote.
  const keychain = typeof input.command === "string" && /\bsecurity\b/.test(input.command) && /vyre-vault|dump-keychain|find-generic-password[^|;&]*-w/.test(input.command);
  if (hits || keychain) return { decision: "deny", rule: 8, reason: "Vyre keeps vault values off every screen. Use the item through the tool that declared it; the value itself is never read." };

  // VYRE_HOME by the name it was given and by its real path: /tmp is /private/tmp on a Mac.
  let real = vyreHome;
  try { real = fs.realpathSync(vyreHome); } catch {}
  for (const h of new Set([vyreHome, real])) {
    const routed = typeof input.command === "string" ? shellRoutes(input.command, { vyreHome: h, cwd, userHome }) : toolRoutes(tool, input, { vyreHome: h, cwd });
    if (routed) return routed;
  }

  // Rules 1 and 2. Only MCP tools: those are the ones that reach people (mail, chat, posts).
  if (tool.startsWith("mcp__") && !HUB.test(tool) && !GATED.has(tool)) {
    const own = tool.split("__").pop() || "";
    if (SENDS.test(own) && !/(^|_)(draft|list|get|search|read)(_|$)/i.test(own)) {
      const dest = DEST_KEYS.map(k => input[k]).find(v => v != null && v !== "");
      const where = dest == null ? "an unnamed destination" : Array.isArray(dest) ? dest.join(", ") : String(dest);
      return { decision: "ask", rule: 1, reason: `This sends as you, to ${where.slice(0, 200)}. Vyre asks before anything goes out.` };
    }
  }
  return { decision: null };
}

/** Every string in the input, joined, for substring checks. */
function mentions(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach(x => mentions(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach(x => mentions(x, out));
  return out.join("\n");
}

/** Values that look like paths: file_path, path, notebook_path, and every word of a shell command, resolved from cwd. */
function candidatePaths(input) {
  const out = [];
  for (const k of ["file_path", "path", "notebook_path"]) if (typeof input[k] === "string") out.push(input[k]);
  if (typeof input.command === "string") for (const tok of input.command.split(/[\s'"=;|&()<>]+/)) if (tok && !tok.startsWith("-")) out.push(tok);
  return out;
}

const untilde = p => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);
const within = (p, dir) => p === dir || p.startsWith(dir + path.sep);

const APPROVALS = "Approvals are the user's. Ask them to run it in their own terminal, or to use the Deck or the Capsule.";
const INTERNALS = "That is Vyre's own state. Use Vyre's tools instead; its store, socket, config and keys stay out of reach.";
const deny1 = reason => ({ decision: /** @type {const} */ ("deny"), rule: 1, reason });
const ask1 = reason => ({ decision: /** @type {const} */ ("ask"), rule: 1, reason });

/** `vyre <noun> <verb>` commands that only a person may run. `presence` is all of them. */
const HUMAN_VERBS = { gate: ["approve", "revise", "reject"], threads: ["answer"],
  vault: ["put", "approve", "unlock", "offboard", "run", "inject", "backup", "restore", "pair", "export", "kit", "delete", "reveal", "copy", "totp"],
  learn: ["accept", "retire", "relax", "skill"], computers: ["takeover", "giveback"], link: ["approve"] };
/** Tools a model's shell may never name: the floor's human-only list and the person's own actions. */
const MODEL_NEVER = new Set([...HUMAN_ONLY, ...PERSON_ONLY]);
const isVyre = w => path.basename(w) === "vyre" || /\/bin\/vyre(\.js)?$/.test(w);
const isHumanPair = (a, b) => a === "presence" || (HUMAN_VERBS[a] || []).includes(b) || (a === "call" && MODEL_NEVER.has(b));
/** Vyre's files by name, wherever they are: the store, its journal, the socket, the pid file. */
const INTERNAL_FILE = /(^|\/)(vyre\.db(-wal|-shm|-journal)?|vyred\.(sock|pid))$/;
/** Ways to talk to a unix socket without Vyre's client. */
const SOCKET_CLIENT = /--(abstract-)?unix-socket\b|\bUNIX-(CONNECT|CLIENT|SENDTO|LISTEN)\b|\bAF_UNIX\b|\bsocketPath\b|unix:\/\/|http\+unix|\bconnect_unix\b|\bUNIXSocket\b|\bUnixStream\b/i;
const GREPS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);

/**
 * Where a path falls in VYRE_HOME: null outside it, "watchers" and "modules" for the folders a
 * model may work in, "internal" for everything else.
 */
function place(p, vyreHome) {
  if (!within(p, vyreHome)) return null;
  const first = path.relative(vyreHome, p).split(path.sep)[0];
  return first === "watchers" || first === "modules" ? first : "internal";
}

/**
 * A Bash command: human-only vyre commands, raw socket clients, forged headers, and Vyre's internals.
 * @param {string} command @param {{ vyreHome: string, cwd?: string, userHome?: string }} o
 */
function shellRoutes(command, { vyreHome, cwd, userHome }) {
  const flat = flatten(command, userHome);
  // A command substitution stands in the word list as "$", a word whose value is unknown.
  const w = words(flat.replace(/\$\(|`/g, " $ "));
  const base = cwd || userHome || os.homedir();

  if (/x-vyre-(caller|presence)/i.test(flat)) return deny1("Only Vyre's own clients name a caller or carry a presence proof. " + APPROVALS);
  if (/\/v1\/presence\b/.test(flat)) return deny1(APPROVALS);

  // A human-only tool named anywhere in a command that reaches vyred.
  // `vyre box add` installs Vyre on a server over the user's SSH and pairs it with this Mac.
  if (w.some((x, i) => isVyre(x) && w[i + 1] === "box" && w[i + 2] === "add")) return ask1("This installs Vyre on a server with your SSH login and pairs it with this Mac.");
  // `vyre vault get|read --reveal` prints a value.
  if (w.some(isVyre) && w.includes("vault") && w.some(x => /^(get|read)$/.test(x)) && w.includes("--reveal")) return deny1("Vault values stay off every screen. " + APPROVALS);
  const named = [...MODEL_NEVER].some(t => flat.includes(t));
  if (named && (w.some(isVyre) || /\/v1\/tools\b/.test(flat) || SOCKET_CLIENT.test(flat))) return deny1(APPROVALS);

  // A vyre command, or a word the shell fills in, followed by a human-only noun and verb.
  const args = i => w.slice(i + 1).filter(x => !x.startsWith("-"));
  for (let i = 0; i < w.length; i++) {
    const [a, b] = args(i);
    if (isVyre(w[i])) {
      const [c, d] = args(i).filter(x => x !== "$");
      if (c && isHumanPair(c, d)) return deny1(APPROVALS);
      if (a && (dynamic(a) || (b && dynamic(b) && (a === "call" || HUMAN_VERBS[a])))) return ask1("This vyre command is built when it runs, so Vyre cannot tell whether it approves something for you.");
    } else if (dynamic(w[i]) && a && isHumanPair(a, b) && a !== "call") return deny1(APPROVALS);
  }

  // The clipboard may hold a value the Capsule or the Deck copied for the person.
  if (w.some(x => /^(pbpaste|xclip|xsel|wl-paste)$/.test(path.basename(x))) || /\bthe clipboard\b|NSPasteboard|generalPasteboard/i.test(flat)) {
    return { decision: "ask", rule: 8, reason: "The clipboard may hold a value you copied from the vault. Vyre asks before anything reads it." };
  }

  // Docker is root on the host. A container with the host's devices, namespaces, root folder or
  // docker socket is a way out of every rule here; any other raw client on the socket is asked about.
  const docker = w.findIndex(x => /^(docker|podman|nerdctl)$/.test(path.basename(x)));
  if (docker >= 0 && w.slice(docker + 1).some(x => /^(run|create|exec|compose|container|service|update)$/.test(x))) {
    const rootish = w.some(x => /^--(privileged|pid=host|ipc=host|uts=host|userns=host|cap-add|device|security-opt)\b/.test(x) || /^--(net|network)=host$/.test(x))
      || w.some((x, i) => /^(-v|--volume|--mount)$/.test(w[i - 1] || "") && /^(\/:|\/(etc|root|var\/run|run|proc|sys|dev|home|Users)\b|.*docker\.sock|src=\/[,:]|.*source=\/(,|$))/.test(x))
      || /(-v|--volume)[= ]?\/:|docker\.sock:/.test(flat);
    if (rootish) return deny1("A container with the host's root, devices or docker socket is root on this machine. Ask the user to run it.");
  }
  if ((SOCKET_CLIENT.test(flat) || w.some(x => /^-[a-zA-Z]*U/.test(x))) && /docker\.sock|containerd\.sock|podman\.sock/.test(flat)) return ask1("The container engine's socket is root on this machine.");
  // On the box, the Engine's API proxy for agents' computers passes any create body it is given:
  // only vyred's computers module may use it, and it builds every body itself (ADR 0009).
  if (/\bdocker-api\b|:237[56]\b/.test(flat)) return deny1("That is the Docker API the computers module uses. It is root on the box, so only vyred talks to it.");
  if (/\bDOCKER_HOST=|\s-H\s+(tcp|unix|ssh):\/\//.test(flat) && docker >= 0) return ask1("This points docker at another engine. Vyre asks, since an engine is root where it runs.");

  // Raw clients on a unix socket: vyred's is refused; one Vyre cannot read is asked about.
  const nc = w.some(x => /^(nc|ncat|netcat)$/.test(path.basename(x))) && w.some(x => /^-[a-zA-Z]*U/.test(x));
  if (SOCKET_CLIENT.test(flat) || nc) {
    const sock = socketPath(vyreHome);
    const tmp = path.dirname(sock).startsWith("/tmp/") ? path.dirname(sock) : null;
    if (/vyred\.sock|\/tmp\/vyre-/.test(flat) || flat.includes(vyreHome) || flat.includes(sock) || (tmp && flat.includes(tmp))) return deny1("That is vyred's socket. " + APPROVALS);
    const literal = w.some(x => /\.sock$/.test(x) && !dynamic(x));
    if (!literal || w.some(dynamic)) return ask1("This talks to a unix socket Vyre cannot identify from the command.");
  }

  // Vyre's internals: by file name anywhere (except as the pattern a grep searches for), by path,
  // and by a glob that could reach them.
  for (let i = 0; i < w.length; i++) {
    const x = w[i];
    const before = w.slice(0, i).filter(y => !y.startsWith("-")).pop();
    if (INTERNAL_FILE.test(x) && !(before && GREPS.has(path.basename(before)))) return { decision: "deny", rule: 8, reason: INTERNALS };
    if (x.includes("$")) continue;
    const abs = path.resolve(base, x);
    if (/[*?[]/.test(x)) {
      if (!globReaches(abs, vyreHome)) continue;
      const next = abs.split("/").filter(Boolean)[vyreHome.split("/").filter(Boolean).length];
      if (next === "watchers") continue;
      if (next === "modules") return { decision: "ask", rule: 8, reason: "A module runs inside vyred. Vyre asks before anything changes one." };
      return { decision: "deny", rule: 8, reason: INTERNALS };
    }
    if (!x.includes("/") && !x.startsWith(".")) continue;
    const at = place(abs, vyreHome);
    if (at === "internal") return { decision: "deny", rule: 8, reason: INTERNALS };
    if (at === "modules") return { decision: "ask", rule: 8, reason: "A module runs inside vyred. Vyre asks before anything changes one." };
  }
  return null;
}

/** The file tools: Read, Write, Edit, NotebookEdit, Grep and Glob, on Vyre's internals. */
function toolRoutes(tool, input, { vyreHome, cwd }) {
  const writes = ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool);
  const base = cwd || os.homedir();
  for (const k of ["file_path", "path", "notebook_path"]) {
    if (typeof input[k] !== "string") continue;
    const p = path.resolve(base, untilde(input[k]));
    if (INTERNAL_FILE.test(p)) return { decision: "deny", rule: 8, reason: INTERNALS };
    const at = place(p, vyreHome);
    if (at === "internal") return { decision: "deny", rule: 8, reason: INTERNALS };
    if (at === "modules" && writes) return { decision: "ask", rule: 8, reason: "A module runs inside vyred. Vyre asks before anything changes one." };
  }
  const glob = tool === "Glob" ? input.pattern : tool === "Grep" ? input.glob : null;
  if (typeof glob === "string") {
    const g = path.resolve(base, typeof input.path === "string" ? untilde(input.path) : ".", untilde(glob));
    if (INTERNAL_FILE.test(g) || globReaches(g, vyreHome)) return { decision: "deny", rule: 8, reason: INTERNALS };
  }
  return null;
}

/** Callers that are the person at one of Vyre's own surfaces, when they name no agent. The
 * owner's own Deck or phone at the box's address (`tailnet:<owner>`), or a device paired through
 * the relay (`device:<id>`), is one too. */
const PERSON = new Set(["cli", "local", "deck", "capsule"]);

/**
 * The same floor for every tool call through vyred's Registry (SPEC 5.3), not only Claude Code's
 * PreToolUse hook. A person at a surface is not held back here: presence and the Gate speak for
 * them. Every other caller (an agent through the switchboard, the Capsule or MCP, a module, a
 * guest or an agent node on the tailnet) gets the rules' answer, and "ask" is a refusal, since
 * nobody is there to answer.
 * @param {{ home: string }} o VYRE_HOME, for rule 8's paths
 * @returns {(call: { tool: string, input: any, caller: string }) => Promise<{ allow: boolean, reason?: string }>}
 */
export function registryRules({ home }) {
  return async ({ tool, input, caller }) => {
    const c = String(caller);
    if (PERSON.has(c) || ownerDevice(c)) return { allow: true };
    const v = rules({ tool, input: input && typeof input === "object" ? input : {}, home });
    if (v.decision === "deny") return { allow: false, reason: v.reason };
    if (v.decision === "ask") return { allow: false, reason: `${v.reason} Only a person can say yes, and ${c} is not one.` };
    return { allow: true };
  };
}
