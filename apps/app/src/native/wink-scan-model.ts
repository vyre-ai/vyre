// What the camera page (wink-scan-page.generated.js) tells the app, read in one place (pure; Node tests it). The page posts JSON strings: ready, slow, a ticket of
// exactly 8 byte values, or an error with a code. Anything else is dropped. The ticket is a pairing secret: it is handed on as bytes once and never turned into text.

export type WinkScanEvent =
  | { type: "ready" }
  | { type: "slow" }
  | { type: "ticket"; ticket: Uint8Array }
  | { type: "error"; code: "denied" | "no_camera" | "scan_worker"; message: string };

export function readScanMessage(raw: unknown): WinkScanEvent | null {
  let m: any;
  try { m = typeof raw === "string" ? JSON.parse(raw) : null; } catch { return null; }
  if (!m || typeof m !== "object") return null;
  if (m.type === "ready" || m.type === "slow") return { type: m.type };
  if (m.type === "ticket") {
    const t = m.ticket;
    if (!Array.isArray(t) || t.length !== 8 || !t.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return null;
    return { type: "ticket", ticket: Uint8Array.from(t) };
  }
  if (m.type === "error") {
    const code = m.code === "denied" || m.code === "scan_worker" ? m.code : "no_camera";
    return { type: "error", code, message: typeof m.message === "string" ? m.message.slice(0, 200) : "" };
  }
  return null;
}

/** The plain words under the camera for each way it can fail or be slow. */
export const SCAN_SAY = {
  denied: "The camera is off for Vyre. Turn it on in your phone's settings, then come back.",
  no_camera: "This phone's camera did not open. Type the code instead.",
  scan_worker: "Reading the code stopped. Close this and try again, or type the code.",
  slow: "Hold your phone straight on to the screen, with the whole drawing in view.",
} as const;
