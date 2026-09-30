#!/usr/bin/env node
// A stand-in for a provider's login command, for tests. FAKE_LOGIN=paste asks for a pasted code;
// FAKE_LOGIN=fail ends non-zero after printing; otherwise it prints a device code and finishes after
// FAKE_LOGIN_MS (default 300) as if the person approved.
import fs from "node:fs";
import path from "node:path";
// The mode can also be a file named `mode` beside the command (a session's child env carries only what Vyre gives it).
let fileMode = ""; try { fileMode = fs.readFileSync(path.join(path.dirname(process.argv[1]), "mode"), "utf8").trim(); } catch {}
const mode = process.env.FAKE_LOGIN || fileMode || "device";
const done = () => { fs.mkdirSync(path.join(process.env.HOME || ".", ".fake"), { recursive: true }); fs.writeFileSync(path.join(process.env.HOME || ".", ".fake", "auth.json"), "{}"); process.exit(0); };
if (mode === "fail") { console.error("login failed: expired_token"); process.exit(1); }
if (mode === "paste") {
  console.log("Open https://claude.example/oauth/authorize?code=true&state=abc to sign in, then paste the code:");
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", d => { if (String(d).trim() === "good-code-123") done(); else { console.error("bad code"); process.exit(1); } });
} else {
  console.log("\x1b[1mSign in\x1b[0m\nGo to https://auth.example/device and enter the code: WXYZ-1234");
  setTimeout(done, Number(process.env.FAKE_LOGIN_MS) || 300);
}
