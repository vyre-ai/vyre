// @ts-check
// The spawner: the one piece of the box that runs as root (ADR 0032 part 3).
//
// vyred runs as uid `vyre` and cannot change uid. A Vyre-owned Claude session must not run as
// `vyre`, or the model's shell could open vyred's socket, read the vault's files and act as the
// person. So vyred asks this server, over a socket only uid `vyre` can open, to start one session
// child as uid `vyre-agent`, and it hands the child's stdio back as plain connections.
//
// It starts nothing but an allowed program (the claude binary, under tini as a subreaper), in a
// cwd under /work, with an environment cut down to known keys. The container gives it no
// capability but SETUID, SETGID and KILL.
//
// Protocol, one JSON line to open each connection:
//   {"op":"spawn","argv":[...],"env":{...},"cwd":"/work/...","fd3":"..."}  -> {"id","pid"} then later {"exit":code,"signal":s}
//                                                                 fd3: written once to the child's fd 3 and closed
//                                                                 (an API key: Claude Code reads it there, its tools never see it)
//                                                                 the client may send {"kill":"SIGTERM"}
//   {"op":"io","id":"...","stream":"stdio"|"stderr"}            -> raw bytes: stdin in, stdout out; or stderr out
//   spawn may carry "account": <uid> (2000-2063 in the image) and "shared": true. The child then runs
//   as that account's own uid and gid, HOME at <accounts home>/<uid>, in no supplementary group
//   unless shared (only project work under /work needs the shared group). The HOME must exist, be
//   owned by that uid, and be closed to every other user: it is checked before every spawn.
//   {"op":"wipe","account":<uid>}                               -> {"wiped":true}: empties that account's HOME (as that uid)
//                                                                 so a uid handed to a new account holds nothing of the last
//   spawn may instead carry "role":"watcher" (the watcher wall, core/spawner/wall.js): argv[0] must be the watcher program
//   (node), the child runs as a uid taken from a pool (one per concurrent run, never shared), with no supplementary group, an
//   empty environment but HOME and TMPDIR inside a fresh 0700 folder that is emptied when it ends, and "ro": [absolute
//   paths it may read] checked. Refused while the wall's status file says it is not in place, and while NET_ADMIN is held.
// The child starts once both io connections are attached; a spawn nobody attaches to in 10 s ends.

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, execFileSync, execFile } from "node:child_process";

/** Environment keys a session child may get. Anything else (LD_PRELOAD, NODE_OPTIONS ...) is dropped. */
const ENV_KEYS = /^(HOME|PATH|LANG|LC_[A-Z]+|TERM|TZ|USER|SHELL|TMPDIR|NO_COLOR|FORCE_COLOR|VYRE_[A-Z0-9_]+|CLAUDE_CODE_[A-Z0-9_]+|CLAUDE_CONFIG_DIR|ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|OPENAI_API_KEY|OPENAI_BASE_URL|XAI_API_KEY|XAI_BASE_URL|CODEX_HOME|DISABLE_[A-Z0-9_]+|MCP_[A-Z0-9_]+)$/;
const SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"]);
const ATTACH_MS = 10_000;
const MAX_LIVE = 16;

/**
 * @param {{ socket: string, mode?: number, allow: string[], agent: { uid: number, gid: number, groups: number[] },
 *   work?: string, home?: string, wrap?: (argv: string[], cwd: string, who: Who) => string[], makeDir?: (dir: string, who: Who) => void, grantGroup?: (home: string, who: Who) => void, seed?: (home: string, who: Who, files: Record<string, string>) => void, log?: (m: string) => void,
 *   seed?: (home: string, who: Who, files: Record<string, string>) => void,
 *   grantGroup?: (home: string, who: Who) => void,
 *   accounts?: { min: number, max: number, home: string, shared?: number[], stat?: (dir: string) => import("node:fs").Stats|null, wipe?: (dir: string, who: Who) => void, place?: (home: string, who: Who, file: string, bytes: Buffer) => void | Promise<void> } }} o
 *   allow: programs argv[0] may name (absolute paths). wrap: how the child is started as its user;
 *   the default is setpriv plus umask 002 plus tini as a subreaper. A test passes identity.
 *   watcher: the watcher wall (role "watcher"): { min, max, home, allow, status, reprobe?, heldCap?, wrap?, makeDir?, wipe? }; without it a watcher spawn is refused
 *   accounts: the per-account uid range and where each HOME lives (ADR 0030 phase 2); without it
 *   a spawn naming an account is refused. shared: the groups an account joins only when asked
 *   (the /work group).
 * @typedef {{ uid: number, gid: number, groups: number[], home?: string, account?: number }} Who
 */
