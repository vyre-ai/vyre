// Stand-in for an agent's Chrome debugging pipe: NUL-terminated JSON, the same bytes agentd's relay carries.
// Records the page the hands navigate to. Speaks only on stdout.
import fs from "node:fs";

const note = process.env.DESK_CDP_NOTE || "";
let buf = Buffer.alloc(0);
let url = "about:blank";

/** @param {any} m */
function send(m) { process.stdout.write(JSON.stringify(m) + "\0"); }

/** @param {any} m */
function handle(m) {
  const id = m.id;
  const method = String(m.method || "");
  if (method === "Target.getTargets") return send({ id, result: { targetInfos: [] } });
  if (method === "Target.createTarget") return send({ id, result: { targetId: "t1" } });
  if (method === "Target.attachToTarget") return send({ id, result: { sessionId: "s1" } });
  if (method === "Page.enable" || method === "Runtime.enable" || method === "DOM.enable") return send({ id, result: {} });
  if (method === "Page.navigate") {
    url = m.params && m.params.url ? String(m.params.url) : url;
    if (note) fs.writeFileSync(note, url);
    send({ id, result: { frameId: "f1" } });
    send({ method: "Page.loadEventFired", sessionId: m.sessionId || "s1", params: {} });
    return;
  }
  if (method === "Runtime.evaluate") return send({ id, result: { result: { type: "object", value: { title: "Example", url, text: "", controls: [] } } } });
  if (Number.isInteger(id)) send({ id, result: {} });
}

process.stdin.on("data", (/** @type {Buffer} */ c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const i = buf.indexOf(0);
    if (i < 0) return;
    const text = buf.subarray(0, i).toString("utf8");
    buf = buf.subarray(i + 1);
    try { handle(JSON.parse(text)); } catch { /* a torn frame is skipped */ }
  }
});
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
