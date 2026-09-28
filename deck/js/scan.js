// @ts-check
// Scan your avatar to pair your phone: the camera side. Opens the back camera (getUserMedia),
// grabs frames onto an offscreen canvas at a fixed interval (not every frame - decode-core2's
// full rotation/scale search is heavy, see the perf note below), and runs the Vyre code decoder
// against each grab until one resolves to a real (RS/CRC-valid) id, or the caller stops it.
//
// Deliberately NOT a live 30fps scan loop: docs/work/pwa.md's harness measurement puts a single
// full decode attempt at roughly 1-2s of JS work (a continuous 0-360deg x 9-scale search, tried
// candidate-by-candidate until one RS-validates). Attempting on every frame would pin the main
// thread solid, so this throttles to one attempt in flight at a time, spaced by ATTEMPT_MS, and
// yields between attempts. A follow-up (not built here): move the search into a Worker so the
// preview never stutters, and add a cheap localization pre-pass (find the tint disc's
// approximate centre/radius first) so the search only has to refine near it instead of a blind
// full sweep - see decode-core2.js's own NOTES on this.
//
//   startScan({ video, onFound, onError }) -> { stop() }
//     video: an existing <video> element this attaches the camera stream to (muted, playsinline,
//     autoplay are set here; the caller lays it out).
//     onFound(ticket, avatarDataUrl): called once, the first time a frame decodes. `ticket` is
//     the raw 8-byte value AS BYTES, never as a string - deck/js/pair-ticket.js is the only
//     thing that touches it past here, and it is the pairing SECRET in this flow (reviewer's
//     HIGH 1 on work/pwa bdca618b), so it is never hex-encoded, logged or put anywhere a string
//     would be (a URL, localStorage) on the way there. `avatarDataUrl` is a small crop of the
//     decoded frame's own centre (the face the ring was drawn around, upright-rotated using the
//     winning candidate's own rot/scale) for the success screen's dance - not a re-derived
//     vector avatar (this scanner has no access to app-design's renderer/seed), a photo of the
//     real one that was just on screen. The caller stops the scan itself (or calls stop() again
//     defensively).
//     onError(err): camera permission refused, no camera, or the stream ending unexpectedly.

import { decodeCore2 } from "../vyrecode/decode-core2.js";
import * as payload from "../vyrecode/payload.js";

const ATTEMPT_MS = 350; // gap between the END of one decode attempt and the start of the next
const FRAME_SIZE = 640; // grabbed frame side, in CSS px equivalent - plenty for a code held at
                         // arm's length; bigger only costs decode time, not accuracy past this

const FACE_R = 180; // decode-core2.js's own FACE_R: half the face diameter, in the code's
                     // reference units - a captured frame's face radius is this * cand.scale

/**
 * @param {{ video: HTMLVideoElement, onFound: (ticket: Uint8Array, avatarDataUrl: string | null) => void, onError: (err: Error) => void }} opts
 * @returns {{ stop: () => void }}
 */
