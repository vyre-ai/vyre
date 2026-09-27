// @ts-check
// talk: push-to-talk from a terminal, for trying voice before the native Capsule exists.
//
// Enter starts an utterance: vyre-mic is spawned and its PCM goes to vyred's listen stream as
// it arrives. Enter again stops it: the mic's stdin is closed (which is how vyre-mic is told to
// stop), and once its last bytes are sent, {"type":"end"} asks for the finished words. Interim
// words are drawn in place on one line; the finished words stay on their own line.
//
// Audio is buffered here only between the mic starting and the stream opening, so the first
// word is not lost to the handshake. Nothing is written to disk and nothing is logged.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connect } from "./ws.js";

export const MIC_BIN = path.join(import.meta.dirname, "bin", "vyre-mic");

/**
 * @typedef {{ type: string, text?: string, code?: string, message?: string }} Heard
 * @typedef {{ bin: string, args?: string[], env?: NodeJS.ProcessEnv }} MicSpec
 */

/**
 * One utterance. Returns { stop(), done } where done resolves to the last message from vyred
 * ({ type: "done", text } or { type: "error", code, message }).
 * @param {{ socketPath: string, mic: MicSpec, caller?: string, onHeard?: (m: Heard) => void }} o
 */
export async function utterance({ socketPath, mic, caller = "cli", onHeard = () => {} }) {
  const proc = spawn(mic.bin, mic.args || [], { stdio: ["pipe", "pipe", "pipe"], env: mic.env || process.env });
  /** @type {Buffer[]} */
  let early = [];
  let micErr = "";
  /** @type {import("./ws.js").Peer | null} */
  let peer = null;
  let micDone = false, stopped = false, ended = false;
  /** @type {(m: Heard) => void} */
  let settle = () => {};
  /** @type {Promise<Heard>} */
  const done = new Promise(r => { settle = r; });
  let settled = false;
  const finish = (/** @type {Heard} */ m) => { if (settled) return; settled = true; try { proc.stdin.end(); } catch {} if (peer) { try { peer.close(1000); } catch {} } settle(m); };

  const sendEnd = () => { if (ended || !peer || !micDone) return; ended = true; peer.json({ type: "end" }); };

  proc.stdout.on("data", b => { if (peer) peer.binary(b); else early.push(b); });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", s => { if (micErr.length < 2000) micErr += s; });
  proc.stdin.on("error", () => {});
  proc.on("error", e => finish({ type: "error", code: "mic_failed", message: `vyre-mic did not start: ${/** @type {any} */ (e).code || e.message}` }));
  proc.on("close", code => {
    micDone = true;
    if (code && !stopped) {
      let m = { code: "mic_failed", error: `vyre-mic exited with ${code}` };
      try { m = JSON.parse(micErr.trim().split("\n").pop() || "{}"); } catch {}
      finish({ type: "error", code: m.code || "mic_failed", message: m.error || `vyre-mic exited with ${code}` });
      return;
    }
    sendEnd();
  });

  const r = await connect("ws://vyred/v1/streams/voice/listen", { socketPath, headers: { "x-vyre-caller": caller } });
  if (!r.peer) {
    let message = r.unreachable ? "vyred is not running; vyre up to start it" : `vyred refused the stream (${r.status})`;
    try { const b = JSON.parse(String(r.body || "")); if (b.error?.message) message = b.error.message; } catch {}
    finish({ type: "error", code: r.unreachable ? "unreachable" : "refused", message });
    return { stop() {}, done };
  }
  peer = r.peer;
  peer.on("message", m => {
    let msg;
    try { msg = JSON.parse(String(m.text)); } catch { return; }
    if (msg.type === "done" || msg.type === "error") { finish(msg); return; }
    onHeard(msg);
  });
  peer.on("close", () => finish({ type: "error", code: "closed", message: "vyred closed the stream" }));
  for (const b of early) peer.binary(b);
  early = [];
  if (settled) peer.close(1000);
  sendEnd();

  return {
    /** The talk key came up: stop the mic; the end frame follows its last bytes. */
    stop() { if (stopped) return; stopped = true; try { proc.stdin.end(); } catch {} },
    done,
  };
}

/**
 * The interactive loop: Enter toggles, Ctrl-C (or the end of stdin) quits. Returns an exit code.
 * @param {{ socketPath: string, mic?: MicSpec, input?: NodeJS.ReadableStream & { isTTY?: boolean, setRawMode?: (b: boolean) => void }, output?: NodeJS.WritableStream & { isTTY?: boolean }, onFinal?: (text: string) => Promise<void> | void }} o
 */
export async function talkLoop({ socketPath, mic = { bin: MIC_BIN }, input = process.stdin, output = process.stdout, onFinal }) {
  if (!fs.existsSync(mic.bin)) {
    output.write(`  vyre-mic is not built. Build it with: sh ${path.join(import.meta.dirname, "build.sh")}\n`);
    return 1;
  }
  const tty = !!output.isTTY;
  const line = (/** @type {string} */ s) => output.write(tty ? `\r\x1b[2K${s}` : `${s}\n`);
  const raw = !!(input.isTTY && input.setRawMode);
  if (raw) input.setRawMode?.(true);
  output.write("  Enter to talk, Enter again to stop, Ctrl-C to quit\n");

  /** @type {Awaited<ReturnType<typeof utterance>> | null} */
  let live = null;
  // Between Enter and the stream opening: a second Enter then is remembered, not a new utterance.
  let starting = false, stopWanted = false;
  let code = 0;
  let quitting = false;
  let resolveQuit = () => {};
  const quit = new Promise(r => { resolveQuit = () => r(undefined); });

  const toggle = async () => {
    if (live) { live.stop(); return; }
    if (starting) { stopWanted = true; return; }
    starting = true; stopWanted = false;
    line("  listening...");
    const u = await utterance({ socketPath, mic, onHeard: m => { if (m.text) line(`  ${m.text}`); } });
    live = u; starting = false;
    if (stopWanted || quitting) u.stop();
    const last = await u.done;
    live = null;
    if (last.type === "done") {
      if (last.text) line(`  ${last.text}\n`); else line("  (nothing heard)\n");
      if (last.text && onFinal) await onFinal(last.text);
    } else {
      line(`  ${last.code}: ${last.message}\n`);
      code = 1;
    }
    if (quitting) resolveQuit();
  };

  const onData = (/** @type {Buffer|string} */ chunk) => {
    for (const ch of String(chunk)) {
      if (ch === "\x03" || ch === "\x04") { stopAll(); return; }
      if (ch === "\r" || ch === "\n") toggle();
    }
  };
  const stopAll = () => {
    if (quitting) return;
    quitting = true;
    if (live) live.stop(); else if (!starting) resolveQuit();
  };
  input.on("data", onData);
  input.on("end", stopAll);
  process.once("SIGINT", stopAll);
  await quit;
  input.off("data", onData);
  process.off("SIGINT", stopAll);
  if (raw) input.setRawMode?.(false);
  if (typeof /** @type {any} */ (input).pause === "function") /** @type {any} */ (input).pause();
  output.write(tty ? "\r\x1b[2K" : "");
  return code;
}
