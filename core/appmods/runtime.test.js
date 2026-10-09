import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { namesOf, runArgs, envText, fill, createDockerDirect } from "./runtime.js";

const documents = () => JSON.parse(fs.readFileSync(new URL("./catalog/documents.json", import.meta.url), "utf8"));

/** A fake docker: records every call and answers by the first matching rule. */
function fake(rules = {}) {
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    for (const [k, v] of Object.entries(rules)) if (key.startsWith(k)) return typeof v === "function" ? v(args) : v;
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, runner };
}

test("the run command pins the image, drops every capability, limits memory, CPU and processes, and carries no secret", () => {
  const m = documents();
  const n = namesOf("spc_abc", m.name);
  const args = runArgs({ names: n, manifest: m, envFile: "/tmp/e" });
  assert.equal(args[args.length - 1], m.app.image);
  const s = args.join(" ");
  assert.match(s, /--cap-drop ALL/);
  assert.match(s, /--security-opt no-new-privileges/);
  assert.match(s, /--memory 1536m --memory-swap 1536m --cpus 1\.5 --pids-limit 512/);
  assert.match(s, /-p 127\.0\.0\.1::3000/);
  assert.match(s, /--env-file \/tmp\/e/);
  assert.ok(!/SECRET_KEY_BASE|--privileged|docker\.sock|--network host|-e /.test(s), "no secret, no privilege, no host network on the command line");
});

test("the env file fills the manifest's values, adds the Vault's secrets and refuses a line break", () => {
  const m = documents();
  const t = envText(m, { origin: "http://x:1" }, { SECRET_KEY_BASE: "s3cr3t" });
  assert.equal(t, "APP_URL=http://x:1\nFORCE_SSL=false\nSECRET_KEY_BASE=s3cr3t\n");
  assert.throws(() => envText(m, { origin: "a\nB=c" }, {}), e => e.code === "bad_env");
  assert.equal(fill("{origin}/{unknown}", { origin: "o" }), "o/{unknown}");
});

test("up makes the network (no masquerade), the volumes and the container, opens the hook door for the app's subnet only, and says where the app is", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "appmod-rt-"));
  const f = fake({
    "inspect vyre-app": { code: 1, stdout: "", stderr: "no such object" },
    "network inspect": a => a.length > 3 ? { code: 0, stdout: "172.30.0.1 172.30.0.0/16\n", stderr: "" } : { code: 1, stdout: "", stderr: "none" },
    "port vyre-app": { code: 0, stdout: "127.0.0.1:41234\n", stderr: "" },
  });
  const rules = [];
  const d = createDockerDirect({ runner: f.runner, home, firewall: async argv => { rules.push(argv); return { code: argv[1] === "-C" ? 1 : 0, stdout: "", stderr: "" }; } });
  const up = await d.up({ space: "spc_abc", manifest: documents(), vars: { origin: "http://x" }, secrets: { SECRET_KEY_BASE: "s" }, hookPort: 40000 });
  assert.deepEqual([up.origin, up.gateway, up.hookHost], ["http://127.0.0.1:41234", "172.30.0.1", "172.30.0.1"]);
  const flat = f.calls.map(c => c.join(" "));
  assert.ok(flat.some(c => /^network create .*enable_ip_masquerade=false/.test(c)), "the app's network does not masquerade, so nothing beyond the host answers it");
  assert.ok(flat.some(c => /^volume create .* vyre-app-spc-abc-documents_data$/.test(c)));
  assert.ok(flat.some(c => /^run -d --name vyre-app-spc-abc-documents /.test(c)));
  assert.deepEqual(rules.map(r => r.slice(0, 3).join(" ")), ["iptables -C INPUT", "iptables -I INPUT"]);
  assert.match(rules[1].join(" "), /-s 172\.30\.0\.0\/16 -p tcp --dport 40000 .* -j ACCEPT/);
  assert.ok(!fs.existsSync(path.join(home, "appmods", "spc_abc", "documents", "env")), "the env file is gone once the container started");
});

test("an app with no egress opens no door; down removes container, network and door, and the data only when asked", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "appmod-rt-"));
  const f = fake({ "inspect vyre-app": { code: 1, stdout: "", stderr: "" }, "network inspect": a => a.length > 3 ? { code: 0, stdout: "172.30.0.1 172.30.0.0/16", stderr: "" } : { code: 1, stdout: "", stderr: "" }, "port vyre-app": { code: 0, stdout: "127.0.0.1:1\n", stderr: "" } });
  const rules = [];
  const d = createDockerDirect({ runner: f.runner, home, firewall: async argv => { rules.push(argv); return { code: 0, stdout: "", stderr: "" }; } });
  const m = documents(); m.app.egress = [];
  await d.up({ space: "s", manifest: m, vars: {}, secrets: {}, hookPort: 40001 });
  assert.equal(rules.length, 0);
  await d.down({ space: "s", manifest: documents(), hookPort: 40001 }, { data: false });
  assert.ok(f.calls.some(c => c[0] === "rm" && c.includes("-f")));
  assert.ok(f.calls.some(c => c.slice(0, 2).join(" ") === "network rm"));
  assert.ok(!f.calls.some(c => c.slice(0, 2).join(" ") === "volume rm"), "data stays");
  assert.deepEqual(rules.map(r => r.slice(0, 3).join(" ")), ["iptables -D INPUT"]);
  await d.down({ space: "s", manifest: documents() }, { data: true });
  assert.ok(f.calls.some(c => c.slice(0, 2).join(" ") === "volume rm"));
});

test("exec copies the bootstrap script in, runs it with the environment, and removes it", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "appmod-rt-"));
  const f = fake({ "exec -e": { code: 0, stdout: "api_token=abc\n", stderr: "" } });
  const d = createDockerDirect({ runner: f.runner, home });
  const r = await d.exec({ space: "s", manifest: documents() }, ["bin/rails", "runner", "{file}"], { env: { A: "1" }, files: [{ name: "boot.rb", text: "puts 1" }] });
  assert.equal(r.stdout, "api_token=abc\n");
  const flat = f.calls.map(c => c.join(" "));
  assert.ok(flat.some(c => /^cp .* vyre-app-s-documents:\/tmp\/boot\.rb$/.test(c)));
  assert.ok(flat.some(c => /^exec -e A=1 -w \/app vyre-app-s-documents bin\/rails runner \/tmp\/boot\.rb$/.test(c)));
  assert.ok(flat.some(c => /^exec vyre-app-s-documents rm -f \/tmp\/boot\.rb$/.test(c)));
  await assert.rejects(() => d.exec({ space: "s", manifest: documents() }, ["x"], { files: [{ name: "../x", text: "" }] }), e => e.code === "bad_name");
});
