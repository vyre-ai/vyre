// @ts-check
// A throwaway world for driving Glass's live view in a real browser: a temp VYRE_HOME, a real
// vyred with the computers module on the fake driver (no Docker), a fake Xvnc TCP server standing
// in for the container's screen, and the same HTTP+WS proxy deck/test/world.js uses so the real
// Deck page and the real Glass WebSocket relay are exercised end to end.
//
// A test helper, not part of the product. Never touches ~/.vyre.
//
//   node deck/test/glass-world.js [port]      prints the URL, runs until Ctrl-C, then tears down

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeXvnc } from "../../test/fixtures/fake-xvnc.js";
import { SCRATCH } from "../../test/scratch.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// A 1x1 white JPEG, standing in for a real screenshot: enough for a real <img> to decode and a
// real canvas to draw, which is the point (sight.frame's own contract, not its pixel content).
const STILL_JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=";

/** Written into the world's own home so a real sight.frame has a real hands-desktop.screenshot
 * to call (sight is box+local, loaded like any other module; this is a home module, discovered
 * from config.paths(root).modules, never touching the repo checkout). */
function writeFakeHandsDesktop(root) {
  const dir = path.join(root, "modules", "hands-desktop");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "module.json"), JSON.stringify({
    name: "hands-desktop", version: "0.1.0", roles: ["box", "local"],
    does: { tools: ["hands-desktop.screenshot"] }, watches: { emits: [] },
  }));
  fs.writeFileSync(path.join(dir, "index.js"), `export default { async start(ctx) {
    ctx.tool("hands-desktop.screenshot", { input: { type: "object" }, callers: ["module"],
      run: async () => (${JSON.stringify({ image: STILL_JPEG, mime: "image/jpeg" })}) });
    return {};
  } };`);
}

/**
 * @param {{ agent?: string, width?: number, height?: number }} [o]
 */
export async function buildGlassWorld({ agent = "kit", width = 1024, height = 768 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vy-glass-")));
  if (path.resolve(root) === path.resolve(os.homedir(), ".vyre")) throw new Error("refusing to use the real ~/.vyre");
  const xvnc = await fakeXvnc({ width, height, name: `${agent}'s screen` });
  writeFakeHandsDesktop(root);

  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    name: "alex", role: "box", projectsDir: path.join(root, "projects"), roots: [],
    recall: { vectors: false, download: false },
    vault: { keystore: "file", breach: "off" },
    // The fake driver: every "container" answers at this one fixed address, the fake Xvnc above.
    // helper points at a port nothing listens on: this world never opens Files or takes over
    // through computerd, only the screen stream.
    // size mirrors the fake Xvnc's own dimensions: pool.size() answers from config, the way a
    // real deployment keeps the container's Xvnc size and the pool's advertised size in sync.
    computers: { driver: "fake", local: { host: "127.0.0.1", ports: { vnc: xvnc.port, helper: 1 } }, screens: 1, size: { w: width, h: height } },
  }, null, 2));
  const env = { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1", VYRE_HARNESS_DIR: path.join(root, "no-harness") };

  const { socketPath } = await import("../../core/config/index.js");
  const { call } = await import("../../core/daemon/client.js");
  const sock = socketPath(root);

  const { spawn } = await import("node:child_process");
  const daemon = spawn(process.execPath, [path.join(REPO, "core", "daemon", "main.js")], { env, stdio: "inherit" });
  const answers = () => call("system.info", {}, { root, timeout: 1000 }).then(r => !!r.data, () => false);
  for (let i = 0; i < 100 && !(await answers()); i++) await new Promise(r => setTimeout(r, 100));
  if (!(await answers())) throw new Error("vyred did not come up");

  const cli = async (/** @type {string} */ tool, /** @type {any} */ input) => {
    const r = await call(tool, input, { root, caller: "cli" });
    if (r.error) throw new Error(`glass-world: ${tool}: ${r.error.message}`);
    return r.data;
  };
  await cli("agents.create", { name: agent, kind: "agent", computer: true });
  // Give it a computer now, the way the Deck's "Give a computer" button does: glass.open expects
  // one already checked out, and this world never clicks that button itself.
  await cli("computers.checkout", { agent });

  return {
    root, env, agent, xvnc, daemon,
    async serve(port = 0) {
      const server = http.createServer((req, res) => {
        // A back door for the browser script (a separate process from this one) to drive the
        // fake Xvnc: send one frame so a real client has something to paint, or crash the TCP
        // connection the way a container dying would, for the reconnect check.
        if (req.url === "/__xvnc/frame") { xvnc.sendFrame(); res.writeHead(204); res.end(); return; }
        if (req.url === "/__xvnc/crash") { xvnc.crash(); res.writeHead(204); res.end(); return; }
        const up = http.request({ socketPath: sock, path: req.url, method: req.method, headers: req.headers }, r => {
          res.writeHead(r.statusCode || 502, r.headers);
          r.pipe(res);
        });
        up.on("error", e => { res.writeHead(502); res.end(String(e.message)); });
        req.pipe(up);
      });
      server.on("upgrade", (req, socket, head) => {
        const up = net.connect(sock, () => {
          up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}\r\n`).join("") + "\r\n");
          if (head && head.length) up.write(head);
          socket.pipe(up); up.pipe(socket);
        });
        up.on("error", () => socket.destroy()); socket.on("error", () => up.destroy());
      });
      await new Promise(r => server.listen(port, "127.0.0.1", r));
      const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
      return { server, port: addr.port };
    },
    async stop() {
      await xvnc.close();
      await new Promise(r => { daemon.once("exit", r); daemon.kill("SIGTERM"); });
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--port");
  const w = await buildGlassWorld();
  const { port } = await w.serve(i >= 0 ? Number(args[i + 1]) : 0);
  process.stdout.write(JSON.stringify({ ready: true, url: `http://127.0.0.1:${port}`, agent: w.agent, home: w.root }) + "\n");
  process.on("SIGINT", async () => { await w.stop(); process.exit(0); });
  process.on("SIGTERM", async () => { await w.stop(); process.exit(0); });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
