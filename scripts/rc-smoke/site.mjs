// rc-smoke's fake release site, shaped like vyre.run/box/ (scripts/build-site.sh):
//   node site.mjs make <package-dir> <out> <version> <min_from> <dockerignore>
//     writes vyre.tgz (the package with its version set), the box files, VERSION, release.json
//     and SHA256SUMS over all of them into <out>.
//   node site.mjs serve <dir> <portfile>
//     serves <dir> on 127.0.0.1 (a free port, written to <portfile>) until killed.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [, , cmd, ...a] = process.argv;
const sha = f => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

if (cmd === "make") {
  const [pkgDir, out, version, minFrom, dockerignore] = a;
  fs.mkdirSync(out, { recursive: true });
  const stage = fs.mkdtempSync(path.join(out, ".stage-"));
  spawnSync("cp", ["-a", pkgDir, path.join(stage, "package")], { stdio: "inherit" });
  const pj = path.join(stage, "package", "package.json");
  const p = JSON.parse(fs.readFileSync(pj, "utf8"));
  p.version = version;
  fs.writeFileSync(pj, JSON.stringify(p, null, 2) + "\n");
  const r = spawnSync("tar", ["-czf", path.join(out, "vyre.tgz"), "-C", stage, "package"], { stdio: "inherit" });
  if (r.status !== 0) process.exit(1);
  for (const f of ["compose.yml", "compose.build.yml", "vyre.env.example", "vyre", "Dockerfile"]) fs.copyFileSync(path.join(pkgDir, "box", f), path.join(out, f));
  fs.copyFileSync(dockerignore, path.join(out, "dockerignore"));
  fs.writeFileSync(path.join(out, "VERSION"), version + "\n");
  fs.writeFileSync(path.join(out, "release.json"), JSON.stringify({ version, channel: "stable", commit: "rcsmoke", date: new Date().toISOString(), min_from: minFrom, notes: "rc-smoke" }, null, 2) + "\n");
  fs.rmSync(stage, { recursive: true, force: true });
  const names = fs.readdirSync(out).filter(n => n !== "SHA256SUMS" && !n.startsWith(".")).sort();
  fs.writeFileSync(path.join(out, "SHA256SUMS"), names.map(n => `${sha(path.join(out, n))}  ${n}\n`).join(""));
} else if (cmd === "serve") {
  const [dir, portfile] = a;
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url || "/", "http://x").pathname).replace(/^\/+/, "");
    const file = path.join(dir, name);
    if (!name || name.includes("..") || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end("not here"); }
    res.end(fs.readFileSync(file));
  });
  server.listen(0, "127.0.0.1", () => fs.writeFileSync(portfile, String(server.address().port)));
} else {
  console.error("usage: site.mjs make|serve ...");
  process.exit(2);
}
