// @ts-check
// Where a stalled eval harness is, asked from outside: the harness runs with its inspector open on loopback, and a busy loop cannot refuse a pause. The supervisor in scripts/eval-honest.mjs calls
// whereIsIt() before it ends a harness that stopped beating, so a stall names the line it spins on.

/**
 * The call frames of a process whose inspector listens at `wsUrl`, paused where it is.
 * @param {string} wsUrl e.g. ws://127.0.0.1:9229/<uuid> @param {number} [ms] how long to wait for the pause
 * @returns {Promise<string[]>} "function (file:line)" for the top frames; empty when it did not answer in time
 */
export function whereIsIt(wsUrl, ms = 5000) {
  return new Promise((resolve) => {
    /** @type {string[]} */ let frames = [];
    /** @type {Map<string, string>} */ const urls = new Map();
    let done = false;
    const ws = new WebSocket(wsUrl);
    const end = () => { if (done) return; done = true; clearTimeout(t); try { ws.close(); } catch { /* closed */ } resolve(frames); };
    const t = setTimeout(end, ms);
    ws.onerror = end;
    ws.onopen = () => { ws.send(JSON.stringify({ id: 1, method: "Debugger.enable" })); ws.send(JSON.stringify({ id: 2, method: "Debugger.pause" })); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.method === "Debugger.scriptParsed") { urls.set(String(m.params.scriptId), String(m.params.url || "")); return; }
      if (m.method !== "Debugger.paused") return;
      frames = (m.params.callFrames || []).slice(0, 8).map((/** @type {any} */ f) => `${f.functionName || "(anonymous)"} (${(urls.get(String(f.location && f.location.scriptId)) || f.url || "?").replace(/^file:\/\//, "")}:${(f.location && f.location.lineNumber || 0) + 1})`);
      end();
    };
  });
}

/** The inspector address a node process printed on stderr, if this chunk holds it. @param {string} text */
export const inspectorUrl = (text) => (/Debugger listening on (ws:\/\/\S+)/.exec(text) || [])[1] || "";
