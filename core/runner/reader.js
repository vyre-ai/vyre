// @ts-check
// The workspace reader. It runs INSIDE the same sandbox as the session (same confinement, no network, only <workspace>/work
// mounted), reads the files a checkpoint uploads, and hands the bytes out over stdout. So the member's rights never touch a
// path the session controls: a link the session plants leads nowhere (the host is not in this view; on macOS seatbelt denies
// it), and a race with a helper process cannot reach a host file (reviewer-2 S-1, fixed at the root).
//
//   stdin  one JSON line: { roots: [{ dir, remote }], have: { "<rel>": "<sha256>" }, maxBytes, maxFiles, maxTotal }
//          (caps per file, files per checkpoint and bytes per checkpoint: a hostile session cannot make a checkpoint unbounded)
//   stdout for each plain file: a header line  H {"rel","hash","size","send"}\n  then size bytes when send is true
//          (send is false when the hash is the one the space already has). Ends with  E\n
//
// It still refuses links and non-regular files itself (lstat, O_NOFOLLOW): defence in depth, not the boundary.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0, NONBLOCK = fs.constants.O_NONBLOCK || 0;
const cwd = process.cwd();   // the sandbox starts it in <work>/files; the workspace root is its parent
const work = path.resolve(cwd, "..");

function* walk(abs, rel) {
  let ents; try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const r = rel + "/" + e.name;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) yield* walk(path.join(abs, e.name), r); else if (e.isFile()) yield r;
  }
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", d => { input += d; });
process.stdin.on("end", () => {
  const req = JSON.parse(input);
  const out = fd => (b) => { let n = 0; while (n < b.length) n += fs.writeSync(1, b, n, b.length - n); };
  const w = out(1);
  let files = 0, total = 0;
  for (const root of req.roots) {
    for (const rel of walk(path.join(work, root.dir), root.dir)) {
      let fdn = -1;
      try {
        const full = path.join(work, rel);
        if (!fs.lstatSync(full).isFile()) continue;
        fdn = fs.openSync(full, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
        const st = fs.fstatSync(fdn);
        if (!st.isFile() || st.size > req.maxBytes) continue;
        if (++files > req.maxFiles || total + st.size > req.maxTotal) { w(Buffer.from("T\n")); process.exit(0); }
        total += st.size;
        const buf = Buffer.alloc(st.size); let n = 0;
        while (n < st.size) { const r = fs.readSync(fdn, buf, n, st.size - n, n); if (!r) break; n += r; }
        const data = buf.subarray(0, n);
        const hash = crypto.createHash("sha256").update(data).digest("hex");
        const send = req.have[rel] !== hash;
        w(Buffer.from("H " + JSON.stringify({ rel, hash, size: send ? data.length : 0, send }) + "\n"));
        if (send) w(data);
      } catch {} finally { if (fdn >= 0) try { fs.closeSync(fdn); } catch {} }
    }
  }
  w(Buffer.from("E\n"));
});
