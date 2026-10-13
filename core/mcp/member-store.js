// @ts-check
// member-store: the MCP servers and sign-ins a team member brought themselves (owner decision 00:57Z, routes a and b).
//
// Per person, per Space, sealed (AES-256-GCM) under a key the caller derives from the MEMBER's device key, so the
// owner's vault, the owner's calls and the other members cannot open it. One small surface (put/get/list/remove keyed
// by identity id) so it can move into a member vault when one exists (wire-identity: not in rc.4).
// Files: <root>/<space-hash>/<identity-hash>.json, mode 0600, holding { iv, tag, data } for the whole set.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const bad = m => Object.assign(new Error(m), { code: "bad_input" });
const h = s => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 32);

/** The sealing key from a member's device key, bound to the Space. @param {Buffer} deviceKey @param {string} space */
export function keyFromDevice(deviceKey, space) {
  return Buffer.from(crypto.hkdfSync("sha256", deviceKey, Buffer.from("vyre-member-mcp"), Buffer.from(String(space)), 32));
}

/** @param {{ root: string, space: string, key: Buffer }} o */
export function memberStore({ root, space, key }) {
  const dir = path.join(root, h(space));
  const file = id => { if (!IDENT.test(String(id))) throw bad("identity id is not valid"); return path.join(dir, h(id) + ".json"); };
  const aad = id => Buffer.from(`${space}\n${id}`);
  const load = id => {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file(id), "utf8")); } catch (e) { if (/** @type {any} */ (e).code === "bad_input") throw e; return {}; }
    try {
      const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(raw.iv, "base64"));
      d.setAAD(aad(id)); d.setAuthTag(Buffer.from(raw.tag, "base64"));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(raw.data, "base64")), d.final()]).toString("utf8"));
    } catch { return {}; }   // another key or tampering: nothing, never a throw that tells which
  };
  const save = (id, set) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(aad(id));
    const data = Buffer.concat([c.update(JSON.stringify(set), "utf8"), c.final()]);
    const f = file(id), tmp = f + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") }), { mode: 0o600 });
    fs.renameSync(tmp, f);
  };
  return {
    /** @returns {{ name: string, [k: string]: any }[]} */
    list: id => Object.entries(load(id)).map(([name, v]) => ({ name, ...(/** @type {any} */ (v)) })),
    get: (id, name) => load(id)[name] ?? null,
    put(id, name, server) {
      if (!NAME.test(String(name))) throw bad("name must be letters, digits, dot, dash");
      if (name === "vyre") throw bad("vyre is reserved for Vyre's own tools");
      const set = load(id); set[name] = server; save(id, set);
    },
    remove(id, name) { const set = load(id); if (!(name in set)) return false; delete set[name]; save(id, set); return true; },
  };
}

/** A `--mcp-config` object for one member's own servers. @param {ReturnType<typeof memberStore>} store @param {string} id */
export function memberMcpConfig(store, id) {
  const mcpServers = {};
  for (const { name, ...def } of store.list(id)) mcpServers[name] = def;
  return { mcpServers };
}
export { mergeMcpServers } from "../../lib/merge-mcp.js";
