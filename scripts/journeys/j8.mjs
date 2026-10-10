// J8 Update and come back (team/0.3.1/JOURNEYS.md): the box updates itself from Settings, as a person, to the build under test; what the person made before is still there; then a restart with no
// one at the keyboard comes back online. The server is the previous published release (JOURNEY_OLD_TAG, default v0.3.0), installed by that release's own installer from a local release site; the
// candidate is this checkout, built the way a release is and signed with a throwaway key. Box only (docker), so CI or a test box with VYRE_JOURNEY_BOX=1.
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { startStandins } from "../lib/proof/standins.mjs";
import { buildUpdateReleases } from "../lib/proof/update-releases.mjs";
import { walkUpdate } from "../lib/proof/walk.mjs";
import { ownedRun } from "./lib/journey.mjs";

const sh = (/** @type {string} */ c) => spawnSync("sh", ["-c", c], { encoding: "utf8", timeout: 120_000 });

export default {
  id: "J8", title: "Update and come back", owner: "release", world: "own", store: "plain",
  /** @param {{ run: any, out: string }} w @param {ReturnType<typeof import("./lib/journey.mjs").stepper>} J */
  async steps(w, J) {
    const run = ownedRun(w.run, "release");
    const hostIp = process.env.PROOF_HOST_IP || Object.values(os.networkInterfaces()).flat().find(n => n && n.family === "IPv4" && !n.internal)?.address || "127.0.0.1";
    const ins = await startStandins({ out: path.join(w.out, "j8"), host: "0.0.0.0", publicHost: hostIp });
    /** @type {any} */ let update = null;
    try {
      await J.step("the previous release and the build under test are built and served (one throwaway key)", async () => {
        update = await buildUpdateReleases({ work: path.join(process.env.RUNNER_TEMP || os.tmpdir(), "j8-releases"), oldTag: process.env.JOURNEY_OLD_TAG || "v0.3.0", candidateTag: process.env.JOURNEY_CANDIDATE_TAG || "", log: path.join(w.out, "j8-build-releases.log") });
        return `${update.oldVersion} -> ${update.newVersion}`;
      });
      if (!update) return;
      await walkUpdate({
        run, ins, out: path.join(w.out, "j8"), update, label: "J8",
        after: async ({ mac, srv, S, back }) => {
          const UP = S("after the update, the server answers and says the new version");
          await run.step(UP, async () => {
            const info = await mac.callTool("system.info");
            assert.equal(info.version, update.newVersion, "the server runs the candidate");
            return info.version;
          }, { needs: [back] });
          await run.step(S("a restart with no one at the keyboard: Docker restarts and the server comes back by itself"), async () => {
            // the machine's own restart path: the container has a restart policy and the host's docker comes back on its own; nobody runs `vyre up`
            const r = sh("sudo systemctl restart docker 2>&1; echo rc=$?");
            assert.match(r.stdout, /rc=0/, `docker did not restart: ${r.stdout.slice(-200)}`);
            const end = Date.now() + 5 * 60_000;
            let v = "";
            while (Date.now() < end && v !== update.newVersion) {
              await new Promise(res => setTimeout(res, 5000));
              try { v = String(JSON.parse(sh("docker exec -u vyre vyre-vyre-1 vyre call system.info '{}' 2>/dev/null").stdout || "{}").version || ""); } catch { v = ""; }
            }
            assert.equal(v, update.newVersion, `five minutes after the restart the box says ${v || "nothing"}`);
            return `back on ${v}`;
          }, { needs: [UP] });
          await run.step(S("the same app signs in again after the restart, with the session it held"), async () => {
            await mac.reconnect();
            const st = await mac.callTool("update.status", {});
            assert.equal(st.current, update.newVersion);
            assert.equal(st.available, null, "no newer version is offered");
          }, { needs: [S("a restart with no one at the keyboard: Docker restarts and the server comes back by itself")] });
        },
      });
    } finally { if (update) await update.stop().catch(() => {}); await ins.stop(); }
  },
};
