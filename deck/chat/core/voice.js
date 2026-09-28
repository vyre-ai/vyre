// @ts-check
// Push-to-talk (local/voice, capsule-pro's contract): voice.status says whether a key is saved;
// voice.listen mints a single-use ticket for /v1/streams/voice/listen (term.js's own pattern -
// authenticated HTTP first, then the WebSocket opens with the ticket already in its path, since a
// browser WebSocket cannot carry the x-vyre-caller header a Node client sets as a plain header).
// Sends 16 kHz mono linear16 PCM while the key or button is held, hears listening/partial/final/
// done/error JSON text frames back. Never touches, logs or shows the key; never auto-sends what it
// hears - the composer puts the words in the box to edit.

import { attempt } from "../../js/api.js";

/** @typedef {{ ready: boolean, provider: string|null }} VoiceStatus */

/** @returns {Promise<VoiceStatus|null>} null: the call itself failed (an older box, offline) - not the same as "no key". */
export async function voiceStatus() {
  const r = await attempt("voice.status", {});
  if (r.error) return null;
  const d = /** @type {any} */ (r.data) || {};
  return { ready: d.key === true, provider: d.provider || null };
}

/** @param {string} path a same-origin path with its ticket already in it (term.js's own shape). */
const wsUrl = path => (location.protocol === "https:" ? "wss://" : "ws://") + location.host + path;

/** Fixed words for the box's error codes; a code this file does not know says nothing here (the
 *  caller falls back to the box's own message, never raw beyond that). @param {string} code */
export function voiceErrorText(code) {
  if (code === "no_key") return "Add a voice key in Settings to use push-to-talk.";
  if (code === "too_long") return "That went on too long - try a shorter one.";
  if (code === "idle") return "Nothing was heard.";
  if (code === "provider_error") return "The voice service could not be reached.";
  if (code === "stopped") return null; // a clean stop from this side, not an error to show
  return null;
}

/**
 * Opens the mic and streams to /v1/streams/voice/listen until stop() is called or the box ends
 * it (done, error or a close). handlers hear partial and final text as it arrives; onDone is the
 * last word before the socket closes. Never sends anything itself - the caller decides what the
 * words become.
 * @param {{ onOpen?: () => void, onPartial: (text: string) => void, onFinal: (text: string) => void,
 *   onDone: (text: string) => void, onError: (message: string) => void, onLevel?: (level: number) => void }} handlers
 *   onLevel: the real mic level, 0 to 1, throttled to about 10 Hz - for a live ring, not per-frame.
 * @returns {Promise<{ stop: () => void }>}
 */
export async function listen(handlers) {
  const t = await attempt("voice.listen", {});
  if (t.error) { handlers.onError(t.missing ? "This session cannot use voice yet." : "Could not start listening."); return { stop() {} }; }
  const path = /** @type {any} */ (t.data)?.path;
  if (!path) { handlers.onError("Could not start listening."); return { stop() {} }; }

  let stopped = false;
  /** @type {MediaStream|undefined} */ let stream;
  /** @type {AudioContext|undefined} */ let ctx;
  /** @type {MediaStreamAudioSourceNode|undefined} */ let source;
  /** @type {ScriptProcessorNode|undefined} */ let proc;
  /** @type {GainNode|undefined} */ let mute;
  /** @type {WebSocket|undefined} */ let ws;
  /** @type {ReturnType<typeof setTimeout>|null} */ let fallback = null;
  const cleanup = () => {
    if (fallback) { clearTimeout(fallback); fallback = null; }
    try { proc?.disconnect(); } catch {}
    try { mute?.disconnect(); } catch {}
    try { source?.disconnect(); } catch {}
    try { ctx?.close(); } catch {}
    try { stream?.getTracks().forEach(x => x.stop()); } catch {}
    // A tap that stops before the socket ever opens (WebSocket starts CONNECTING; onopen is at
    // least a microtask away, a real round trip in production) must not just walk away from it -
    // .close() on any readyState (including CONNECTING) is a harmless no-op if already shut.
    try { ws?.close(); } catch {}
    handlers.onLevel?.(0);
  };

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    const denied = /** @type {any} */ (err)?.name === "NotAllowedError" || /** @type {any} */ (err)?.name === "SecurityError";
    handlers.onError(denied ? "The microphone is blocked - allow it for this site in the browser's settings, then try again."
      : "Could not use the microphone - check that one is connected.");
    return { stop() {} };
  }
  if (stopped) { cleanup(); return { stop() {} }; }

  try { ws = new WebSocket(wsUrl(path)); } catch { cleanup(); handlers.onError("Could not start listening."); return { stop() {} }; }
  ws.binaryType = "arraybuffer";
  /** @type {ArrayBuffer[]} */ let early = [];
  let socketOpen = false;
  ws.onopen = () => { socketOpen = true; for (const f of early) ws.send(f); early = []; };
  ws.onmessage = e => {
    /** @type {any} */ let m;
    try { m = JSON.parse(String(e.data)); } catch { return; }
    if (m.type === "partial") handlers.onPartial(String(m.text || ""));
    else if (m.type === "final") handlers.onFinal(String(m.text || ""));
    else if (m.type === "done") { handlers.onDone(String(m.text || "")); cleanup(); }
    else if (m.type === "error") { const t = voiceErrorText(m.code); if (t) handlers.onError(t); cleanup(); }
  };
  ws.onclose = () => cleanup();

  try {
    ctx = new AudioContext({ sampleRate: 16000 });
    source = ctx.createMediaStreamSource(stream);
    proc = ctx.createScriptProcessor(4096, 1, 1);
    // Chrome only pulls audio through a node that reaches the destination; muted so the mic never
    // plays back through the speakers.
    mute = ctx.createGain();
    mute.gain.value = 0;
    let lastLevel = 0;
    proc.onaudioprocess = e => {
      if (stopped) return;
      const input = e.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      let sumSq = 0;
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        sumSq += s * s;
      }
      if (socketOpen && ws.readyState === WebSocket.OPEN) ws.send(pcm.buffer);
      else early.push(pcm.buffer);
      // ~10 Hz: a 4096-frame buffer at 16 kHz is 256 ms already, so every callback is plenty.
      const now = Date.now();
      if (handlers.onLevel && now - lastLevel > 90) { lastLevel = now; handlers.onLevel(Math.min(1, Math.sqrt(sumSq / input.length) * 4)); }
    };
    source.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination);
  } catch {
    cleanup();
    handlers.onError("Could not start listening.");
    return { stop() {} };
  }
  handlers.onOpen?.();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (ws.readyState === WebSocket.OPEN) {
        // Waiting on the server now: done/error/close usually follow within TAIL_MS
        // (local/voice/listen.js: 5 s) - clean up regardless so a dropped connection never
        // leaves the mic open. Not scheduled below: cleanup() (this closes the socket itself
        // too) already ran synchronously in every other case, so a second real timer here would
        // just dangle for up to 6 s doing nothing.
        try { ws.send(JSON.stringify({ type: "end" })); fallback = setTimeout(() => { if (ctx && ctx.state !== "closed") cleanup(); }, 6000); }
        catch { cleanup(); }
      } else cleanup(); // not yet open (or already closed): nothing to wait on, clean up now
    },
  };
}