/** The most a placed transcript may be, decoded: a long chat's history. */
export const PLACE_MAX = 64 * 1024 * 1024;
/**
 * What runs AS THE ACCOUNT to write one transcript (op `place`): its own folder, a temp file made there, the bytes whole from stdin, mode 0600, renamed over the target, and refused outright when the folder or the file
 * is a link, when the folder is not the account's own, or when the target already exists as anything but a plain file. $1 = the file, $2 = the account's uid. Exported so a test runs the real logic.
 */
export const PLACE_SCRIPT = 'f="$1"; d=$(dirname -- "$f"); [ ! -L "$d" ] && [ ! -L "$f" ] || exit 11; q="$d"; while [ ! -e "$q" ]; do q=$(dirname -- "$q"); done; [ "$(readlink -f -- "$q")" = "$q" ] || exit 13; umask 077; mkdir -p -- "$d" || exit 12; [ "$(readlink -f -- "$d")" = "$d" ] && [ "$(stat -c %u -- "$d")" = "$2" ] || exit 13; { [ ! -e "$f" ] || { [ -f "$f" ] && [ "$(stat -c %u -- "$f")" = "$2" ]; }; } || exit 14; t=$(mktemp -p "$d" .place.XXXXXX) || exit 15; if cat > "$t" && chmod 0600 -- "$t" && mv -T -- "$t" "$f"; then exit 0; fi; rm -f -- "$t"; exit 16';

