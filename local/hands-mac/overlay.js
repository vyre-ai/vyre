// @ts-check
// overlay: the person can see Vyre driving their Mac, and can stop it with one key.
//
// Computer use is otherwise invisible: a window changes and nobody can tell whether Vyre did it,
// where it aimed, or how to make it stop. The overlay helper (bin/overlay) answers all three. It
// draws a ring where each act lands, shows a small "Vyre is controlling <App>" pill while a
// session is live, and listens for Escape or a double Control, which it reports as a stop.
//
// It is long-lived only while acting. The first act starts it; it hides the pill and exits on its
// own 8 s after the last act, so nothing of it runs while Vyre is not driving. Messages are NDJSON
// on its stdin; it answers on stdout with {"ready":true,"keys":bool} once, and {"stop":true} when
// the person stops it. Closing its stdin ends it, so vyred dying takes the pill with it.
//
// A real act without a visible indicator is refused (no_indicator), never done quietly. The
// indicator is what makes the stop keys possible at all: they are heard only while it shows, so
// an act with no indicator would be one the person could neither see nor stop.

import fs from "node:fs";
import path from "node:path";
import { spawn as spawnChild } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HandsError } from "./runner.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OVERLAY_BIN = path.join(HERE, "bin", "overlay");
const BUILD = path.join(HERE, "build.sh");

/**
 * What the hands need from an overlay. Tests pass a fake with the same shape.
 * @typedef {{
 *   controlling(app: string, at?: { x: number, y: number } | null): Promise<void>,
 *   ring(r: { x: number, y: number, ok: boolean }): void,
 *   done(): void,
 *   close(): void,
 *   onStop(fn: () => void): void,
 * }} Overlay
 */

/** The overlay for a runner that cannot touch the screen: there is nothing to show or stop. */
export const NO_OVERLAY = /** @type {Overlay} */ ({
  async controlling() {}, ring() {}, done() {}, close() {}, onStop() {},
});

/** The centre of an accessibility frame, in the same top-left global points the frame uses. */
export function center(/** @type {{ x: number, y: number, w: number, h: number } | null | undefined} */ f) {
  if (!f || !(f.w > 0) || !(f.h > 0)) return null;
  return { x: Math.round(f.x + f.w / 2), y: Math.round(f.y + f.h / 2) };
}

/**
 * The overlay backed by the compiled helper.
 *
 * @param {{ bin?: string, readyMs?: number, linger?: number, ringMs?: number, spawn?: typeof spawnChild,
 *   platform?: string }} [o]
 * @returns {Overlay & { pid(): number | null }}
 */
export function makeOverlay({ bin = OVERLAY_BIN, readyMs = 3000, linger, ringMs, spawn = spawnChild, platform = process.platform } = {}) {
  /** @type {import("node:child_process").ChildProcessWithoutNullStreams | null} */
  let child = null;
  /** @type {Promise<void> | null} */
  let starting = null;
  /** @type {Array<() => void>} */
  const stops = [];

  const send = (/** @type {any} */ msg) => {
    if (!child || !child.stdin.writable) return;
    try { child.stdin.write(JSON.stringify(msg) + "\n"); } catch {}
  };

  function start() {
    if (platform !== "darwin") return Promise.reject(new HandsError("no_indicator", "the control indicator works only on macOS, and Vyre does not act without it"));
    if (!fs.existsSync(bin)) return Promise.reject(new HandsError("no_indicator", `the control indicator is not built, and Vyre does not act without it; run ${BUILD}`));
    const args = [];
    if (linger != null) args.push("--linger", String(linger));
    if (ringMs != null) args.push("--ring-ms", String(ringMs));
    const c = /** @type {import("node:child_process").ChildProcessWithoutNullStreams} */ (spawn(bin, args, { stdio: ["pipe", "pipe", "ignore"] }));
    child = c;
    return new Promise((ok, no) => {
      let ready = false, buf = "";
      const refuse = (/** @type {string} */ why) => { if (ready) return; ready = true; clearTimeout(timer); try { c.kill("SIGKILL"); } catch {}; no(new HandsError("no_indicator", why)); };
      const timer = setTimeout(() => refuse("the control indicator did not start, and Vyre does not act without it"), readyMs);
      c.stdout.on("data", d => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.ready && !ready) {
            // Without the Accessibility grant the helper cannot hear Escape or Control. A pill that
            // promises "Esc to stop" and cannot keep the promise is worse than none.
            if (m.keys !== true) { refuse("the control indicator cannot hear the stop keys; grant Accessibility to the app running Vyre, then try again"); continue; }
            ready = true; clearTimeout(timer); ok();
          } else if (m.stop) {
            for (const fn of stops) { try { fn(); } catch {} }
          }
        }
      });
      c.on("error", e => refuse(`the control indicator could not start (${e.message}), and Vyre does not act without it`));
      c.on("exit", () => {
        if (child === c) child = null;
        refuse("the control indicator exited while starting, and Vyre does not act without it");
      });
      c.stdin.on("error", () => {});
    });
  }

  function close() {
    const c = child; child = null;
    if (!c) return;
    try { c.stdin.end(); } catch {}
    // The helper exits on stdin close; the kill is for one that is stuck.
    setTimeout(() => { try { c.kill("SIGKILL"); } catch {} }, 1000).unref();
  }

  return {
    async controlling(app, at) {
      if (!child) {
        if (!starting) starting = start().finally(() => { starting = null; });
        await starting;
      }
      send({ controlling: { app, ...(at ? { x: at.x, y: at.y } : {}) } });
    },
    ring(r) { send({ ring: { x: r.x, y: r.y, ok: Boolean(r.ok) } }); },
    // A finished session lets go of the helper at once, so an act right after it starts a fresh
    // one instead of talking to a helper that is on its way out.
    done() { send({ done: true }); close(); },
    close,
    onStop(fn) { stops.push(fn); },
    pid() { return child ? child.pid ?? null : null; },
  };
}
