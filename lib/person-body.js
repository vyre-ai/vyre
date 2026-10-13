// @ts-check
// A tool that first-party modules call (so its reach cannot be `person`, which refuses modules) but that an agent, a model, a guest or an MCP caller must never run: the body refuses them,
// and the person's surfaces and the modules pass. The golden records reach, not the body, so each such tool is named in the allow file with this as its reason (scripts/gen-allow.mjs).
// An allowlist, not a denylist: a module passes, the person passes (lib/caller.js isPerson, which includes a paired device), and every other caller is denied.

import { isPerson } from "./caller.js";

/**
 * @param {any} meta the call's meta @param {string} what what the tool does, for the refusal
 * @returns {void}
 */
export function refuseNonPerson(meta, what) {
  const who = String((meta && meta.caller) || "");
  // A module relaying a model's call (meta.origin names who it really came from) is that model's call, so it is denied even though the caller is a module (as core/link/mac.js does).
  if (meta && meta.origin && !isPerson(meta.origin)) throw Object.assign(new Error(`only a person ${what}; an agent asks the person to do it`), { code: "denied" });
  if (who.startsWith("module:")) return;
  if (isPerson(meta)) return;
  throw Object.assign(new Error(`only a person ${what}; an agent asks the person to do it`), { code: "denied" });
}
