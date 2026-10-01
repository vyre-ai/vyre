// @ts-check
// adopt: how the loader hands a verified build to the service worker and waits for it. Its own
// file so the real-browser proof (relay/app/testing/boot-chrome.mjs) runs this exact code.

const within = (p, ms) => Promise.race([p, new Promise(res => setTimeout(res, ms))]);

/** Register the worker. Resolves either way: a browser without one still boots. */
export function registerWorker() {
  return "serviceWorker" in navigator ? navigator.serviceWorker.register("/sw.js").catch(() => {}) : Promise.resolve();
}

/**
 * Start the app only once the worker controls this page and has re-verified the build, so the
 * app's first /app/<path> requests (fonts, icons) are answered from it. A browser without a
 * worker, or one that is slow to take control, boots anyway after a few seconds.
 * @param {{ sha: string, manifest: string }} want
 * @param {Promise<unknown>} registered
 */
export async function adoptInWorker(want, registered) {
  if (!("serviceWorker" in navigator)) return;
  const sw = navigator.serviceWorker;
  await within(registered.then(() => sw.ready), 8000);
  if (!sw.controller) await within(new Promise(res => sw.addEventListener("controllerchange", res, { once: true })), 4000);
  if (!sw.controller) return;
  // Only this build's own answer counts: another tab's ack, or a refusal, is not ours.
  const done = new Promise(res => sw.addEventListener("message", function on(e) {
    const m = e.data;
    if (m && m.type === "vyre-build" && m.sha === want.sha) { sw.removeEventListener("message", on); res(m.ok === true); }
  }));
  sw.controller.postMessage({ type: "vyre-build", sha: want.sha, manifest: want.manifest });
  await within(done, 5000);
}
