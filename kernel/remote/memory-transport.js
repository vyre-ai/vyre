// kernel/remote/memory-transport.js: an in-memory stand-in for the Wink connection, for tests and for a home that hosts a Space for a device on the same machine.
// The device end `send`s; the home end hands the request to the server with the PEER it set for that connection. Everything crosses as JSON text, as on a wire.
/** @param {{ servers: Map<string, { serve(request: any, peer: any): Promise<any> }> | Record<string, any>, peer: { device_key_id: string, person: string, path?: string }, drop?: boolean }} cfg */
export function createMemoryTransport(cfg) {
  const get = (/** @type {string} */ s) => (cfg.servers instanceof Map ? cfg.servers.get(s) : cfg.servers[s]);
  return {
    sent: /** @type {any[]} */ ([]),
    async send(/** @type {string} */ space, /** @type {any} */ request) {
      this.sent.push(request);
      if (cfg.drop) throw new Error("link down");
      const server = get(space);
      if (!server) throw new Error("no route to that Space");
      return JSON.parse(JSON.stringify(await server.serve(JSON.parse(JSON.stringify(request)), { ...cfg.peer })));
    },
  };
}
