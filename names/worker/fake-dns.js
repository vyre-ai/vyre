// @ts-check
// fake-dns: a fake Cloudflare DNS API for the directory's tests, as a fetch function. It checks the
// bearer token and the zone id, filters a list by exact name and type as Cloudflare does, refuses a
// duplicate record with Cloudflare's own error (81058), and can be told to fail. No network.

/** @param {{ zoneId?: string, token?: string, api?: string }} [o] */
export function fakeDns({ zoneId = "zone123", token = "cf-secret-token", api = "https://cf.test/client/v4" } = {}) {
  /** @type {Array<{ id: string, type: string, name: string, content: string, ttl: number, proxied?: boolean }>} */
  const records = [];
  /** @type {Array<{ method: string, path: string, body: any }>} */
  const calls = [];
  let seq = 0;
  const state = { failNext: 0 };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const ok = result => json(200, { success: true, errors: [], result });

  /** @type {typeof fetch} */
  const fetchFn = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = String(init.method || "GET");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname.replace("/client/v4", "");
    calls.push({ method, path: path + url.search, body });
    if (!String(input).startsWith(api)) throw new Error("fake-dns: unexpected host " + input);
    const auth = /** @type {any} */ (init.headers || {}).authorization;
    if (auth !== `Bearer ${token}`) return json(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
    if (state.failNext > 0) { state.failNext--; return json(500, { success: false, errors: [{ code: 1000, message: "boom" }] }); }
    const m = path.match(/^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/);
    if (!m || m[1] !== zoneId) return json(404, { success: false, errors: [{ code: 7003, message: "no route" }] });
    const id = m[2];
    if (method === "GET" && !id) {
      const name = url.searchParams.get("name"), type = url.searchParams.get("type");
      return ok(records.filter(r => (!name || r.name === name) && (!type || r.type === type)).map(r => ({ ...r })));
    }
    if (method === "POST" && !id) {
      if (records.some(r => r.type === body.type && r.name === body.name && r.content === body.content)) return json(400, { success: false, errors: [{ code: 81058, message: "An identical record already exists." }] });
      const rec = { id: "rec" + ++seq, ...body };
      records.push(rec);
      return ok({ ...rec });
    }
    const at = records.findIndex(r => r.id === id);
    if (at < 0) return json(404, { success: false, errors: [{ code: 81044, message: "Record does not exist." }] });
    if (method === "PUT") { records[at] = { id: /** @type {string} */ (id), ...body }; return ok({ ...records[at] }); }
    if (method === "DELETE") { records.splice(at, 1); return ok({ id }); }
    return json(405, { success: false, errors: [] });
  };
  return { fetch: fetchFn, records, calls, state, api, zoneId, token,
    /** Records of one name and type, as the outside world would see them. */
    at: (name, type) => records.filter(r => r.name === name && (!type || r.type === type)) };
}
