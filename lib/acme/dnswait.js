// @ts-check
// waitTxt: the DNS-01 wait between writing a challenge record and telling the CA to look. The CA asks the zone's own servers, which take a few seconds to carry a new record,
// so the record is read back from public resolvers (Cloudflare and Google by default) until every one of them answers with the value, then a short settle covers the CA's own
// path. It never fails the issue: at the deadline it returns and the CA decides, so a slow resolver costs one retry, not a stuck gate.
import { Resolver } from "node:dns/promises";

/**
 * @param {string} fqdn the challenge name, _acme-challenge.<host>
 * @param {string} value the TXT value the CA will look for
 * @param {{ servers?: string[], timeoutMs?: number, everyMs?: number, settleMs?: number, resolve?: (server: string, fqdn: string) => Promise<string[][]>, sleep?: (ms: number) => Promise<void>, now?: () => number }} [o]
 * @returns {Promise<boolean>} true when every resolver showed the value before the deadline
 */
export async function waitTxt(fqdn, value, o = {}) {
  const servers = o.servers || ["1.1.1.1", "8.8.8.8"];
  const timeoutMs = o.timeoutMs ?? 120_000, everyMs = o.everyMs ?? 3000, settleMs = o.settleMs ?? 5000;
  const sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const now = o.now || Date.now;
  const resolve = o.resolve || (async (server, name) => { const r = new Resolver({ timeout: 3000, tries: 1 }); r.setServers([server]); return r.resolveTxt(name); });
  const sees = async (/** @type {string} */ server) => { try { return (await resolve(server, fqdn)).some(chunks => chunks.join("") === value); } catch { return false; } };
  const end = now() + timeoutMs;
  while (now() < end) {
    if ((await Promise.all(servers.map(sees))).every(Boolean)) { await sleep(settleMs); return true; }
    await sleep(everyMs);
  }
  return false;
}
