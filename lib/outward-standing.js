// @ts-check
// Map an outward registry tool call to the Gate standing check (kind, via, to). Used to skip the registry's one-yes hold when a standing permission already covers the act the tool will file at the Gate.
import { numbers, SENDER, SENDER_SERVICE } from "../core/comms/index.js";

/** @param {unknown} to */
function emails(to) {
  const list = Array.isArray(to) ? to : String(to ?? "").split(/[,;]/);
  return list.map(x => String(x).trim()).filter(Boolean);
}

/**
 * @param {string} tool
 * @param {any} input
 * @returns {{ kind: "send", via: string, to: string[] } | null}
 */
export function gateStandingQuery(tool, input) {
  if (!input || typeof input !== "object") return null;
  if (tool === "mail.send") {
    const account = input.account;
    if (typeof account !== "string" || !account) return null;
    const to = emails(input.to);
    if (!to.length) return null;
    return { kind: "send", via: `mail:${account}`, to };
  }
  if (tool === "comms.send") {
    if (input.via === "email") {
      const account = input.account;
      if (typeof account !== "string" || !account) return null;
      const to = emails(input.to);
      if (!to.length) return null;
      return { kind: "send", via: `mail:${account}`, to };
    }
    if (input.via === "sms") {
      try {
        const to = numbers(input.to);
        if (!to.length) return null;
        return { kind: "send", via: SENDER, to };
      } catch { return null; }
    }
    return null;
  }
  if (tool === "comms.email") {
    const to = emails(input.to);
    if (!to.length) return null;
    return { kind: "send", via: SENDER_SERVICE, to };
  }
  return null;
}
