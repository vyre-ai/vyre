// @ts-check
// Test stand-in, SHIM(test labels): the memory suites that drive the module through a hand-made `ctx` (no daemon, no kernel) name a caller by LABEL ("cli", "mcp:agent:juno",
// "module:sessions", "tailnet:alex", "device:<id>"). The module itself reads no label any more; it reads the call's `Who`, which the kernel builds from a chain. This builds the `Who` the
// kernel WOULD build for each label, so those suites keep exercising the access rules. It lives only in tests: nothing in core/memory imports it. A suite that wants the kernel's
// own answer runs on a real kernel or a real daemon (access-chain.test.js, kernel-wiring.test.js, device-rows-daemon.test.js).
import { whoStore, whoOfModule } from "../who.js";

const OWNER_SURFACES = new Set(["deck", "cli", "local", "capsule"]);
/** @param {string} label @param {any} meta @returns {import("../who.js").Who} */
export function whoOfLabel(label, meta = {}) {
  const c = String(label || "");
  /** @type {any} */ const none = { ownerSurface: false, device: false, nodeDevice: false, signedIn: false, ownSession: false, agent: null, acting: null, conflict: false, module: null };
  const agent = /(?:^|[\s:])agent:([A-Za-z0-9_.-]+)/.exec(c);
  if (agent) return { ...none, agent: agent[1] };
  if (c.startsWith("module:")) return whoOfModule(c);
  if (OWNER_SURFACES.has(c)) return { ...none, ownerSurface: true };
  if (/^mcp(?::thread:[A-Za-z0-9_-]+)?$/.test(c)) return { ...none, ownSession: true };
  if (/^tailnet:(?!agent:)[^\s]+$/.test(c) || /^device:[a-z2-7]{16}$/.test(c)) return { ...none, device: true, nodeDevice: c.startsWith("tailnet:"), signedIn: Boolean(meta && meta.person) };
  return none; // a label the kernel would build no person for: nobody
}

/** A tool def whose `run` runs with the `Who` its caller's label stands for. @param {any} def */
export const labeled = def => ({ ...def, run: (/** @type {any} */ input, /** @type {any} */ extra = {}) => whoStore.run(whoOfLabel(extra.caller, extra), () => def.run(input, extra)) });
