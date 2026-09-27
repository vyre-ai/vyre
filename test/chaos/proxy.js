// @ts-check
// A fault proxy for the chaos tests (docs/adr/0029-resilience.md, R8). It listens on a loopback
// TCP port and forwards each connection to vyred's socket, and the test tells it what to break:
//   drop()          end every connection now, as a Wi-Fi to cellular switch does;
//   partition(on)   keep connections open but pass no bytes, as a dead Tailscale path does;
//   refuse(on)      turn new connections away, as an unreachable path does;
//   delay(ms)       hold each chunk, as a slow relay does;
//   cutAfter(n)     end a connection after n bytes towards the client, mid-event if it lands so.
// Two proxies on one vyred are two paths to the box.

import net from "node:net";

/** @param {string} socketPath vyred's socket @returns {Promise<Proxy>} */
export async function proxy(socketPath) {
  const live = new Set();
  const state = { partition: false, refuse: false, delay: 0, cut: 0, accepted: 0 };
  const server = net.createServer(client => {
    state.accepted++;
    if (state.refuse) { client.destroy(); return; }
    const up = net.connect(socketPath);
    const pair = { client, up };
    live.add(pair);
    const end = () => { client.destroy(); up.destroy(); live.delete(pair); };
    client.on("error", end); up.on("error", end); client.on("close", end); up.on("close", end);
    let down = 0;
    const pipe = (from, to, toClient) => from.on("data", chunk => {
      if (state.partition) return;
      const go = () => {
        if (to.destroyed) return;
        if (toClient && state.cut) {
          const room = state.cut - down;
          if (chunk.length >= room) { to.write(chunk.subarray(0, Math.max(0, room))); return end(); }
          down += chunk.length;
        }
        to.write(chunk);
      };
      state.delay ? setTimeout(go, state.delay) : go();
    });
    pipe(client, up, false);
    pipe(up, client, true);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {net.AddressInfo} */ (server.address()).port;
  return {
    url: `http://127.0.0.1:${port}`,
    get accepted() { return state.accepted; },
    get open() { return live.size; },
    drop() { for (const p of [...live]) { p.client.destroy(); p.up.destroy(); } live.clear(); },
    partition(on = true) { state.partition = on; },
    refuse(on = true) { state.refuse = on; },
    delay(ms) { state.delay = ms; },
    cutAfter(n) { state.cut = n; },
    heal() { Object.assign(state, { partition: false, refuse: false, delay: 0, cut: 0 }); },
    async close() { this.drop(); await new Promise(r => server.close(() => r(undefined))); },
  };
}

/**
 * @typedef {{ url: string, accepted: number, open: number, drop(): void, partition(on?: boolean): void, refuse(on?: boolean): void,
 *   delay(ms: number): void, cutAfter(n: number): void, heal(): void, close(): Promise<void> }} Proxy
 */
