// @ts-check
// The relay's edge cost cap, as code (GHSA-25xh-w9j7-7v28). The app no longer limits /v1/pair and the setup mailbox
// globally (a shared cap let any outsider block everyone), so cost is capped here instead: one Cloudflare
// rate-limiting rule that counts requests PER ADDRESS to those two routes and blocks an address that goes over,
// never a shared budget. It is the zone's `http_ratelimit` entrypoint ruleset, upserted by its `ref`, leaving any other
// rule in it alone.
//
//   CLOUDFLARE_API_TOKEN=... CF_ZONE_ID=... node scripts/deploy/relay-edge-rule.mjs --apply | --dry-run
//
// The token needs Zone > Zone WAF > Edit on the zone (the API's "Zone Rulesets: Edit"). The Free plan allows one
// rate-limiting rule, a 10-second period and a block action, so the cap is 50 requests per 10 seconds per address
// (about 300 a minute). Prints the rule, never the token.

const REF = "vyre-relay-edge-cap";
const HOST = "relay.vyre.run";

/** @returns {Record<string, any>} the rule to upsert */
export function edgeRule() {
  return {
    ref: REF,
    description: "relay: cap /v1/pair and /v1/setup/mbx per address (cost control, no shared budget)",
    expression: `(http.host eq "${HOST}" and (starts_with(http.request.uri.path, "/v1/pair") or starts_with(http.request.uri.path, "/v1/setup/mbx")))`,
    action: "block",
    ratelimit: { characteristics: ["ip.src"], period: 10, requests_per_period: 50, mitigation_timeout: 10 },
    enabled: true,
  };
}

/**
 * The rules to PUT: ours replaces any earlier copy of itself by ref, and everything else is kept as it was.
 * @param {Array<Record<string, any>>} existing
 */
export function mergeRules(existing) {
  return [...existing.filter(r => r && r.ref !== REF).map(({ id, version, last_updated, categories, ...rest }) => rest), edgeRule()];
}

/**
 * @param {{ token: string, zone: string, dryRun?: boolean, fetch?: typeof fetch, api?: string }} o
 * @returns {Promise<{ rules: number, dryRun: boolean, refs: string[] }>}
 */
export async function upsert({ token, zone, dryRun = false, fetch: f = globalThis.fetch, api = "https://api.cloudflare.com/client/v4" }) {
  if (!token || !/^[0-9a-f]{32}$/.test(zone || "")) throw new Error("a token and the 32-character zone id are needed");
  const url = `${api}/zones/${zone}/rulesets/phases/http_ratelimit/entrypoint`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const read = await f(url, { headers });
  let existing = [];
  if (read.status === 200) {
    const rules = ((await read.json()).result || {}).rules;
    // A 200 with no rules array is a malformed answer, never "no rules": writing from it could replace the zone's other rules.
    if (!Array.isArray(rules)) throw new Error("Cloudflare's answer for the rate-limit rules had no rules list; refusing to write");
    existing = rules;
  }
  else if (read.status !== 404) throw new Error(describe(read.status, "reading the rate-limit rules"));
  const rules = mergeRules(existing);
  const refs = rules.map(r => String(r.ref || r.description || "(unnamed)"));
  if (dryRun) return { rules: rules.length, dryRun: true, refs };
  const put = await f(url, { method: "PUT", headers, body: JSON.stringify({ rules }) });
  if (!put.ok) throw new Error(describe(put.status, "writing the rate-limit rule"));
  return { rules: rules.length, dryRun: false, refs };
}

/** @param {number} status @param {string} what */
function describe(status, what) {
  if (status === 401 || status === 403) return `Cloudflare refused ${what} (HTTP ${status}): the token needs Zone > Zone WAF > Edit on the zone`;
  if (status === 400 || status === 409 || status === 422) return `Cloudflare answered HTTP ${status} while ${what}: on the Free plan a zone may have only one rate-limiting rule, and it may already have one that this script keeps`;
  return `Cloudflare answered HTTP ${status} while ${what}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes("--dry-run");
  // Writes only when asked to: the deploy workflow passes --apply when relay_edge_rule is true.
  if (!dryRun && !process.argv.includes("--apply")) { console.error("::error::pass --apply to write the rule, or --dry-run to see it"); process.exit(2); }
  upsert({ token: process.env.CLOUDFLARE_API_TOKEN || "", zone: process.env.CF_ZONE_ID || "", dryRun })
    .then(r => console.log(`${dryRun ? "would write" : "wrote"} ${r.rules} rate-limit rule(s) in the zone's http_ratelimit ruleset (${r.refs.join(", ")}); ours (${REF}) caps ${HOST} /v1/pair and /v1/setup/mbx at 50 per 10 s per address`))
    .catch(e => { console.error(`::error::${e.message}`); process.exit(1); });
}
