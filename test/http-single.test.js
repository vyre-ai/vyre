// @ts-check
// A request that leaves the machine goes through lib/http.js (consolidation inventory item 10): one address rule (lib/netguard.js), one deadline, one size cap, one redirect rule, one retry rule.
// This test fails when a source file calls `fetch(`, `globalThis.fetch` or `http(s).request/get` and is not in the list below with the reason it may. A file that only calls a `fetch` it was handed
// (a parameter that defaults to lib/http.js) is listed as such; a file that talks to this machine says so.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { findInSource } from "./source-files.js";

const BROWSER = "runs in a browser, a phone, an extension or a service worker, which cannot import lib/";
const WORKER = "a Cloudflare Worker: another runtime, and its `fetch` is the Worker entry point or a Durable Object stub";
const HARNESS = "test support or a live script, never shipped";
const LOCAL = "talks to something on this machine (a unix socket, loopback, a container's published port, the tailnet or LAN device it manages), not the internet";
const PARAM = "calls a `fetch` it was handed (a parameter or dependency) whose default is lib/http.js";

/** Where a raw request call may stay, and why. A new file calling `fetch(` or http(s).request needs a line here. */
const ALLOWED = new Map([
  // not the internet
  ["core/cli/screen/live.js", LOCAL], ["core/daemon/client.js", LOCAL], ["core/daemon/threadsock.js", LOCAL + " (vyred's own private socket for a lent computer's session)"], ["core/daemon/index.js", LOCAL], ["lib/vyre-core-client.js", LOCAL], ["core/cli/commands/vault.js", "a local function named fetch (the vault fetch the CLI waits on), not HTTP"],
  ["core/computers/", LOCAL], ["core/previews/index.js", LOCAL + " (an agent's server on a port of this box)"], ["core/previews/client/", BROWSER], ["core/dockerproxy/proxy.js", LOCAL], ["core/appmods/index.js", LOCAL], ["core/appmods/proxy.js", LOCAL], ["core/wink/control/", LOCAL], ["core/wink/node/shim.js", LOCAL],
  ["core/relay/bridge.js", LOCAL + " (the relay channel's own connection)"], ["core/daemon/app-sw.js", BROWSER], ["core/switchboard/index.js", "functions named fetch that read a credential, not HTTP"],
  ["kernel/storage/pool.js", "`fetch(id)` reads a blob from the pool, not HTTP"], ["core/names/directory.js", PARAM], ["lib/identity/directory.js", PARAM], ["lib/acme/acme.js", PARAM], ["lib/connectors/", PARAM],
  ["core/vault/health.js", PARAM], ["core/sessions/drivers/openrouter.js", PARAM + " (the pinned API client in lib/api-endpoint.js)"],
  ["core/runner/egress.js", "this IS the sandbox's egress proxy, which decides with lib/netguard.js"], ["core/runner/runner.js", LOCAL + " (a preview request to the dev server inside this computer's own sandbox: its unix socket or loopback)"], ["lib/http.js", "the one client"],
  ["core/resilience/node.js", "dials the person's own vyred (a unix socket, or the LAN, tailnet or relay address they paired), never a public service"],
  ["core/link/transport.js", "dials the paired box (a tailnet or LAN address the person set up) and pins its certificate itself"], ["core/glass/providers/computer.js", LOCAL + " (the computer helper)"],
  ["local/voice/ws.js", "the voice provider's WebSocket handshake needs the raw upgraded socket, which the client cannot give; it checks the address through lib/http.js pin() and dials the checked address"],
  ["core/cli/commands/phone.js", PARAM + " (userHostFetch: the person's own server)"],
  ["relay/node/resolve.js", "the relay container's one call to the operator's own names directory (VYRE_TUNNEL_DIRECTORY, set by whoever runs the edge, never by a request), 3 s deadline, a shared secret in a header; the container has no user-supplied address to guard"],
  ["lib/siteops/page.js", "the TEXT of a function that runs inside the signed-in page (a browser), which signs the call with the page's own cookies"],
  // inside a sandboxed child: the host side is the vault request engine
  ["core/watchers/presets.js", "runs inside the sandboxed watcher child, which has no network (its uid is refused by the host firewall): `fetch` there is a message to the parent, and the parent's answer is lib/sandbox/fetch.js on the shared lib/http.js transport"],
  ["core/watchers/connector-preset.js", "runs inside the sandboxed watcher child (see presets.js)"], ["core/watchers/runner.js", "the watcher child's fetch, which asks the host"],
  // the credentialed engine keeps its own pinned transport
  ["core/vault/forward-file.js", "streams a file through the credentialed engine's own pinned request (api-request.js pinnedOptions), under its adversarial suite"],
  // the sealing process
  ["kernel/seal/androidattest.js", "inside the sealing process, which imports nothing from lib/ (one 500 ms call to Google's attestation status)"],
  // other runtimes
  ["apps/app/", BROWSER], ["web/", BROWSER], ["relay/app/", BROWSER], ["relay/client/", BROWSER + " (the device client; the Windows capsule ships it alone)"], ["modules/vault-extension/", BROWSER],
  ["local/hands-chrome-mac/", BROWSER + " (the extension) or " + HARNESS], ["core/resilience/web.js", BROWSER], ["core/appmods/browser-probe.cjs", BROWSER + " (a probe page)"],
  ["names/worker/", WORKER], ["relay/worker/", WORKER], ["packages/module-sdk/", "the module SDK and its test harness stay free of repo imports"],
  // test support
  [".github/scripts/", HARNESS], ["core/artifacts/testing/", HARNESS], ["core/runner/testing/", HARNESS], ["core/switchboard/testing/", HARNESS], ["stores/twenty/live/", HARNESS], ["stores/twenty/testing/", HARNESS],
]);
const PATTERNS = [/(?<![\w.$])fetch\(|globalThis\.fetch(?!\.bind)|\bhttps?\.(request|get)\(|\b(?:lib|mod)\.request\(|new WebSocket\(/];

test("no other source file makes a raw request of its own", () => {
  assert.deepEqual(findInSource(PATTERNS, ALLOWED), [], "call httpFetch (public hosts) or userHostFetch (an address the person gave) from lib/http.js, or add the file to ALLOWED with the reason");
});

test("every allowed entry still matches something", () => {
  const hits = findInSource(PATTERNS, new Map()).map(h => h.split(":")[0]);
  const stale = [...ALLOWED.keys()].filter(k => !hits.some(f => (k.endsWith("/") ? f.startsWith(k) : f === k)));
  assert.deepEqual(stale, [], "an entry that matches no call any more: remove it");
});
