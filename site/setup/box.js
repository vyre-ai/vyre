// @ts-check
// box: the setup page's own connection to the server it is setting up, over the relay, as the "setup device"
// (tailnet plan 3.6b). The hello is signed with the page's non-extractable key over this connection's Noise key,
// so only the browser that made the code is admitted; what the channel may call is the box's allowlist, not
// owner powers. Nothing here is stored: the Noise key is made for this tab and dropped with it.

/**
 * @param {{ openChannel: Function, request: Function, setupHello: Function, webCrypto: Function, utf8: (s: string) => Uint8Array }} lib the relay client's own functions (page.js passes them in, tests too)
 * @param {{ relay?: string, offer: { relay: string, route: string, box: Uint8Array }, key: { privateKey: CryptoKey, spki: Uint8Array },
 *   secret: Uint8Array, WebSocket?: any, timeout?: number }} o
 * @returns {Promise<{ call: (tool: string, input?: object) => Promise<any>, events: (type: string, since?: number) => Promise<{ id: number, type: string, payload: any }[]>, follow: (type: string, onEvent: (e: any) => void, onEnd: (err: Error|null) => void) => () => void, close: () => void }>}
 */
export async function connectSetup(lib, o) {
  const crypto = lib.webCrypto();
  const keys = await crypto.generateKeyPair();
  const hello = await lib.setupHello({ ...o.key, route: o.offer.route, noiseStatic: keys.publicKey, secret: o.secret });
  const { channel } = await lib.openChannel({ crypto, WebSocket: o.WebSocket || globalThis.WebSocket, relay: o.offer.relay, route: o.offer.route, box: o.offer.box, keys, hello, timeout: o.timeout });
  return {
    /** One tool call; the answer's `data`, or an error carrying the box's own code and words. */
    async call(tool, input = {}) {
      const res = await lib.request(channel, { method: "POST", path: `/v1/tools/${encodeURIComponent(tool)}`, headers: { "content-type": "application/json" } }, lib.utf8(JSON.stringify(input)));
      let body = null;
      try { body = JSON.parse(await res.text()); } catch { /* not JSON */ }
      if (!res.ok) {
        const e = body && body.error;
        throw Object.assign(new Error(String((e && e.message) || `the box answered ${res.status}`).slice(0, 300)), { code: (e && e.code) || "failed", status: res.status });
      }
      return body ? body.data : null;
    },
    /** Events of one type after a cursor (the channel may follow only the setup list). Oldest first. */
    async events(type, since = 0) {
      const q = `type=${encodeURIComponent(type)}&since=${Math.max(0, Math.floor(Number(since) || 0))}&limit=50`;
      const res = await lib.request(channel, { method: "GET", path: `/v1/events?${q}` }, new Uint8Array(0));
      let body = null;
      try { body = JSON.parse(await res.text()); } catch { /* not JSON */ }
      if (!res.ok) throw Object.assign(new Error(String((body && body.error && body.error.message) || `the box answered ${res.status}`).slice(0, 300)), { status: res.status });
      return Array.isArray(body && body.data) ? body.data.map(e => ({ id: Number(e.id) || 0, type: String(e.type || ""), payload: e.payload })) : [];
    },
    /**
     * Follow one event type as it happens (the box's server-sent stream, from now). onEvent hears each event; onEnd hears the
     * stream end, with the error if it broke. Returns a function that stops it.
     */
    follow(type, onEvent, onEnd) {
      let stopped = false, res = null;
      (async () => {
        try {
          res = await lib.request(channel, { method: "GET", path: `/v1/events/stream?type=${encodeURIComponent(type)}&since=latest` }, new Uint8Array(0));
          if (!res.ok) throw Object.assign(new Error(`the box answered ${res.status}`), { status: res.status });
          const dec = new TextDecoder();
          let buf = "";
          for await (const chunk of res.body) {
            buf += dec.decode(chunk, { stream: true });
            let at;
            while ((at = buf.indexOf("\n\n")) !== -1) {
              const block = buf.slice(0, at); buf = buf.slice(at + 2);
              const data = block.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
              if (!data) continue;
              try { const e = JSON.parse(data); if (e && e.type === type && !stopped) onEvent(e); } catch { /* a line that is not an event */ }
            }
            if (buf.length > 65536) buf = "";
          }
          if (!stopped) onEnd(null);
        } catch (e) { if (!stopped) onEnd(/** @type {Error} */ (e)); }
      })();
      return () => { stopped = true; try { res && res.cancel(); } catch { /* gone */ } };
    },
    close() { try { channel.close(1000, "done"); } catch { /* already closed */ } },
  };
}
