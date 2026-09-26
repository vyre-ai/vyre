// @ts-check
// `claude setup-token` driven from the onboarding page, so nothing is typed into a terminal.
//
// claude wants a terminal, so it runs under a pty: util-linux `script` on Linux, and a small
// python3 relay on macOS, whose `script` refuses a stdin that is not a terminal. The sign-in
// link is read from its output (an OSC 8 hyperlink or plain text), the code the callback page
// shows is typed into its prompt, and the long-lived token it prints is handed back. The output
// can hold the token, so it is never logged, returned or put in an error (floor rule 8).

import { spawn } from "node:child_process";

const AUTHORIZE = /https:\/\/[^\s\x07\x1b"'<>]*\/oauth\/authorize\?[^\s\x07\x1b"'<>]+/;
const TOKEN = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/;
const MAX = 256 * 1024;
const RELAY = `import os, pty, select, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
ins = [fd, 0]
while True:
    r = select.select(ins, [], [])[0]
    if fd in r:
        try: d = os.read(fd, 4096)
        except OSError: break
        if not d: break
        os.write(1, d)
    if 0 in r:
        d = os.read(0, 4096)
        if d: os.write(fd, d)
        else: ins.remove(0)
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
`;
const quote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The command that runs `claude setup-token` under a pty on this OS. */
export function ptyCommand(bin, platform = process.platform) {
  if (platform === "linux") return ["script", ["-qfc", `${quote(bin)} setup-token`, "/dev/null"]];
  return ["python3", ["-c", RELAY, bin, "setup-token"]];
}

/**
 * One sign-in at a time; a new start replaces the old one.
 * @param {{ bin?: () => string, platform?: string, linkWait?: number, tokenWait?: number, lifetime?: number }} [o]
 */
export function setupToken({ bin = () => process.env.VYRE_CLAUDE_BIN || "claude", platform = process.platform, linkWait = 30_000, tokenWait = 60_000, lifetime = 600_000 } = {}) {
  /** @type {{ child: import("node:child_process").ChildProcess, out: string, exited: boolean, timer: NodeJS.Timeout, wake: () => void } | null} */
  let run = null;

  function stop() {
    if (!run) return;
    const r = run; run = null;
    clearTimeout(r.timer);
    r.out = "";
    if (!r.exited) r.child.kill("SIGKILL");
  }

  /** Resolve with what `find` returns once it returns something, or null on exit or timeout. */
  function until(r, find, ms) {
    return new Promise(resolve => {
      const t = setTimeout(() => done(null), ms);
      const done = v => { clearTimeout(t); r.wake = () => {}; resolve(v); };
      r.wake = () => { const v = find(r.out); if (v) done(v); else if (r.exited) done(null); };
      r.wake();
    });
  }

  return {
    /** Start the sign-in; resolves to the link to open. */
    async start() {
      stop();
      const [cmd, args] = ptyCommand(bin(), platform);
      const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TERM: "xterm-256color" } });
      const r = { child, out: "", exited: false, timer: setTimeout(() => { if (run === r) stop(); }, lifetime), wake: () => {} };
      run = r;
      const take = d => { r.out = (r.out + d).slice(-MAX); r.wake(); };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      child.stdin.on("error", () => {});
      child.on("error", () => { r.exited = true; r.wake(); });
      child.on("exit", () => { r.exited = true; r.wake(); });
      const url = await until(r, out => (out.match(AUTHORIZE) || [])[0], linkWait);
      if (!url) { if (run === r) stop(); throw new Error("`claude setup-token` did not show a sign-in link; is Claude Code installed and up to date?"); }
      return url;
    },
    /** Type the code from the callback page; resolves to the token. */
    async finish(code) {
      const c = String(code || "").trim();
      if (!c || /\s/.test(c) || c.length > 512) throw new Error("paste the code the sign-in page showed, on its own");
      const r = run;
      if (!r || r.exited) throw new Error("the sign-in has ended; start it again");
      r.child.stdin.write(c + "\r");
      const token = await until(r, out => (out.match(TOKEN) || [])[0], tokenWait);
      stop();
      if (!token) throw new Error("Claude did not accept that code; start the sign-in again");
      return token;
    },
    active: () => Boolean(run && !run.exited),
    stop,
  };
}
