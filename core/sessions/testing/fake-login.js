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
if (mode === "claude-real") {
  // The real `claude auth login` (2.1.296, measured on a box): one very long address on one line, a prompt with no newline, and a refused code on stderr then exit 1.
  const long = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload+user%3Aplugins&code_challenge=" + "A1B2-C3D4".repeat(5) + "&code_challenge_method=S256&state=" + "x".repeat(43);
  console.log("Opening browser to sign in…\nIf the browser didn't open, visit: " + long);
  process.stdout.write("Paste code here if prompted > ");
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", d => { if (String(d).trim() === "good-code-123") done(); else { console.error("Login failed: Request failed with status code 400"); process.exit(1); } });
} else if (mode === "paste") {
  console.log("Open https://claude.ai/oauth/authorize?code=true&state=abc to sign in, then paste the code:");
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", d => { if (String(d).trim() === "good-code-123") done(); else { console.error("bad code"); process.exit(1); } });
} else {
  console.log("\x1b[1mSign in\x1b[0m\nGo to https://auth.openai.com/device and enter the code: WXYZ-1234");
  setTimeout(done, Number(process.env.FAKE_LOGIN_MS) || 300);
}
