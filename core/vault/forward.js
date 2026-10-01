// @ts-check
// The vault on a Mac with vyre-core (ADR 0040 phase 2a): vyred's vault module keeps its tool
// NAMES, so the CLI, the Deck and every module call what they always called, but it holds no
// store and no key. Each tool forwards to vyre-core with the person's proof passed through
// untouched (the registry skips its own check for a `core` tool), and core decides.
//
// Not forwarded:
// - A plain value (reveal, copy, totp) leaves core only for the Capsule, so here it is a plain
//   refusal that says where to go. A terminal never shows a secret on a vyre-core Mac.
// - Every tool whose slice hasn't moved yet (import, fill, devices, sharing, ssh ...) answers
//   core_owned: "not on this Mac yet". vyred's old store stays shut: nothing here opens it.

import fs from "node:fs";

/** The 2a tools vyre-core answers, and whether each carries the person's proof. */
const FORWARD = {
  "vault.list": false, "vault.match": false, "vault.release": false, "vault.revoke": false,
  "vault.put": true, "vault.delete": true, "vault.grant": true, "vault.verify": true,
};
/** A plain value: the Capsule's, never a terminal's or a module's here. */
const CAPSULE_ONLY = new Set(["vault.reveal", "vault.copy", "vault.totp"]);
const CALLERS = ["cli", "local", "deck", "capsule", "tailnet", "module"];

const fail = (message, code) => Object.assign(new Error(message), { code });

/**
 * Register the forwarders instead of the vault.
 * @param {any} ctx the vault module's ctx
 * @param {{ call(tool: string, input: any, header?: string): Promise<{ data?: any, error?: any }>, events?: (after: number, wait?: number) => Promise<{ events: any[], last: number }> }} link core's link
 */
export function startForwarder(ctx, link) {
  const declared = /** @type {string[]} */ (JSON.parse(fs.readFileSync(new URL("./module.json", import.meta.url), "utf8")).does.tools);
  const obj = { type: "object" };

  for (const [tool, proved] of Object.entries(FORWARD)) {
    ctx.tool(tool, {
      description: `On this Mac, vyre-core answers ${tool}${proved ? " and checks your proof itself" : ""}.`,
      input: obj, callers: CALLERS, core: true,
      run: async (input, meta = {}) => {
        let body = input;
        // A module's release names the module the registry vouched for, never one in the input.
        if (tool === "vault.release") {
          const m = /^module:([a-z][a-z0-9-]*)$/.exec(String(meta.caller || ""));
          if (!m) throw fail("only modules may ask the vault for a value", "denied");
          body = { name: input.name, field: input.field, watcher: input.watcher, module: m[1] };
        }
        // A module's own put or delete names the module the registry vouched for; for anyone else a `module`
        // in the input is dropped, so a person's surface can never ask for the no-proof path.
        if (tool === "vault.put" || tool === "vault.delete") {
          const { module: _drop, ...clean } = input || {};
          const m = /^module:([a-z][a-z0-9-]*)$/.exec(String(meta.caller || ""));
          body = m ? { ...clean, module: m[1] } : clean;
        }
        const r = await link.call(tool, body, proved ? meta.coreProof : undefined);
        if (r.error) throw fail(r.error.message || "vyre-core refused", r.error.code || "failed");
        return r.data;
      },
    });
  }
  for (const tool of CAPSULE_ONLY) {
    ctx.tool(tool, {
      description: `On this Mac, only the Capsule shows, copies or types a value (${tool}).`,
      input: obj, callers: CALLERS, core: true,
      run: async () => { throw fail("on this Mac a secret is shown, copied or typed only in the Capsule: open it there", "core_owned"); },
    });
  }
  for (const tool of declared) {
    if (tool in FORWARD || CAPSULE_ONLY.has(tool)) continue;
    ctx.tool(tool, {
      description: `${tool}: not on this Mac yet (vyre-core holds the vault here).`,
      input: obj, callers: CALLERS, core: true,
      run: async () => { throw fail(`${tool} isn't on this Mac yet: vyre-core holds the vault here, and this part hasn't moved into it`, "core_owned"); },
    });
  }
  ctx.log(`vault: on this Mac vyre-core holds the vault; ${Object.keys(FORWARD).length} tools forward to it`);

  // core's events, shown in vyred's log as core's and as information only (condition d): vyred
  // can forge its own log, so nothing makes a security decision from these. A long poll, held
  // open by core; after a failure it waits a minute (nothing here polls faster than that).
  let stopped = false, after = 0;
  const follow = async () => {
    while (!stopped && typeof link.events === "function") {
      try {
        const r = await link.events(after);
        const last = Number(r.last) || 0;
        // core restarted: its count began again at 0, so start from the beginning of the new one.
        if (last < after) { after = 0; continue; }
        after = last;
        for (const e of r.events || []) {
          if (stopped) break;
          try { ctx.events.emit(e.type, { ...(e.payload || {}), source: "vyre-core", informational: true }); } catch { /* an undeclared event: skipped */ }
        }
      } catch { if (!stopped) await new Promise(r => setTimeout(r, 60_000).unref?.()); }
    }
  };
  if (ctx.events && typeof ctx.events.emit === "function") follow();
  return { stop: async () => { stopped = true; } };
}