export async function serve(o) {
  const log = o.log || (() => {});
  const work = path.resolve(o.work || "/work");
  // The default changes directory as the agent, after setpriv: root here has no right to enter the
  // agent's home (no DAC capabilities), so the spawn itself starts in /.
  const custom = Boolean(o.wrap);
  const wrap = o.wrap || ((argv, cwd, who) => ["/usr/bin/setpriv", `--reuid=${who.uid}`, `--regid=${who.gid}`, who.groups.length ? `--groups=${who.groups.join(",")}` : "--clear-groups",
    "--inh-caps=-all", "--", "/bin/sh", "-c", 'umask 002; cd "$1" || exit 126; shift; exec "$@"', "sh", cwd, "/usr/bin/tini", "-s", "--", ...argv]);
  /** Write each file as the account's uid: mkdir -p, replace, 0600 (root cannot enter an account's HOME). */
  const defaultSeed = (home, who, files) => {
    for (const [rel, text] of Object.entries(files)) {
      const file = path.join(home, rel);
      execFileSync("/usr/bin/setpriv", [`--reuid=${who.uid}`, `--regid=${who.gid}`, "--clear-groups", "--inh-caps=-all", "--", "/bin/sh", "-c",
        'umask 077; mkdir -p "$(dirname "$1")" && rm -f "$1" && cat > "$1"', "sh", file], { input: text, stdio: ["pipe", "ignore", "ignore"] });
    }
  };
  const acc = o.accounts || null;
  const accountHome = uid => path.join(path.resolve(/** @type {any} */ (acc).home), String(uid));
  const lstat = /** @type {any} */ (acc && acc.stat) || (d => { try { return fs.lstatSync(d); } catch { return null; } });
  /** The identity a spawn runs as: the agent, or a numbered account. Null when the request names an account it may not. */
  function whoFor(req) {
    if (req.account === undefined) return { who: /** @type {Who} */ ({ ...o.agent, home: o.home }), why: null };
    const uid = req.account;
    if (!acc || !Number.isInteger(uid) || uid < acc.min || uid > acc.max) return { who: null, why: `account must be a uid from ${acc ? acc.min + " to " + acc.max : "a range this spawner has (none)"}` };
    const home = accountHome(uid);
    const st = lstat(home);
    if (!st || !st.isDirectory() || st.isSymbolicLink()) return { who: null, why: `account ${uid} has no home at ${home}` };
    // Owned by that uid, closed to everyone else. Group execute (no read, no write) is allowed and
    // only for the account's own group: vyred belongs to every account's group, so it can walk in
    // to the account's transcripts, and no other account is in that group.
    const gid = st.gid === undefined ? uid : st.gid;
    if (st.uid !== uid || (st.mode & 0o077 & ~0o010) !== 0 || ((st.mode & 0o010) !== 0 && gid !== uid)) return { who: null, why: `account ${uid}'s home is not private to it (owner ${st.uid}, mode ${(st.mode & 0o777).toString(8)})` };
    return { who: /** @type {Who} */ ({ uid, gid: uid, groups: req.shared === true ? [...(acc.shared || [])] : [], home, account: uid }), why: null };
  }
  // Programs by their real path, so a symlink (/bin/sh to dash) is the program it names.
  const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
  const allowed = new Set(o.allow.map(real));
  const wl = o.watcher || null;
  const watcherAllowed = new Set((wl ? wl.allow : []).map(real));
  /** The pool uids in use; one run holds one, and nothing else shares it. */
  const taken = new Set();
  let placing = 0;
  const takeUid = () => { if (!wl) return null; for (let u = wl.min; u <= wl.max; u++) if (!taken.has(u)) { taken.add(u); return u; } return null; };
  /** @type {Map<string, { req: any, control: net.Socket, stdio?: net.Socket, stderr?: net.Socket, child?: import("node:child_process").ChildProcess, timer: NodeJS.Timeout }>} */
  const live = new Map();

  const line = sock => new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = d => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf(10);
      if (i < 0) { if (buf.length > 256 * 1024) { sock.off("data", onData); reject(new Error("request too large")); } return; }
      sock.off("data", onData);
      sock.pause();
      const rest = buf.subarray(i + 1);
      if (rest.length) sock.unshift(rest);
      try { resolve(JSON.parse(buf.subarray(0, i).toString("utf8"))); } catch { reject(new Error("request is not JSON")); }
    };
    sock.on("data", onData);
    sock.once("error", reject);
  });

  /** A watcher spawn: why not, or null. Reserves nothing (the handler takes the uid). */
  function refuseWatcher(req) {
    if (!wl) return "this box has no watcher wall";
    const st = wl.status();
    if (!st.ok) return `the watcher wall is not in place${st.why ? ": " + st.why : ""}`;
    if (wl.heldCap && wl.heldCap()) return "the watcher wall is not in place: the spawner still holds NET_ADMIN";
    if (!Array.isArray(req.argv) || !req.argv.length || !req.argv.every(a => typeof a === "string" && !a.includes("\0"))) return "argv must be strings";
    if (!path.isAbsolute(req.argv[0]) || !watcherAllowed.has(real(req.argv[0]))) return `${req.argv[0]} is not a program a watcher may run`;
    for (const k of ["account", "shared", "seed", "fd3", "env"]) if (req[k] !== undefined) return `a watcher spawn takes no ${k}`;
    if (req.ro !== undefined && (!Array.isArray(req.ro) || req.ro.length > 16 || !req.ro.every(/** @param {any} r */ r => typeof r === "string" && path.isAbsolute(r) && !r.includes("\0") && r.length < 1024))) return "ro is a short list of absolute paths";
    if (live.size >= MAX_LIVE) return "too many sessions are running";
    if (taken.size >= wl.max - wl.min + 1) return "every watcher slot is busy";
    if (req.cwd !== undefined) {
      const cwd = path.resolve(String(req.cwd));
      const roots = [path.resolve(wl.home), ...(Array.isArray(req.ro) ? req.ro.map(r => path.resolve(r)) : [])];
      if (!roots.some(r => cwd === r || cwd.startsWith(r + path.sep))) return "cwd must be under a watcher folder or one of its ro paths";
    }
    return null;
  }

  /** Is this a spawn we will run? Returns why not, or null. */
  function refuse(req) {
    if (req.role !== undefined) { if (req.role !== "watcher") return "role is watcher or left out"; return refuseWatcher(req); }
    if (!Array.isArray(req.argv) || !req.argv.length || !req.argv.every(a => typeof a === "string" && !a.includes("\0"))) return "argv must be strings";
    if (!path.isAbsolute(req.argv[0]) || !allowed.has(real(req.argv[0]))) return `${req.argv[0]} is not a program the spawner starts`;
    if (req.fd3 !== undefined && (typeof req.fd3 !== "string" || req.fd3.length > 4096)) return "fd3 must be a short string";
    if (req.seed !== undefined) {
      if (req.account === undefined) return "seed files are for an account";
      const e = req.seed && typeof req.seed === "object" && !Array.isArray(req.seed) ? Object.entries(req.seed) : null;
      if (!e || e.length > 8 || e.some(([k, v]) => typeof v !== "string" || v.length > 65536 || typeof k !== "string" || !k || k.length > 200 || path.isAbsolute(k) || k.split(/[\\/]/).includes("..") || k.includes("\0"))) return "seed is up to 8 small files, by path inside the HOME";
    }
    if (req.account !== undefined && (typeof req.account !== "number" || (req.shared !== undefined && typeof req.shared !== "boolean"))) return "account is a uid and shared a boolean";
    const w = whoFor(req);
    if (w.why) return w.why;
    const cwd = path.resolve(String(req.cwd || work));
    const under = dir => dir && (cwd === dir || cwd.startsWith(dir + path.sep));
    // The work folder, or the runner's own home (an agent without a project works there).
    const home = /** @type {Who} */ (w.who).home;
    if (!under(work) && !under(home ? path.resolve(home) : null)) return `cwd must be under ${work}${home ? ` or ${home}` : ""}`;
    if (live.size >= MAX_LIVE) return "too many sessions are running";
    return null;
  }

  /** A watcher's pool uid goes back only after everything of it is gone: its processes, its folder and its files in /tmp. */
  function releaseWatcher(s) {
    if (!s.watcher || s.watcher.released) return;
    s.watcher.released = true;
    const { uid, who } = s.watcher;
    try { (wl.wipe || defaultWatchWipe)(who.home, who); } catch (e) { log(`spawner: cannot empty watcher folder ${who.home}: ${/** @type {Error} */ (e).message}`); }
    taken.delete(uid);
  }
  const asUid = (who, ...argv) => execFileSync("/usr/bin/setpriv", [`--reuid=${who.uid}`, `--regid=${who.gid}`, "--clear-groups", "--inh-caps=-all", "--", ...argv], { stdio: "ignore" });
  const defaultWatchDir = (dir, who) => asUid(who, "/bin/sh", "-c", 'umask 077; mkdir -p "$1"', "sh", dir);
  const defaultWatchWipe = (home, who) => {
    try { asUid(who, "/bin/sh", "-c", "kill -KILL -1"); } catch {}
    try { asUid(who, "/bin/rm", "-rf", home); } catch {}
    try { asUid(who, "/usr/bin/find", "/tmp", "/var/tmp", "-mindepth", "1", "-user", String(who.uid), "-delete"); } catch {}
  };
  const watcherWrap = (argv, cwd, who) => ["/usr/bin/setpriv", `--reuid=${who.uid}`, `--regid=${who.gid}`, "--clear-groups", "--inh-caps=-all", "--bounding-set=-all", "--", "/bin/sh", "-c",
    'umask 077; cd "$1" || exit 126; shift; exec "$@"', "sh", cwd, "/usr/bin/tini", "-s", "--", ...argv];

  function start(id) {
    const s = live.get(id);
    if (!s || !s.stdio || !s.stderr || s.child) return;
    clearTimeout(s.timer);
    const env = {};
    for (const [k, v] of Object.entries(s.watcher ? {} : s.req.env || {})) if (ENV_KEYS.test(k) && typeof v === "string" && !v.includes("\0")) env[k] = v;
    // Checked again here, at the moment of starting, not only when the request came in.
    const w = s.watcher ? { who: s.watcher.who, why: null } : whoFor(s.req);
    if (!w.who) { try { s.control.end(JSON.stringify({ error: w.why }) + "\n"); } catch {} end(id, w.why || "refused"); return; }
    const who = w.who;
    if (s.watcher) {
      // Its own fresh folder, made as that uid (root here has no right to write into one it does not own).
      env.HOME = who.home; env.TMPDIR = path.join(who.home, "tmp");
      try { (wl.makeDir || defaultWatchDir)(env.TMPDIR, who); } catch (e) { log(`spawner: cannot make ${env.TMPDIR}: ${/** @type {Error} */ (e).message}`); try { s.control.end(JSON.stringify({ error: "the watcher's folder could not be made" }) + "\n"); } catch {} end(id, "no folder"); return; }
    } else if (who.home) { env.HOME = who.home; env.USER = who.account !== undefined ? `acct${who.account}` : "vyre-agent"; }
    // The HOME's group can walk in (710): see whoFor. Done as that uid, which owns it.
    if (who.account !== undefined && who.home && o.grantGroup) { try { o.grantGroup(who.home, who); } catch (e) { log(`spawner: cannot open ${who.home} to its group: ${/** @type {Error} */ (e).message}`); } }
    // Config the provider reads, written fresh as the account's uid at every start.
    if (who.account !== undefined && who.home && s.req.seed) {
      try { (o.seed || defaultSeed)(who.home, who, s.req.seed); } catch (e) { log(`spawner: cannot write seed files: ${/** @type {Error} */ (e).message}`); }
    }
    // An account's scratch space is inside its HOME, so a wipe of the HOME leaves nothing of it in /tmp.
    if (who.account !== undefined && who.home) {
      env.TMPDIR = path.join(who.home, ".tmp");
      if (o.makeDir) { try { o.makeDir(env.TMPDIR, who); } catch (e) { log(`spawner: cannot make ${env.TMPDIR}: ${/** @type {Error} */ (e).message}`); } }
    }
    const cwd = path.resolve(String(s.req.cwd || (s.watcher ? who.home : work)));
    const argv = s.watcher ? (wl.wrap || watcherWrap)(s.req.argv, cwd, who) : wrap(s.req.argv, cwd, who);
    // A folder in the runner's home is made as that user, which owns that home (mkdir -p: root
    // here cannot even look inside it).
    if (!s.watcher && who.home && cwd.startsWith(path.resolve(who.home) + path.sep) && o.makeDir) {
      try { o.makeDir(cwd, who); } catch (e) { log(`spawner: cannot make ${cwd}: ${/** @type {Error} */ (e).message}`); }
    }
    const fd3 = typeof s.req.fd3 === "string";
    const child = spawn(argv[0], argv.slice(1), { cwd: custom ? cwd : "/", env, stdio: fd3 ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"], detached: true });
    if (fd3 && child.stdio[3]) { const p3 = /** @type {any} */ (child.stdio[3]); p3.on("error", () => {}); p3.end(s.req.fd3); }
    s.child = child;
    child.on("error", e => { try { s.control.end(JSON.stringify({ error: e.message }) + "\n"); } catch {} });
    s.stdio.pipe(/** @type {any} */ (child.stdin)).on("error", () => {});
    /** @type {any} */ (child.stdout).pipe(s.stdio).on("error", () => {});
    /** @type {any} */ (child.stderr).pipe(s.stderr).on("error", () => {});
    s.stdio.resume(); s.stderr.resume();
    s.control.write(JSON.stringify({ id, pid: child.pid }) + "\n");
    log(`spawner: started ${path.basename(s.req.argv[0])} as pid ${child.pid}${who.account !== undefined ? ` for account ${who.account}` : ""}`);
    // Once the child and its pipes are done: the exit on the control line, then every connection
    // closes, whether or not the client ever ended stdin.
    child.on("close", (code, signal) => {
      try { s.control.end(JSON.stringify({ exit: code, signal }) + "\n"); } catch {}
      for (const c of [s.stdio, s.stderr]) { try { c && c.end(); } catch {} setTimeout(() => { try { c && c.destroy(); } catch {} }, 1000).unref(); }
      setTimeout(() => { try { s.control.destroy(); } catch {} }, 1000).unref();
      live.delete(id);
      releaseWatcher(s);
    });
  }

  function end(id, why) {
    const s = live.get(id);
    if (!s) return;
    clearTimeout(s.timer);
    live.delete(id);
    if (s.child && s.child.exitCode === null) { try { process.kill(-(/** @type {number} */ (s.child.pid)), "SIGKILL"); } catch {} }
    for (const c of [s.control, s.stdio, s.stderr]) try { c && c.destroy(); } catch {}
    releaseWatcher(s);
    if (why) log(`spawner: ended ${id}: ${why}`);
  }

  // Half-open: the client ending stdin must not end the child's stdout on the same connection.
  /** @type {Set<net.Socket>} */
  const conns = new Set();
  const server = net.createServer({ allowHalfOpen: true }, async sock => {
    conns.add(sock);
    sock.on("close", () => conns.delete(sock));
    sock.on("error", () => {});
    let req;
    try { req = await line(sock); } catch (e) { sock.end(JSON.stringify({ error: /** @type {Error} */ (e).message }) + "\n"); return; }
    if (req.op === "spawn") {
      // A watcher: the wall is checked again right now. The rule lives in a namespace this container shares, so a status file that said ok at
      // start proves nothing about this moment. A failed check refuses the spawn in plain words and changes nothing.
      if (req.role === "watcher" && wl && wl.reprobe && wl.status().ok) {
        const again = await wl.reprobe();
        if (!again.ok) { sock.end(JSON.stringify({ error: `the watcher wall is not in place: ${again.why}` }) + "\n"); return; }
      }
      const why = refuse(req);
      if (why) { sock.end(JSON.stringify({ error: why }) + "\n"); return; }
      const id = crypto.randomBytes(16).toString("hex");
      const timer = setTimeout(() => end(id, "nobody attached"), ATTACH_MS);
      /** @type {any} */ let watcher = null;
      if (req.role === "watcher") {
        const uid = takeUid();
        if (uid === null) { clearTimeout(timer); sock.end(JSON.stringify({ error: "every watcher slot is busy" }) + "\n"); return; }
        watcher = { uid, who: /** @type {Who} */ ({ uid, gid: uid, groups: [], home: path.join(path.resolve(/** @type {any} */ (wl).home), String(uid)) }) };
      }
      live.set(id, { req, control: sock, timer, watcher });
      sock.write(JSON.stringify({ id }) + "\n");
      sock.resume();
      // Signals for the whole group: tini and the session under it, and what they started.
      let buf = "";
      sock.on("data", d => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const l = buf.slice(0, i); buf = buf.slice(i + 1);
          let m; try { m = JSON.parse(l); } catch { continue; }
          const s = live.get(id);
          if (m && SIGNALS.has(m.kill) && s && s.child && s.child.pid) { try { process.kill(-s.child.pid, m.kill); } catch {} }
        }
      });
      sock.on("close", () => { const s = live.get(id); if (s && !s.child) end(id, "closed"); });
      return;
    }
    if (req.op === "io") {
      const s = live.get(String(req.id || ""));
      if (!s || !["stdio", "stderr"].includes(req.stream) || s[req.stream]) { sock.destroy(); return; }
      s[req.stream] = sock;
      start(String(req.id));
      return;
    }
    if (req.op === "wipe") {
      const uid = req.account;
      const w = whoFor({ account: uid });
      if (!w.who || !acc) { sock.end(JSON.stringify({ error: w.why || "no accounts here" }) + "\n"); return; }
      // Never while a session of that account still runs.
      for (const s of live.values()) if (s.req.account === uid) { sock.end(JSON.stringify({ error: `account ${uid} still has a session running` }) + "\n"); return; }
      try {
        if (acc.wipe) acc.wipe(/** @type {string} */ (w.who.home), w.who);
        else {
          const as = (...argv) => execFileSync("/usr/bin/setpriv", [`--reuid=${w.who.uid}`, `--regid=${w.who.gid}`, "--clear-groups", "--inh-caps=-all", "--", ...argv], { stdio: "ignore" });
          // Anything of that uid still running (a process that left its session) goes first; then its files.
          try { as("/bin/sh", "-c", "kill -KILL -1"); } catch {}
          as("/usr/bin/find", /** @type {string} */ (w.who.home), "-mindepth", "1", "-delete");
          try { as("/usr/bin/find", "/tmp", "/var/tmp", "-mindepth", "1", "-user", String(w.who.uid), "-delete"); } catch {}
        }
        sock.end(JSON.stringify({ wiped: true }) + "\n");
      } catch (e) { sock.end(JSON.stringify({ error: `cannot empty account ${uid}'s home: ${/** @type {Error} */ (e).message}` }) + "\n"); }
      return;
    }
    if (req.op === "share") {
      // vyred seals an account's session from its transcript, which Claude writes 0600 in the account's own HOME. This makes THAT one file group-readable and writable (g+rw) so vyred, a member of the account's
      // group, can read it and put it back to a sealed turn in place (runner.recover): never the folder, never a symlink, never world-readable, and only a .jsonl under the account's own <HOME>/.claude/projects.
      const w = whoFor({ account: req.account });
      if (!w.who || !acc) { sock.end(JSON.stringify({ error: w.why || "no accounts here" }) + "\n"); return; }
      const home = /** @type {string} */ (w.who.home), file = typeof req.path === "string" && path.isAbsolute(req.path) ? path.resolve(req.path) : "";
      if (!file || file !== req.path || !file.startsWith(path.join(home, ".claude", "projects") + path.sep) || !file.endsWith(".jsonl")) { sock.end(JSON.stringify({ error: "only a .jsonl under the account's own .claude/projects can be shared" }) + "\n"); return; }
      try {
        if (acc.share) acc.share(home, w.who, file);
        else execFileSync("/usr/bin/setpriv", [`--reuid=${w.who.uid}`, `--regid=${w.who.gid}`, "--clear-groups", "--inh-caps=-all", "--", "/bin/sh", "-c",
          'r=$(readlink -f -- "$1") && [ "$r" = "$1" ] && [ -f "$r" ] && [ ! -L "$1" ] && [ "$(stat -c %u -- "$r")" = "$2" ] && chmod g+rw -- "$r"', "sh", file, String(w.who.uid)], { stdio: "ignore" });
        sock.end(JSON.stringify({ shared: true }) + "\n");
      } catch (e) { sock.end(JSON.stringify({ error: `cannot share that transcript: ${/** @type {Error} */ (e).message}` }) + "\n"); }
      return;
    }
    if (req.op === "place") {
      // vyred carries a chat on from a person's computer (core/runner/resume-lent.js): the transcript has to be the chat's own file in the account's own HOME, owned by the account, which only this process can make for
      // an account. Narrow on purpose: one plain .jsonl at <HOME>/.claude/projects/<folder>/<session>.jsonl of THAT account, written whole and renamed in as the account itself (so it can never touch what the account
      // may not), mode 0600, never through a link, never over anything that is not a plain file of the account's. The bytes follow the request line, exactly `size` of them, checked against `sha256`.
      const w = whoFor({ account: req.account });
      if (!w.who || !acc) { sock.end(JSON.stringify({ error: w.why || "no accounts here" }) + "\n"); return; }
      // Never over the transcript of a session that is running: it would be replaced under a running program (as wipe, it waits for the session to end).
      for (const s of live.values()) if (s.req.account === req.account) { sock.end(JSON.stringify({ error: `account ${req.account} still has a session running` }) + "\n"); return; }
      // a few at a time: each holds up to 64 MiB in memory until it is written
      if (placing >= 2) { sock.end(JSON.stringify({ error: "the spawner is placing other transcripts: try again in a moment" }) + "\n"); return; }
      const home = /** @type {string} */ (w.who.home), file = typeof req.path === "string" && path.isAbsolute(req.path) ? path.resolve(req.path) : "";
      const base = path.join(home, ".claude", "projects") + path.sep;
      if (!file || file !== req.path || !file.startsWith(base) || !/^[A-Za-z0-9_.-]{1,200}\/[A-Za-z0-9_-]{1,100}\.jsonl$/.test(file.slice(base.length)) || file.slice(base.length).split("/")[0] === "." || file.slice(base.length).split("/")[0] === "..") { sock.end(JSON.stringify({ error: "only <HOME>/.claude/projects/<folder>/<session>.jsonl of the account itself can be placed" }) + "\n"); return; }
      if (!Number.isInteger(req.size) || req.size < 1 || req.size > PLACE_MAX || typeof req.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(req.sha256)) { sock.end(JSON.stringify({ error: "a transcript is 1 byte to 64 MiB, with its sha256" }) + "\n"); return; }
      /** @type {Buffer} */ let bytes;
      placing++;
      try {
        bytes = await new Promise((resolve, reject) => {
          /** @type {Buffer[]} */ let parts = []; let n = 0;
          const timer = setTimeout(() => { sock.off("data", onData); parts = []; reject(new Error("the transcript did not arrive")); }, 30_000);
          // a client that goes away mid-body frees what it sent
          const gone = () => { clearTimeout(timer); sock.off("data", onData); parts = []; reject(new Error("the connection closed before the transcript arrived")); };
          sock.once("end", gone); sock.once("close", gone);   // a half-open server socket gets "end" when the client leaves, "close" only later
          const onData = (/** @type {Buffer} */ d) => { n += d.length; if (n > req.size) { clearTimeout(timer); sock.off("data", onData); reject(new Error("more bytes than the request said")); return; } parts.push(d); if (n === req.size) { clearTimeout(timer); sock.off("data", onData); resolve(Buffer.concat(parts)); } };
          sock.on("data", onData); sock.resume();
        });
      } catch (e) { placing--; sock.end(JSON.stringify({ error: /** @type {Error} */ (e).message }) + "\n"); return; }
      if (crypto.createHash("sha256").update(bytes).digest("hex") !== req.sha256) { placing--; sock.end(JSON.stringify({ error: "the transcript does not match its sha256" }) + "\n"); return; }
      try {
        // asynchronous with a limit: this process relays every live session's stdio, and a large write must never hold it still
        if (acc.place) await acc.place(home, w.who, file, bytes);
        else await new Promise((resolve, reject) => {
          const child = execFile("/usr/bin/setpriv", [`--reuid=${w.who.uid}`, `--regid=${w.who.gid}`, "--clear-groups", "--inh-caps=-all", "--", "/bin/sh", "-c", PLACE_SCRIPT, "sh", file, String(w.who.uid)], { timeout: 60_000, killSignal: "SIGKILL" }, e => (e ? reject(e) : resolve(undefined)));
          child.stdin?.on("error", () => {});
          child.stdin?.end(bytes);
        });
        sock.end(JSON.stringify({ placed: true }) + "\n");
      } catch (e) { sock.end(JSON.stringify({ error: `cannot place that transcript (${/** @type {any} */ (e).code ?? /** @type {Error} */ (e).message})` }) + "\n"); }
      finally { placing--; }
      return;
    }
    sock.end(JSON.stringify({ error: "unknown op" }) + "\n");
  });

  // Only vyred may connect. In the image the folder is root:vyre, 2750: the socket takes the vyre
  // group from it, with no capability to chown, and vyre-agent cannot even enter the folder.
  // The watchers' folders live under one sticky, world-writable parent: root cannot make a folder for another uid (no
  // capability to chown), so each child makes its own, and the sticky bit stops one from touching another's.
  if (wl) { try { fs.mkdirSync(wl.home, { recursive: true }); fs.chmodSync(wl.home, 0o1777); } catch (e) { log(`spawner: cannot make ${wl.home}: ${/** @type {Error} */ (e).message}`); } }
  fs.mkdirSync(path.dirname(o.socket), { recursive: true, mode: 0o700 });
  try { fs.rmSync(o.socket, { force: true }); } catch {}
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(o.socket, () => resolve(undefined)); });
  fs.chmodSync(o.socket, o.mode ?? 0o600);
  return {
    close: () => new Promise(r => { for (const id of [...live.keys()]) end(id, "stopping"); for (const c of conns) c.destroy(); server.close(() => r(undefined)); }),
    live: () => live.size,
  };
}
