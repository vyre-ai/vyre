// @ts-check
// `vyre setup --name <n> --yes`: the setup page's naming step with no browser, for scripted installs and e2e journeys.
//
// It is a front for the exact flow the page runs: names.check, then names.claim, the same two tools through the same registry
// (so the same validation, the same one-time recovery code, the same refusals). There is no second path. The passkey step that makes a
// person the server's owner stays in a browser by design (it is the person's fingerprint, face or key), so this command names the server and
// stops there; the server is claimed by the person at its address afterwards.
//
// The recovery code is printed once, with a plain line to store it. A name that is taken, not valid, or fails to claim exits 1 with the
// reason in words. Claiming is for good, so without --yes a terminal is asked and a script is refused.
//
// --json: { name, address, phase, recoveryCode, why? } or { error }.

import readline from "node:readline/promises";
import { call } from "../../daemon/client.js";
import { out, dim, bold, signal } from "../style.js";
import { json, emit, fail, failTool, usage } from "../kit.js";

const WAIT_MS = 90_000;
const STEP_MS = 2000;

/** @param {number} ms */
const sleep = ms => new Promise(r => setTimeout(r, ms));

export default [
  {
    name: "setup", order: 29, usage: "vyre setup --name <n> [--yes] [--json]", summary: "name this server, with no browser: <n>.vyre.run (--json prints the recovery code on stdout: keep it out of logs)",
    async run(args) {
      /** @type {string|null} */ let name = null;
      let yes = false;
      const rest = args.filter(a => a !== "--json");
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === "--yes" || a === "-y") yes = true;
        else if (a === "--name") { const v = rest[i + 1]; if (v === undefined || v.startsWith("--")) return usage("vyre setup --name needs a name", "vyre setup --name alex --yes"); name = v; i++; }
        else if (a.startsWith("--name=")) name = a.slice(7);
        else return usage(`vyre setup: unknown option ${a}`, "vyre setup --name alex --yes");
      }
      if (!name) return usage("vyre setup needs --name <n>: this command names the server; the rest of setup is the page", "vyre setup --name alex --yes");
      const want = name.trim().toLowerCase();

      const checked = await call("names.check", { name: want });
      if (checked.error) return failTool(checked.error);
      const c = checked.data;
      if (!c.valid) return fail(`${want} is not a name Vyre can use: ${c.why || "see vyre name check"}`, { code: "invalid_name" });
      if (!c.available) return fail(`${c.address || `${want}.vyre.run`} is taken: ${c.why || "someone else has it"}`, { code: "name_taken", next: "pick another: vyre setup --name <another> --yes" });

      if (!yes) {
        if (!process.stdin.isTTY) return usage("claiming a name is for good, so a script must pass --yes", `vyre setup --name ${want} --yes`);
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const a = (await rl.question(`  Claim ${c.address || want + ".vyre.run"} for this server for good? [y/N] `)).trim().toLowerCase();
        rl.close();
        if (a !== "y" && a !== "yes") return fail("not claimed", { code: "declined" });
      }

      const claimed = await call("names.claim", { name: want });
      if (claimed.error) return failTool(claimed.error);
      let d = claimed.data || {};
      const recoveryCode = d.recoveryCode ? String(d.recoveryCode) : null;
      if (d.phase === "failed") return fail(`could not claim ${want}.vyre.run: ${d.why || "no reason given"}`, { code: "claim_failed" });

      // The claim answers at once and carries on in the background (address, certificate). Wait for it to rest.
      const until = Date.now() + WAIT_MS;
      while (!["serving", "named", "failed"].includes(String(d.phase)) && Date.now() < until) {
        await sleep(STEP_MS);
        const s = await call("names.status");
        if (s.error) return failTool(s.error);
        d = { ...s.data };
      }
      if (d.phase === "failed") return fail(`${want}.vyre.run was claimed, but it could not be served: ${d.why || "no reason given"}`, { code: "serve_failed" });

      if (json()) return emit({ name: want, address: d.address || c.address || null, phase: d.phase, recoveryCode, ...(d.why ? { why: String(d.why) } : {}) });
      out(`  ${signal(d.address || c.address || `https://${want}.vyre.run`)} ${dim(`· ${d.phase}`)}`);
      if (recoveryCode) {
        out("");
        out(`  Recovery code: ${bold(recoveryCode)}`);
        out("  Store it somewhere safe now (a password manager). It is shown once and cannot be shown again; with it you can take this name back after a reinstall.");
        out("");
      } else out(dim("  This server already held that name, so there is no new recovery code."));
      if (d.phase === "named" && d.why) out(dim(`  ${d.why}`));
      return 0;
    },
  },
];
