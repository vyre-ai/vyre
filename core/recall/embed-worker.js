// @ts-check
// The search model's own process, at the lowest priority. vyred forks it (embed.js
// spawnEmbedder) so the model's CPU never competes with the person's work or with vyred
// answering: it runs niced to 19, the model on one thread, and exits with its parent.
//
// Messages in: { type: "load", opts } then { type: "embed", id, text } or { type: "usage", id }.
// Messages out: { type: "loaded", model?, why? }, { type: "vec", id, v?, error? },
// { type: "usage", id, cpu, nice }.

import os from "node:os";
import { load } from "./embed.js";

try { os.setPriority(19); } catch { /* a platform that will not: the parent tried too */ }

/** @type {import("./embed.js").Embedder | null} */
let embedder = null;
const send = m => { if (process.connected) process.send?.(m); };

process.on("message", async (/** @type {any} */ m) => {
  if (m.type === "load") {
    const r = await load(m.opts);
    embedder = r.embedder || null;
    send({ type: "loaded", model: embedder ? embedder.model : null, why: r.why || null });
  } else if (m.type === "embed") {
    if (!embedder) return send({ type: "vec", id: m.id, error: "the model is not loaded" });
    try { send({ type: "vec", id: m.id, v: Array.from(await embedder.embed(m.text)) }); }
    catch (e) { send({ type: "vec", id: m.id, error: String(/** @type {Error} */ (e).message) }); }
  } else if (m.type === "usage") {
    let nice = null;
    try { nice = os.getPriority(); } catch {}
    send({ type: "usage", id: m.id, cpu: process.cpuUsage(), nice });
  }
});
process.on("disconnect", () => process.exit(0));
