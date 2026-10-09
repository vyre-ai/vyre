// @ts-check
// The two releases the update proof moves between (build-update-releases.sh), each served by a small static server on loopback, the way a release site serves its box folder. CI only.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @param {string} root @returns {Promise<{ url: string, close(): Promise<void> }>} */
function serve(root) {
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(String(req.url || "/").split("?")[0]).replace(/^\/+/, "");
    const f = path.resolve(root, rel);
    if (!f.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.statusCode = 404; res.end("not found"); return; }
    res.setHeader("content-length", fs.statSync(f).size);
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(ok => srv.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}/`, close: () => new Promise(r => srv.close(() => r(undefined))) })));
}

/** @param {{ work: string, oldTag?: string, log?: string }} o */
export async function buildUpdateReleases(o) {
  const r = spawnSync("sh", [path.join(here, "build-update-releases.sh"), o.work, o.oldTag || "v0.2.11"], { encoding: "utf8", maxBuffer: 64 << 20 });
  fs.mkdirSync(o.work, { recursive: true });
  if (o.log) fs.writeFileSync(o.log, `${r.stdout}\n${r.stderr}`);
  if (r.status !== 0) throw new Error(`the releases did not build: ${String(r.stderr || r.stdout).split("\n").filter(Boolean).slice(-4).join(" | ").slice(0, 500)}`);
  const read = (/** @type {string} */ f) => fs.readFileSync(path.join(o.work, f), "utf8").trim();
  const oldBox = path.join(o.work, "old", "site", "box"), newBox = path.join(o.work, "new", "site", "box");
  const a = await serve(oldBox), b = await serve(newBox);
  return {
    oldVersion: read("old.version"), newVersion: read("new.version"), pub: read("proof.pub"), oldBox, newBox, oldUrl: a.url, newUrl: b.url,
    async stop() { await a.close(); await b.close(); },
  };
}
