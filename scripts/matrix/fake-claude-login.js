#!/usr/bin/env node
// A stand-in for `claude auth login` in the matrix (J1): prints a sign-in address on Claude's own host,
// waits for the pasted code, and exits 0 for the right one. Nothing here is a real credential, and a
// journey that uses it says so in its results.
if (process.argv[2] === "--version") { console.log("2.1.283 (Claude Code)"); process.exit(0); }
if (process.argv[2] !== "auth" || process.argv[3] !== "login") { console.error("matrix fake claude: only `auth login`"); process.exit(2); }
console.log("Opening browser to sign in...");
console.log("If the browser did not open, visit: https://claude.ai/oauth/authorize?code=true&client_id=matrix&state=matrix");
process.stdout.write("Paste code here if prompted > ");
let buf = "";
process.stdin.on("data", d => {
  buf += String(d);
  if (!buf.includes("\n")) return;
  const code = buf.split("\n")[0].trim(); buf = "";
  if (code === "good-code") { console.log("\nLogin successful."); process.exit(0); }
  console.log("\nOAuth error: Request failed with status code 400");
  process.exit(1);
});
