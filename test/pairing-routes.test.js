// @ts-check
// Every manifest tool whose name is a pair, adopt, enrol or install is classified.
// A pairing path names the file that calls the shared check. A different act names why it is not that path.
// A new tool that matches the scan and is in neither list fails this test.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN = /pair|adopt|enrol|enroll|setup-offer|install|phone\.|confirm-key/i;

/** Tools that adopt a server or enrol a device. The file must contain the shared symbol. @type {Record<string, [string, string]>} */
const ROUTES = {
  "spaces.pair.install": ["core/spaces/pair-install.js", "wink.install.issue"],
  "spaces.identity.confirm-key": ["core/spaces/owner-adopt.js", "assertPublishedKey"],
  "spaces.owner.adopt": ["core/spaces/owner-adopt.js", "assertPublishedKey"],
  "spaces.identity.enrol": ["core/spaces/index.js", "assertPublishedKey"],
  "wink.install.issue": ["core/wink/install-pair.js", "spaces.identity.sign"],
  "wink.install.complete": ["core/wink/install-pair.js", "spaces.identity.confirm-key"],
  "wink.install.status": ["core/wink/install-pair.js", "install_client"],
  "wink.server.install-redeem": ["core/wink/install-pair.js", "redeemInstallCode"],
  "wink.server.setup-offer": ["core/wink/pairing.js", "confirmPublished"],
  "wink.server.adopt": ["core/wink/pairing.js", "proveIdentity"],
  "wink.server.pair.answer": ["core/wink/pairing.js", "proveIdentity"],
  "wink.server.pairing": ["core/wink/pairing.js", "proveIdentity"],
  "wink.pair.server": ["core/wink/pairing.js", "wink.server.adopt"],
  "wink.pair.status": ["core/wink/pairing.js", "proveIdentity"],
  "wink.pair.targets": ["core/wink/pairing.js", "proveIdentity"],
  "wink.phone.open": ["core/wink/pairing.js", "acceptPhone"],
  "wink.phone.scan": ["core/wink/pairing.js", "acceptPhone"],
  "wink.phone.pairing": ["core/wink/pairing.js", "acceptPhone"],
  "wink.phone.pair.answer": ["core/wink/pairing.js", "acceptPhone"],
  "wink.phone.wait": ["core/wink/pairing.js", "acceptPhone"],
  "wink.phone.enrolled": ["core/wink/pairing.js", "confirmPublished"],
  "wink.server.paired": ["core/wink/pairing.js", "proveIdentity"],
  "wink.device.paired": ["core/wink/pairing.js", "proveIdentity"],
};

/** Same scan, a different act. A new tool stays red until it is routed or listed here with a reason. */
const EXCLUDE = {
  "spaces.devices.enrol": "which spaces a paired device may enter, after the identity proof",
  "spaces.devices.restore": "which spaces a paired device may enter, after the identity proof",
  "spaces.devices.set": "which spaces a paired device may enter, after the identity proof",
  "spaces.devices.enrolled": "a read of that space list",
  "spaces.server.install": "the space-creation code exchange; the adopting line is spaces.pair.install",
  "spaces.bundle.enrol": "a space bundle on this device, not an identity enrol",
  "onboard.pair": "a read of whether pairing is done; the adopt is wink.server.adopt",
  "wink.storage.pair": "a storage offer, not an owner adopt",
  "link.pair": "a Tailscale box link; it does not adopt a space owner",
  "link.pair.approve": "a Tailscale box link; it does not adopt a space owner",
  "link.pair.deny": "a Tailscale box link; it does not adopt a space owner",
  "link.pair.poll": "a Tailscale box link; it does not adopt a space owner",
  "link.pair.request": "a Tailscale box link; it does not adopt a space owner",
  "link.unpair": "a Tailscale box link; it does not adopt a space owner",
  "link.companion.pair": "a companion link; it does not adopt a space owner",
  "relay.pair.start": "the relay ticket transport under wink.server.adopt",
  "relay.pair.first": "the relay ticket transport under wink.server.adopt",
  "relay.pair.ticket": "the relay ticket transport under wink.server.adopt",
  "relay.pair.pending.confirm": "the relay ticket transport under wink.server.adopt",
  "relay.pair.window.open": "the relay ticket transport under wink.server.adopt",
  "relay.pair.window.renew": "the relay ticket transport under wink.server.adopt",
  "relay.pair.window.ping": "the relay ticket transport under wink.server.adopt",
  "relay.pair.window.close": "the relay ticket transport under wink.server.adopt",
  "relay.pair.window.confirm": "the relay ticket transport under wink.server.adopt",
  "relay.pair.window.reject": "the relay ticket transport under wink.server.adopt",
  "presence.enroll": "a presence key on an already paired device",
  "presence.person.pair-grant": "a presence grant for a paired session",
  "presence.person.pair-challenge": "a presence grant for a paired session",
  "presence.person.start-paired": "a presence grant for a paired session",
  "presence.person.end-paired": "a presence grant for a paired session",
  "memory.identity.enroll": "a memory identity, not a device enrol",
  "projects.adopt": "adopting a project record, not a server",
  "vault.autobackup.enrol": "a vault backup enrolment",
  "vault.account.enroll-touchid": "a vault account unlock",
  "appmods.install": "installing an app module",
  "appmods.publish.install": "installing an app module",
  "bridges.kit.install": "installing a kit",
  "chrome.install": "installing a browser extension",
  "learn.skill-install": "installing a skill",
  "work.template.install": "installing a work template",
  "work.template.install-in-space": "installing a work template",
};