export function startScan({ video, onFound, onError }) {
  let stopped = false;
  /** @type {MediaStream | null} */ let stream = null;
  const canvas = document.createElement("canvas");
  canvas.width = FRAME_SIZE; canvas.height = FRAME_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const core = decodeCore2();
  let found = false;
  let timer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);

  (async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("This browser cannot use the camera."), { code: "no_camera" });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
      if (stopped) { stopTracks(stream); return; }
      video.srcObject = stream;
      video.muted = true; video.playsInline = true; video.autoplay = true;
      await video.play().catch(() => {}); // a user gesture usually already opened this sheet
      for (const track of stream.getVideoTracks()) track.addEventListener("ended", () => { if (!stopped) onError(Object.assign(new Error("The camera stopped."), { code: "camera_ended" })); });
      scheduleAttempt();
    } catch (err) {
      onError(/** @type {Error} */ (err));
    }
  })();

  function scheduleAttempt() {
    if (stopped || found) return;
    timer = setTimeout(runAttempt, ATTEMPT_MS);
  }

  function runAttempt() {
    if (stopped || found || !ctx || video.readyState < video.HAVE_CURRENT_DATA) { scheduleAttempt(); return; }
    // Centre-crop the video frame to a square (a code is round; a square frame wastes no pixels
    // on letterboxing either side of a portrait camera feed) before scaling to FRAME_SIZE.
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) { scheduleAttempt(); return; }
    const side = Math.min(vw, vh);
    const sx = (vw - side) / 2, sy = (vh - side) / 2;
    ctx.drawImage(video, sx, sy, side, side, 0, 0, FRAME_SIZE, FRAME_SIZE);
    let data;
    try { data = ctx.getImageData(0, 0, FRAME_SIZE, FRAME_SIZE); } catch { scheduleAttempt(); return; } // a transient decode error on some frames, not fatal
    const getLum = (/** @type {number} */ x, /** @type {number} */ y) => {
      x = Math.round(x); y = Math.round(y);
      if (x < 0 || y < 0 || x >= FRAME_SIZE || y >= FRAME_SIZE) return null;
      const i = (y * FRAME_SIZE + x) * 4;
      return 0.2126 * data.data[i] + 0.7152 * data.data[i + 1] + 0.0722 * data.data[i + 2];
    };
    // Try candidates in confidence order (searchWithPerspective already sorts them) and stop at
    // the first one that RS/CRC-validates - almost always well before the tail of the list.
    const candidates = core.searchWithPerspective(getLum, FRAME_SIZE / 2, FRAME_SIZE / 2, {});
    for (const cand of candidates) {
      const bits = levelsToBits(cand.levels);
      const bytes = payload.bitsToBytes(bits);
      const recovered = payload.recoverId(bytes);
      if (recovered) {
        found = true;
        onFound(new Uint8Array(recovered.id8), cropAvatar(canvas, cand));
        return;
      }
    }
    scheduleAttempt();
  }

  /** A small, upright crop of the decoded frame's own centre (the face the ring was drawn
   * around), using the winning candidate's own rotation and scale - this scanner has no avatar
   * renderer of its own (that's app-design's), so the success screen's "same avatar" is a photo
   * of the real one, not a redrawn copy. Skipped (returns null) when a perspective correction was
   * used: cropping straight from the raw (still-tilted) frame would look wrong, and a slightly
   * plainer success screen beats a warped one. */
  function cropAvatar(/** @type {HTMLCanvasElement} */ src, /** @type {any} */ cand) {
    if (cand.correction && cand.correction !== "none") return null;
    try {
      const side = Math.round(FACE_R * 2 * cand.scale * 1.05);
      const out = document.createElement("canvas");
      out.width = out.height = 128;
      const octx = out.getContext("2d");
      if (!octx) return null;
      octx.save();
      octx.translate(64, 64);
      octx.rotate(-cand.rot * Math.PI / 180);
      octx.drawImage(src, FRAME_SIZE / 2 - side / 2, FRAME_SIZE / 2 - side / 2, side, side, -64, -64, 128, 128);
      octx.restore();
      return out.toDataURL("image/png");
    } catch { return null; } // a transient canvas error here just means no crop, not a failure
  }

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (stream) stopTracks(stream);
      video.srcObject = null;
    },
  };
}

function stopTracks(/** @type {MediaStream} */ stream) { for (const t of stream.getTracks()) t.stop(); }

/** Mirrors vyrecode2.js's levelsToBits (2 bits per mark) without importing the renderer (which
 * pulls in avatar assets this scanner never needs - see decode-core2.js's own header). */
function levelsToBits(/** @type {number[]} */ levels) {
  const bits = [];
  for (const lv of levels) { bits.push((lv >> 1) & 1, lv & 1); }
  return bits;
}
