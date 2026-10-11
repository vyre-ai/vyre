// @ts-check
// Ports a DEVELOPMENT build's session confinement check lets pass without a finding: the one a walk's own stand-in forwarder listens on in the box. A packaged build ignores the variable.
import { isPackaged } from "../../kernel/devbuild.js";

/** @param {Record<string, string | undefined>} [env] @param {string} [root] @returns {number[]} */
export function devAllowedPorts(env = process.env, root) {
  const v = env.VYRE_DEV_ALLOW_LISTEN || "";
  if (isPackaged(root) || !/^\d{1,5}(,\d{1,5})*$/.test(v)) return [];
  return v.split(",").map(Number).filter(n => n > 0 && n < 65536);
}
