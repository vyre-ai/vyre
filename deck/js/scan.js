// @ts-check
// Scan your avatar to pair your phone: the camera side. Opens the back camera (getUserMedia),
// grabs frames onto an offscreen canvas at a fixed interval (not every frame - a full decode
// attempt is real work, see the perf note below), and hands each grab to a decode Worker
// (scan-worker.js) until one resolves to a real (RS/CRC-valid) ticket, or the caller stops it.
//
// Deliberately NOT a live 30fps scan loop: docs/work/pwa.md's harness measurement puts a single
// full decode attempt at roughly 1-2s of JS work (a continuous 0-360deg x 9-scale search, tried
// candidate-by-candidate until one RS-validates). This throttles to one attempt in flight at a
// time, spaced by ATTEMPT_MS.
//
// The search itself runs in scan-worker.js, not here: that ~1-2s of work would otherwise freeze
// the camera preview (a canvas redraw) and the whole page for its duration, every attempt. A
// Worker moves it off the main thread - the preview keeps redrawing and the rest of the Deck
// stays responsive while a scan is in flight. This does NOT itself hit the lead's under-200ms/
// attempt target: it moves the same cost off the main thread, it doesn't make it smaller. The
// actual speed lever - a cheap localization pre-pass so the search only refines near the code's
// real position/scale instead of a blind sweep - is a separate, larger change, not built here;
// see decode-core2.js's own perf note and docs/work/pwa.md's "Next".
//
//   startScan({ video, onFound, onError, onSlow }) -> { stop() }
//     video: an existing <video> element this attaches the camera stream to (muted, playsinline,
//     autoplay are set here; the caller lays it out).
//     onSlow(): called once, ~2s after scanning starts, if nothing has decoded yet (team-lead,
//     2026-09-28) - a plain hint ("Hold your phone straight on to the screen") for the common
//     real cause, since the perspective-correction search is the weakest part of this decoder
//     (docs/work/pwa.md's own numbers). Not itself a sign anything is wrong; scanning keeps
//     going exactly as before, this only adds a hint on top.
//     onFound(ticket, avatarDataUrl): called once, the first time a frame decodes. `ticket` is
//     the raw 8-byte value AS BYTES, never as a string - deck/js/pair-ticket.js is the only
//     thing that touches it past here, and it is the pairing SECRET in this flow (reviewer's
//     HIGH 1 on work/pwa bdca618b), so it is never hex-encoded, logged or put anywhere a string
//     would be (a URL, localStorage) on the way there. `avatarDataUrl` is a small crop of the
//     decoded frame's own centre (the face the ring was drawn around, upright-rotated using the
//     winning candidate's own rot/scale) for the success screen's dance - a fallback only; the
//     success screen prefers a freshly rendered avatar (see pair-avatar.js) and only falls back
//     to this photo if that rendering throws. The caller stops the scan itself (or calls stop()
//     again defensively).
//     onError(err): camera permission refused, no camera, the stream ending unexpectedly, or the
//     decode worker itself throwing (worker.onerror) - scanning stops for good in every case,
//     never retries on its own; the caller's own "Scan again" is what restarts it (reviewer-2's
//     read of fa619b4a, spelled out here per their note).

const ATTEMPT_MS = 350; // gap between the END of one decode attempt and the start of the next
const FRAME_SIZE = 640; // grabbed frame side, in CSS px equivalent - plenty for a code held at
                         // arm's length; bigger only costs decode time, not accuracy past this
const SLOW_MS = 2000; // onSlow's own delay, from when the camera is actually ready

const FACE_R = 180; // decode-core2.js's own FACE_R: half the face diameter, in the code's
                     // reference units - a captured frame's face radius is this * cand.scale

/**
 * @param {{ video: HTMLVideoElement, onFound: (ticket: Uint8Array, avatarDataUrl: string | null) => void, onError: (err: Error) => void, onSlow?: () => void }} opts
 * @returns {{ stop: () => void }}
 */
export function startScan({ video, onFound, onError, onSlow }) {
  let stopped = false;
  /** @type {MediaStream | null} */ let stream = null;
  const canvas = document.createElement("canvas");
  canvas.width = FRAME_SIZE; canvas.height = FRAME_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const worker = new Worker(new URL("./scan-worker.js", import.meta.url), { type: "module" });
  let found = false;
  let busy = false; // an attempt is in flight at the worker; never send a second one
  let timer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
  let slowTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);

  (async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("This browser cannot use the camera."), { code: "no_camera" });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
      if (stopped) { stopTracks(stream); return; }
      video.srcObject = stream;
      video.muted = true; video.playsInline = true; video.autoplay = true;
      await video.play().catch(() => {}); // a user gesture usually already opened this sheet
      for (const track of stream.getVideoTracks()) track.addEventListener("ended", () => { if (!stopped) onError(Object.assign(new Error("The camera stopped."), { code: "camera_ended" })); });
      if (onSlow) slowTimer = setTimeout(() => { if (!stopped && !found) onSlow(); }, SLOW_MS);
      scheduleAttempt();
    } catch (err) {
      onError(/** @type {Error} */ (err));
    }
  })();

  worker.onmessage = (/** @type {MessageEvent} */ e) => {
    busy = false;
    if (stopped || found) return;
    const { ticket, rot, scale, correction } = e.data;
    if (ticket) {
      found = true;
      onFound(new Uint8Array(ticket), cropAvatar(canvas, { rot, scale, correction }));
      return;
    }
    scheduleAttempt();
  };
  worker.onerror = (e) => { busy = false; if (!stopped && !found) { onError(Object.assign(new Error(e.message || "The scanner failed."), { code: "scan_worker" })); } };

  function scheduleAttempt() {
    if (stopped || found) return;
    timer = setTimeout(runAttempt, ATTEMPT_MS);
  }

  function runAttempt() {
    if (stopped || found || busy || !ctx || video.readyState < video.HAVE_CURRENT_DATA) { scheduleAttempt(); return; }
    // Centre-crop the video frame to a square (a code is round; a square frame wastes no pixels
    // on letterboxing either side of a portrait camera feed) before scaling to FRAME_SIZE.
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) { scheduleAttempt(); return; }
    const side = Math.min(vw, vh);
    const sx = (vw - side) / 2, sy = (vh - side) / 2;
    ctx.drawImage(video, sx, sy, side, side, 0, 0, FRAME_SIZE, FRAME_SIZE);
    let data;
    try { data = ctx.getImageData(0, 0, FRAME_SIZE, FRAME_SIZE); } catch { scheduleAttempt(); return; } // a transient decode error on some frames, not fatal
    busy = true;
    // The pixel buffer transfers (no copy) to the worker; getImageData already gave us our own
    // copy, so handing its backing buffer away costs nothing here.
    worker.postMessage({ data: data.data, width: FRAME_SIZE, height: FRAME_SIZE }, [data.data.buffer]);
  }

  /** A small, upright crop of the decoded frame's own centre (the face the ring was drawn
   * around), using the winning candidate's own rotation and scale - kept only as a fallback for
   * pair-avatar.js's freshly rendered avatar (see that file). Skipped (returns null) when a
   * perspective correction was used: cropping straight from the raw (still-tilted) frame would
   * look wrong, and a slightly plainer fallback beats a warped one. */
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
      if (slowTimer) clearTimeout(slowTimer);
      if (stream) stopTracks(stream);
      video.srcObject = null;
      worker.terminate();
    },
  };
}

function stopTracks(/** @type {MediaStream} */ stream) { for (const t of stream.getTracks()) t.stop(); }
