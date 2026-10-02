// @ts-check
// app-handoff: what the Windows app tells its core once, on the core's standard input, when it starts it (VYRE_SUPERVISOR=app):
// the name of the app-owned pipe the core uses to ask the app for things only the app can do (vouch for it to the server, seal its key with
// Windows). On stdin and not on the command line or in the environment, which other processes of the same person can read.
import { appMode } from "./index.js";

/** The only name the app makes: a per-launch random pipe. */
export const APP_PIPE = /^\\\\\.\\pipe\\vyre-app-[0-9a-f]{32}$/;

/** @type {{ countersign: string } | null} */
let held = null;

/** What the app handed over, or null (not started by the app, or it said nothing valid). */
export const handoff = () => held;

/**
 * Read the first line of stdin and keep it. Resolves to null after `timeout` or on anything but the one valid shape; never throws.
 * @param {import("node:stream").Readable} [stream] @param {number} [timeout]
 * @returns {Promise<{ countersign: string } | null>}
 */
export function takeHandoff(stream = process.stdin, timeout = 10_000) {
  if (!appMode() && stream === process.stdin) return Promise.resolve(null);
  return new Promise(resolve => {
    let buf = "", over = false;
    const end = v => { if (over) return; over = true; clearTimeout(timer); stream.off("data", onData); stream.off("end", onEnd); held = v; resolve(v); };
    const onData = d => {
      buf += d;
      if (buf.length > 1024) return end(null);
      const i = buf.indexOf("\n");
      if (i < 0) return;
      try {
        const j = JSON.parse(buf.slice(0, i));
        end(j && j.v === 1 && typeof j.countersign === "string" && APP_PIPE.test(j.countersign) ? { countersign: j.countersign } : null);
      } catch { end(null); }
    };
    const onEnd = () => end(null);
    const timer = setTimeout(() => end(null), timeout);
    stream.setEncoding?.("utf8");
    stream.on("data", onData);
    stream.on("end", onEnd);
  });
}

/** Test seam: set what was handed over. @param {{ countersign: string } | null} v */
export const setHandoff = v => { held = v; };
