// @ts-check
// The app module half of the Space helper, split into four files (one ran past the per-file time limit): this one is the compose lint. The rig and the fakes are test/space-helper-apps-rig.js.
// catalog, walled off the way a Space's store is. Run with sh against a temp folder; docker and nsenter are the fakes of test/space-helper-apps-rig.js (the Space helper's own fakes behind them), the
// generated compose file is the REAL one from core/appmods/host-plan.js. Linux only (stat -c). Real iptables, real Docker and a real DocuSeal need a box: see the live test, VYRE_APPMODS_LIVE=1.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appRig, lineOf } from "./space-helper-apps-rig.js";
import { opts, UID } from "./space-helper-rig.js";

const SECRET = /api_token=tok_|login_password=pw_|hook_token=|SECRET_KEY_BASE=[0-9a-f]{64}/;
/** A rig with the helper installed and the catalog recorded (the real DocuSeal line). */
async function ready(/** @type {import("node:test").TestContext} */ t, over = {}) {
  const r = appRig(t);
  for (const [k, v] of Object.entries(over)) r.flag(k, v);
  await r.prime();
  return r;
}
const read = (/** @type {string} */ p) => fs.readFileSync(p, "utf8");


test("app helper: the generated compose is linted against the recorded line; each thing the lint refuses is refused and nothing starts", opts, async t => {
  const real = (await (async () => { const { composeFile } = await import("../core/appmods/host-plan.js"); return composeFile("documents"); })());
  const edits = {
    "a privileged service": ["    init: true\n", "    init: true\n    privileged: true\n"],
    "a published port": ["    init: true\n", "    init: true\n    ports:\n      - 3000:3000\n"],
    "an added capability": ["    init: true\n", "    init: true\n    cap_add:\n      - NET_ADMIN\n"],
    "host networking": ["    init: true\n", "    init: true\n    network_mode: host\n"],
    "an env_file": ["    init: true\n", "    init: true\n    env_file: /etc/shadow\n"],
    "a restart policy": ['    restart: "no"\n', "    restart: unless-stopped\n"],
    "another image": [/image: docuseal\/docuseal:[^\n]*/, "image: evil/evil@sha256:" + "f".repeat(64)],
    "the image by tag": [/image: docuseal\/docuseal:[^\n]*/, "image: docuseal/docuseal:latest"],
    "a bigger memory limit": ["mem_limit: 1536m", "mem_limit: 9000m"],
    "more cpus": ["cpus: 1.5", "cpus: 8"],
    "more pids": ["pids_limit: 512", "pids_limit: 5000"],
    "a host path volume": ["      - data:/data/docuseal\n", "      - /etc:/data/docuseal\n"],
    "a relative host path": ["      - data:/data/docuseal\n", "      - ./x:/data/docuseal\n"],
    "the docker socket": ["      - data:/data/docuseal\n", "      - data:/data/docuseal\n      - docker:/var/run/docker.sock\n"],
    "an undeclared volume": ["      - data:/data/docuseal\n", "      - other:/data/docuseal\n"],
    "a volume over /etc": ["      - data:/data/docuseal\n", "      - data:/etc/x\n"],
    "an env value with a dollar": ['APP_URL: "http://vyre-app-documents:3000"', 'APP_URL: "$(id)"'],
    "an env value with a backtick": ['FORCE_SSL: "false"', 'FORCE_SSL: "`id`"'],
    "another secret reference": ["SECRET_KEY_BASE: ${SECRET_KEY_BASE}", "SECRET_KEY_BASE: ${OTHER}"],
    "a second service": ["networks:\n  net:", "  second:\n    image: x\nnetworks:\n  net:"],
    "a network that is not internal": ["    internal: true", "    internal: false"],
    "an external network": ["networks:\n  net:\n", "networks:\n  net:\n    external: true\n"],
    "a volume named elsewhere": ["name: vyre-app-documents_data", "name: vyre-twenty_data"],
    "a project name that is not the app's": ["name: vyre-app-documents\n", "name: vyre-harlow-twenty\n"],
    "a container name that is not the app's": ["container_name: vyre-app-documents", "container_name: vyre-vyre-1"],
    "a user line": ["    init: true\n", "    init: true\n    user: root\n"],
    "pid host": ["    init: true\n", "    init: true\n    pid: host\n"],
    "a command": ["    init: true\n", "    init: true\n    command: sh\n"],
    "a line outside every block": ["services:\n", "foo: bar\nservices:\n"],
  };
  assert.ok(Object.keys(edits).length >= 25);
  const r = appRig(t);
  await r.prime();
  for (const [what, [from, to]] of Object.entries(edits)) {
    const text = typeof from === "string" ? real.replace(from, /** @type {string} */ (to)) : real.replace(from, /** @type {string} */ (to));
    assert.notEqual(text, real, `${what}: the edit changed the file`);
    r.flag("hostplan-compose", text);
    const { st } = await r.appUp();
    assert.equal(st.state, "failed", what);
    assert.match(st.message, /refused|regenerated/, what);
    assert.ok(!/compose .* (create|up)/.test(r.calls()), `${what}: nothing started`);
  }
  fs.rmSync(path.join(r.F, "hostplan-compose"));
  const { st } = await r.appUp();
  assert.equal(st.state, "ok", "the real file passes the same lint");
  // a generator that prints nothing, or not the marker line, is refused too
  for (const body of ["", "name: vyre-app-documents\n"]) {
    r.flag("hostplan-compose", body || "\n");
    const o = await r.appUp();
    assert.equal(o.st.state, "failed");
    assert.match(o.st.message, /could not be regenerated/);
  }
});
