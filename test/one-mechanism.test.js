// @ts-check
// R031-00c: "grep finds one of each". Four jobs, one mechanism each: the role list, the secret detector, the grant model, the approval path. All four hold today; each names its few
// exceptions with a reason, and a list may only shrink.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["core", "lib", "kernel", "records", "harness", "apps/app/screens", "apps/app/src"];

/** Source files (js, mjs, ts, tsx), no tests, fixtures or type files. @param {string[]} dirs */
function sources(dirs = DIRS) {
  /** @type {string[]} */ const out = [];
  const walk = (/** @type {string} */ d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "testing" && e.name !== "test" && e.name !== "fixtures") walk(p); }
      else if (/\.(js|mjs|ts|tsx)$/.test(e.name) && !/\.(test|d)\.(js|ts|tsx|mjs)$|^test-kit\.js$/.test(e.name)) out.push(p);
    }
  };
  for (const d of dirs) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  return out.map((f) => path.relative(ROOT, f));
}
/** The code lines of a file: comment-only lines dropped. @param {string} rel */
const code = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n").map((l, i) => ({ l, n: i + 1 })).filter(({ l }) => !/^\s*(\/\/|\*|\/\*)/.test(l));
/** @param {string[]} files @param {RegExp} re @param {Set<string>} allowed */
const find = (files, re, allowed) => files.filter((f) => !allowed.has(f)).flatMap((f) => code(f).filter(({ l }) => re.test(l)).map(({ n }) => `${f}:${n}`));