/** Entry points that are not tools. Each file must contain the shared symbol. */
const ENTRIES = [
  ["core/relay/index.js", "wink.server.install-redeem"],
  ["core/relay/boot-pair.js", "o.redeem"],
  ["core/wink/setup-http.js", "o.redeem"],
  ["core/daemon/index.js", "spaces.identity.confirm-key"],
  ["core/wink/identity-ports.js", "spaces.identity.confirm-key"],
  ["scripts/install/i.sh", "VYRE_CODE"],
  ["scripts/install-box.sh", "VYRE_CODE"],
  ["scripts/install-mac-server.sh", "unset VYRE_CODE"],
  ["scripts/install-windows.ps1", "spaces.identity.confirm-key"],
  ["relay/client/pair-install.js", "export function installCommand"],
  ["lib/pair-code.js", "codedInstallLine"],
  ["apps/app/screens/install/first-run.js", "installCommand"],
];

function toolNames() {
  /** @type {Set<string>} */ const names = new Set();
  const walk = (/** @type {string} */ dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "module.json") {
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        const grab = (/** @type {any} */ t) => {
          const name = typeof t === "string" ? t : t && t.name;
          if (typeof name === "string" && SCAN.test(name)) names.add(name);
        };
        for (const t of (j.does && j.does.tools) || []) grab(t);
        for (const t of j.tools || []) grab(t);
      }
    }
  };
  for (const root of ["core", "local", "modules"]) walk(path.join(ROOT, root));
  return names;
}

test("every pair, adopt, enrol and install tool is routed or explicitly a different act", () => {
  const found = toolNames();
  for (const name of ["spaces.devices.restore", "spaces.devices.set"]) found.add(name);
  const known = new Set([...Object.keys(ROUTES), ...Object.keys(EXCLUDE)]);
  const missing = [...found].filter((n) => !known.has(n)).sort();
  assert.deepEqual(missing, [], `classify these tools: ${missing.join(", ")}`);
  const stale = [...known].filter((n) => !found.has(n)).sort();
  assert.deepEqual(stale, [], `these classifications match no manifest tool: ${stale.join(", ")}`);
  for (const [name, [file, symbol]] of Object.entries(ROUTES)) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.ok(src.includes(symbol), `${name} in ${file} must contain ${symbol}`);
  }
  const pairing = fs.readFileSync(path.join(ROOT, "core/wink/pairing.js"), "utf8");
  const accept = pairing.slice(pairing.indexOf("const acceptPhone"), pairing.indexOf("ctx.tool(\"wink.phone.pair.answer\""));
  assert.match(accept, /confirmPublished/);
  const offer = pairing.slice(pairing.indexOf("ctx.tool(\"wink.server.setup-offer\""), pairing.indexOf("ctx.tool(\"wink.server.confirm\""));
  assert.match(offer, /confirmPublished/);
  const redeem = fs.readFileSync(path.join(ROOT, "core/wink/install-pair.js"), "utf8");
  const body = redeem.slice(redeem.indexOf("export async function redeemInstallCode"), redeem.indexOf("export function registerInstallPair"));
  assert.ok(body.indexOf("spaces.identity.confirm-key") < body.indexOf("meta.set(spent"), "the published key is checked before the nonce is spent");
  const status = redeem.slice(redeem.indexOf("ctx.tool(\"wink.install.status\""), redeem.indexOf("ctx.tool(\"wink.install.complete\""));
  assert.equal(status.includes("spaces.owner.adopt"), false);
  assert.equal(status.includes("spaces.identity.confirm-key"), false);
  for (const [file, symbol] of ENTRIES) assert.ok(fs.readFileSync(path.join(ROOT, file), "utf8").includes(symbol), `${file} must contain ${symbol}`);
  const mac = fs.readFileSync(path.join(ROOT, "scripts/install-mac-server.sh"), "utf8");
  assert.match(mac, /--code\|--code=\*\) die/);
  const win = fs.readFileSync(path.join(ROOT, "scripts/install-windows.ps1"), "utf8");
  assert.match(win, /\$env:VYRE_CODE/);
  assert.equal(win.includes("ArgumentList $code"), false);
});
