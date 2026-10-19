// @ts-check
// The New thread page's two acts, with their calls handed in so Node can test them: the first message makes the thread (once) and posts the words, and a device that is not ready is asked again until it is.

/**
 * Send the first message of a new thread. Nothing exists on the server before this: `start` makes the one thread, `send` posts the words into it, and if the post fails the words wait in that thread's box.
 * An empty message makes nothing. @param {{ name: string, text: string }} o
 * @param {{ start: (agent: string) => Promise<{ thread: string } | { problem: string }>, send: (thread: string, text: string) => Promise<void>, keep: (thread: string, text: string) => void }} calls
 * @returns {Promise<{ thread: string } | { problem: string } | null>}
 */
export async function sendFirst(o, calls) {
  const text = String(o.text || "").trim();
  if (!text || !o.name) return null;
  const made = await calls.start(o.name);
  if ("problem" in made) return made;
  try { await calls.send(made.thread, text); } catch { calls.keep(made.thread, text); }
  return { thread: made.thread };
}

/**
 * Whether the device can start a private chat, asked now and again every `every` ms while it cannot; `on(gap)` hears each answer (a line, or null once it can). `again()` asks at once (Try again, coming back to the page).
 * @param {{ check: () => Promise<string | null>, on: (gap: string | null) => void, every: number, timers?: { set: (f: () => void, ms: number) => any, clear: (t: any) => void } }} o
 */
export function watchReadiness(o) {
  const set = o.timers?.set ?? ((f, ms) => setInterval(f, ms)), clear = o.timers?.clear ?? ((t) => clearInterval(t));
  /** @type {any} */ let timer = null;
  let stopped = false;
  const stop = () => { if (timer !== null) { clear(timer); timer = null; } };
  const again = async () => {
    if (stopped) return;
    let gap = null;
    try { gap = await o.check(); } catch { gap = "Vyre did not answer."; }
    if (stopped) return;
    o.on(gap);
    if (gap && timer === null) timer = set(() => { void again(); }, o.every);
    if (!gap) stop();
  };
  return { again, stop: () => { stopped = true; stop(); } };
}
