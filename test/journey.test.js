// @ts-check
// The install journey end to end (ADR 0008): a fresh Mac and a fresh Linux server, both temp homes
// on this machine (test/journey/rig.js), with fake ssh, docker, tailscale, claude and browser.
// The vyred on each side is real, and so are `vyre box add`, `vyre up`, the installer, the host
// wrapper and the onboarding page. Scenarios 1, 2 and 6 share one pair of machines, in order.
//
// Where the product does not yet do what ADR 0008 says, the check stays here as a todo subtest
// naming the gap, so it turns green (and says so) the day the product catches up.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRig, browser, terminal, until, TARGET, TS_NAME } from "./journey/rig.js";
import { ending } from "../core/cli/ending.js";

/** @type {Awaited<ReturnType<typeof makeRig>> | null} */
let shared = null;
// ssh logs one line of argv: options, `--`, the target, then the remote command.
const INSTALL_RUN = /(^| )-- \S+@\S+ env .*sh \/\S+ --yes$/;

test.after(async () => { if (shared) await shared.close(); });

const tail = f => { try { return fs.readFileSync(f, "utf8").split("\n").slice(-30).join("\n"); } catch { return "(nothing)"; } };

test("journey 3, door A refused: no --yes and no terminal prints the plan and touches nothing", async () => {
  const rig = await makeRig();
  try {
    const { code, out } = await rig.mac(["box", "add", TARGET], { timeout: 30_000 }).done;
    assert.equal(code, 1, out);
    assert.match(out, new RegExp(`Vyre will, on ${TARGET}:`));
    assert.match(out, /use the Docker already there \(Compose 2\.29\.0\)/);
    assert.match(out, new RegExp(`create ${rig.env.server.VYRE_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} and put Vyre's stack in it`));
    assert.match(out, /add \/usr\/local\/bin\/vyre/);
    assert.match(out, /nothing changed\. Run it in a terminal to answer, or add --yes\./);
    assert.equal(fs.existsSync(rig.env.server.VYRE_DIR), false, "no stack folder");
    assert.equal(fs.existsSync(rig.env.server.VYRE_WRAPPER), false, "no wrapper");
    assert.ok(!rig.ssh().some(l => / cat > /.test(l) || INSTALL_RUN.test(l)), "the installer never went over");
    assert.deepEqual(rig.docker().filter(l => !/^(compose version|info|ps -q|volume (ls|inspect))\b/.test(l)), [], "docker was only asked, never told");
    assert.equal(rig.opened().length, 0);
  } finally { await rig.close(); }
});

test("journey 5, door A on a signed-out Mac: box add stops before touching the server", async () => {
  const rig = await makeRig({ mac: "signed-out" });
  try {
    const { code, out } = await rig.mac(["box", "add", TARGET, "--yes"], { timeout: 20_000 }).done;
    assert.equal(code, 1, out);
    assert.match(out, /Tailscale is signed out: open Tailscale and sign in/);
    assert.deepEqual(rig.ssh(), [], "ssh never ran");
    assert.equal(fs.existsSync(rig.env.server.VYRE_DIR), false);
  } finally { await rig.close(); }
});

