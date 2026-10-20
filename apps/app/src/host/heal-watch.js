// @ts-check
// When the in-page host runs its repairs again (identity.heal in host-core.js: private chats, and the owner's Space listed as served by its server). The key being loaded runs them once; this runs them
// again when the app's connection comes back (the stream goes from reconnecting or offline to live, or the browser says it is online again) and on a slow timer, so a Space whose address the server
// cannot serve heals while the app is open, without the person doing anything. Pure: the clock, the connection and the call are passed in.

/**
 * @param {{
 *   heal: () => Promise<unknown>,
 *   onConnection?: (f: (s: { status: string }) => void) => () => void,
 *   onOnline?: (f: () => void) => () => void,
 *   everyMs?: number,
 *   setInterval?: (f: () => void, ms: number) => any,
 *   clearInterval?: (h: any) => void,
 * }} o
 * @returns {{ stop: () => void }}
 */
export function watchHeal(o) {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    Promise.resolve().then(o.heal).catch(() => { /* the host keeps the reason for Account */ }).finally(() => { running = false; });
  };
  /** @type {(() => void)[]} */ const offs = [];
  let was = "live";
  if (o.onConnection) offs.push(o.onConnection((s) => { const now = s && s.status; if (now === "live" && was !== "live") run(); if (typeof now === "string") was = now; }));
  if (o.onOnline) offs.push(o.onOnline(run));
  const every = o.everyMs ?? 10 * 60_000;
  const si = o.setInterval || ((f, ms) => setInterval(f, ms));
  const ci = o.clearInterval || ((h) => clearInterval(h));
  const timer = every > 0 ? si(run, every) : null;
  if (timer && typeof timer === "object" && typeof timer.unref === "function") timer.unref();
  return { stop: () => { for (const off of offs) { try { off(); } catch { /* gone */ } } if (timer) ci(timer); } };
}