test("A. one role list: only the contracts, and four named special lists, spell out the role sequence (details in test/one-role-list.test.js)", () => {
  const allowed = new Set(["kernel/contracts/index.js", "core/wink/pairing.js", "lib/publish/flow.js", "core/vault/shared.js", "apps/app/screens/assistants/create-card-model.ts"]);
  assert.deepEqual(find(sources(), /["']owner["']\s*,\s*["']admin["']|["']admin["']\s*,\s*["']manager["']\s*,\s*["']member["']/, allowed), []);
});

test("B. one secret detector: a token shape or a private key header is spelled only in lib/credential-shapes.js (the app's redactor, the Chrome extension copy and the Swift capsule are named below)", () => {
  const allowed = new Set([
    "lib/credential-shapes.js",
    "apps/app/src/store-core/credential-shapes.js", // the app cannot bundle lib/: generated from the table by scripts/sync-copies.mjs
    "lib/siteops/redact.js",                   // generated into the Chrome extension by scripts/sync-copies.mjs; pinned by the same test
  ]);
  const shapes = /\bghp_|github_pat_|xox\[?[abprs]|\bsk_live|\bAKIA|\bsk-ant-|-----BEGIN [A-Z0-9 \[\]*]*PRIVATE KEY/;
  assert.deepEqual(find(sources(), shapes, allowed), [], "use lib/credential-shapes.js (classify, findRules, redact, hasPrivateKey, privateKeyBlock, anthropicKind), or add the file with the reason");
});

test("C. one grant model: who may act is a kernel grant; every other table with `grant` in its name is named below with why it is not a second model, and the list may only shrink", () => {
  // The kernel (kernel/grants) is the one place that answers "may this actor do this to that". Publish's deployment secrets, Wink's members, lent computers and storage devices, the Vault's agent
  // logins, Connections, passes and module releases are all grants in the kernel's shape, made by their owner through the kernel (the `mint` handle or the Vault's hooks). A table that keeps a grant of
  // its own must be named here with the reason, and deleted from this list when the table goes (the test fails if a listed table no longer exists).
  /** @type {Record<string, string>} */
  const NAMED = {
    "wink_grants": "legacy: kept for its migration; core/wink/grants.js moveLocalGrants carries the rows into kernel grants and empties it; a later release drops the table (BACKLOG)",
    "wink_storage_grants": "legacy, same as wink_grants",
    "vault_agent_grants": "legacy: read once into kernel grants (core/vault/agents.js carryOver), then idle",
    "vault_grants_v2": "legacy: the older module-release table, read once when the Vault converts it",
    "vault_grants": "vyre-core's own home of module release grants: the same grant shape and the same matchGrant as the kernel (ADR 0040: core does not trust vyred's kernel). One format, one check, two homes",
    "vault_grant_requests": "what an assistant asked for; carries no authority until a person approves, and then a grant is made",
    "presence_grants": "single-use tokens for the presence check (a hash, an expiry, used once): proof records, not who-may-act",
    "presence_pair_grants": "the challenge of a pairing in progress: a proof record, not who-may-act",
    "artifacts_grants": "tag grants: a # tag lends one thread a read of one artifact and ends with the thread; owner chat; moves onto kernel grants with the other tag grants (BACKLOG 0.3.4)",
    "files_mention_grants": "tag grants for one file in a shared folder, same as artifacts_grants (BACKLOG 0.3.4)",
    "previews_grants": "what a preview page may use for one person (camera, location and so on): a capability switch the person sets in the preview; owner chat; moves onto kernel grants with the tag grants (BACKLOG 0.3.4)",
  };
  const made = new Set();
  for (const f of sources(["core", "lib", "kernel", "records"])) for (const { l } of code(f)) { const m = l.match(/CREATE TABLE(?: IF NOT EXISTS)? ([a-z0-9_]*grant[a-z0-9_]*)/i); if (m) made.add(m[1]); }
  assert.deepEqual([...made].filter((t) => !(t in NAMED)), [], "a table that keeps grants of its own: make the thing a kernel grant (kernel `mint` handle or the Vault's hooks), or name the table in NAMED with the reason");
  assert.deepEqual(Object.keys(NAMED).filter((t) => !made.has(t)), [], "listed here but no longer created anywhere: delete its line from NAMED");
  // The other way to keep a second model is an engine, not a table: lib/spaces/authz.js `createRoleAuthorize` answers "may this role do this" from a member's role. Three modules still ask it instead of the
  // kernel's authorize. They are named here, and the list may only shrink.
  /** @type {Record<string, string>} */
  const ROLE_ENGINE = {
    "core/spaces/index.js": "who is in a Space and what a role may do there: the roles table the kernel's own roles (kernel/contracts) mirror; moves onto kernel authorize with the 0.3.4 grant work (BACKLOG)",
    "core/bridges/index.js": "a bridge's two ends by role; the bridge's lifecycle is not a grant (DESIGN-one-grant section 10 F); the role check moves to kernel authorize (BACKLOG 0.3.4)",
    "core/publish/index.js": "who may create, approve and publish a deployment by role; a deployment's secrets are already kernel grants; the role checks move to kernel authorize (BACKLOG 0.3.4)",
  };
  const engineUsers = sources(["core"]).filter((f) => code(f).some(({ l }) => /\bcreateRoleAuthorize\s*\(/.test(l)));
  assert.deepEqual(engineUsers.filter((f) => !(f in ROLE_ENGINE)), [], "a new asker of createRoleAuthorize: ask the kernel's authorize instead, or name the file in ROLE_ENGINE with the reason");
  assert.deepEqual(Object.keys(ROLE_ENGINE).filter((f) => !engineUsers.includes(f)), [], "listed here but no longer asks the role engine: delete its line from ROLE_ENGINE");
  // Publish's old bookkeeping: a deployment's secret is a kernel grant, and its record carries no list
  assert.ok(fs.existsSync(path.join(ROOT, "lib/publish/grants.js")), "Publish keeps deployment secrets as kernel grants (lib/publish/grants.js)");
});

test("D. one approval path: what waits on the person is ONE list (approvals.items); the three owner lists are read only by their owners and the named readers below, and the list may only shrink", () => {
  // Each reader is here with why it reads an owner's list. A new reader of gate.held, vault.pending or threads.asks must use approvals.items (cards carry title, detail, source and the tool that answers),
  // or be added here with a reason. When session-transfer's #114 or a surface migration removes one, delete its line: the test fails if a listed file no longer reads a list.
  /** @type {Record<string, string>} */
  const READERS = {
    "core/approvals/items.js": "the one list: mirrors the three owners",
    "core/gate/gate.js": "owner: the Gate", "core/gate/index.js": "owner: the Gate",
    "core/vault/index.js": "owner: the vault (vault.pending)",
    "core/switchboard/index.js": "owner: threads.asks, and the held drafts of one thread for a rollover seed",
    "core/push/index.js": "maps the owners' own events to a push; reads no list",
    "core/link/allow.js": "the Mac link's allowlist of tool names", "core/link/mac.js": "relays a Mac's asks; session-transfer's #114",
    "core/cli/commands/gate.js": "detail screen: vyre gate show/approve (the draft in full)", "core/cli/commands/threads.js": "detail screen: vyre threads answer", "core/cli/commands/vault.js": "detail screen: vyre vault pending/approve",
    "core/statusline/index.js": "fallback only, for a vyred without waiting.count",
    "core/mail/index.js": "mail finds its own held sends",
    "apps/app/src/state/live.ts": "the app's Now list: moves onto approvals.items in work/approvals-app-031 (waits on B)", "apps/app/src/state/needs-model.ts": "same, and it names the gate.held and ask.* events",
    "apps/app/screens/vault/more-source.ts": "the vault screen's own pending list",
  };
  const re = /["'](?:gate\.held|vault\.pending|threads\.asks)["']/;
  const reads = sources(["core", "lib", "kernel", "apps/app/screens", "apps/app/src", "harness", "local/apps"]).filter((f) => code(f).some(({ l }) => re.test(l)));
  assert.deepEqual(reads.filter((f) => !(f in READERS)), [], "a new reader of an owner's waiting list: read approvals.items instead, or add the file to READERS with the reason");
  assert.deepEqual(Object.keys(READERS).filter((f) => !reads.includes(f)), [], "listed here but no longer reads an owner list: delete its line from READERS");
});
