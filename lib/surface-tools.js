// @ts-check
// Which onboarding, device and invite tools count as a surface for the Needs-you hold and the MCP offer.
// The names are the declared list in mcp-allow.js. This file does not scan source.
import { MCP_ALLOW } from "./mcp-allow.js";

const SET = new Set(MCP_ALLOW);

/** The declared list, in order. */
export function surfaceNames() {
  return MCP_ALLOW;
}

/** @param {string} name */
export function isSurface(name) {
  return SET.has(String(name || ""));
}
