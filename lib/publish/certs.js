// @ts-check
// The Space edge's certificate (PT-1): made on the BOX by DNS-01 and handed to Caddy as two files; Caddy itself runs no ACME in tunnel mode. The relay that fronts the edge passes TLS
// through and so must never be able to get a certificate for the Space's names: with HTTP-01 or TLS-ALPN-01 it could answer the challenge itself. DNS-01 needs a DNS record the relay cannot write.
// The Space signs each request with its own key (the directory's `acme`, `acme-clear` and `caa` acts, lib/identity/directory.js) and the directory writes the TXT. Before the first order the ACME
// account's URI is pinned in a CAA record (issue and issuewild name that one account), so no other account can be issued a certificate for the name either.
// A lib imports no feature (boundaries): the ACME client and the certificate store (core/names/acme.js, core/names/certs.js) are handed in as `deps` by the module that wires this.
import fs from "node:fs";
import path from "node:path";
import { fail } from "./util.js";

/**
 * The names one certificate covers: the Space's name and one label under it.
 * @param {string} name @returns {string[]}
 */
export const certNames = name => [name, `*.${name}`];

/**
 * Make or renew the Space's certificate, once a day is plenty (a certificate is renewed 30 days before it ends).
 * @param {{ name: string, certsDir: string, signer: any, client: { acme(name: string, token: string, signer: any): Promise<any>, acmeClear(name: string, signer: any): Promise<any>, caa(name: string, uri: string, signer: any): Promise<any> },
 *   deps: { store: { load(dir: string, name: string): any, save(dir: string, name: string, v: any): void, accountKey(dir: string, which: "production" | "staging"): string }, issue: (o: any) => Promise<any>, needsRenewal: (pem: string, now?: number) => boolean, directories: { production: string, staging: string } },
 *   directory?: string, now?: () => number, log?: (m: string) => void, email?: string, fetch?: typeof fetch, waitDns?: (fqdn: string, value: string) => Promise<any> }} o
 * @returns {Promise<{ renewed: boolean, expires: number, accountUri?: string }>}
 */
export async function ensureSpaceCert({ name, certsDir, signer, client, deps, directory = deps.directories.production, now = Date.now, log = () => {}, email, fetch, waitDns }) {
  const { store, issue, needsRenewal } = deps;
  if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(name)) fail("bad_input", "bad space name");
  fs.mkdirSync(certsDir, { recursive: true, mode: 0o700 });
  const which = directory === deps.directories.production ? "production" : "staging";
  const forFile = path.join(certsDir, "edge.for");
  const have = store.load(certsDir, "edge");
  let sameName = false; try { sameName = fs.readFileSync(forFile, "utf8").trim() === name; } catch { /* none yet */ }
  if (have && sameName && !needsRenewal(have.cert, now())) return { renewed: false, expires: have.expires };
  /** @type {string | undefined} */ let accountUri;
  const dns = {
    // Only the challenge label of the Space's own name is ever written: whatever the CA asks, the identifiers are ours (certNames), and this refuses any other label.
    async set(/** @type {string} */ fqdn, /** @type {string} */ value) {
      if (fqdn !== `_acme-challenge.${name}`) throw new Error(`refused: a challenge for ${fqdn} is not for this space`);
      await client.acme(name, value, signer);
      return value;
    },
    async clear() { await client.acmeClear(name, signer); },
  };
  const got = await issue({ names: certNames(name), directory, accountKey: store.accountKey(certsDir, which), ...(email ? { email } : {}), dns, log, ...(fetch ? { fetch } : {}), ...(waitDns ? { waitDns } : {}),
    onAccount: async (uri) => { accountUri = uri; await client.caa(name, uri, signer); } });
  store.save(certsDir, "edge", { cert: got.cert, key: got.key });
  fs.writeFileSync(forFile, name + "\n", { mode: 0o600 });
  return { renewed: true, expires: got.expires, accountUri: accountUri || got.accountUri };
}
