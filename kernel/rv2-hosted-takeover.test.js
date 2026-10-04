// reviewer-2 repro HA-1 against origin/work/devbox 3176efeec (drop into kernel/): the module path (core/spaces adoptHosted) calls the HOSTED kernel's own adoptOwner(identity) for every hosted Space.
// A hosted kernel's adoptOwner replaces its single owner, whoever that is, so a Space hosted for another person is taken over. The kernel handle must refuse unless the Space's owner is the replaced home owner.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempHome } from "../test/helpers.js";
import { start } from "../core/daemon/index.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const A = "per_aaaaaaaaaaaaaaaaaaaaaaaaaa", OTHER = "per_cccccccccccccccccccccccccc";
const spacesNeed = { name: "spaces", needs: { kernel: { actions: [], spaces: true } } };

test("HA-1: adopting the claimed identity in a hosted kernel must not replace another person's owner", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const theirs = await d.kernel.spaces.host({ owner: OTHER, name: "theirs" });
  const hosted = d.kernel.spaces.hosted(theirs.space).kernel;
  const role = (p) => hosted.grants.roleOf({ kind: "person", id: p, space: theirs.space });
  assert.equal(role(OTHER), "owner");
  let how = "adopted"; try { await hosted.kernelFor(spacesNeed).adoptOwner(A); } catch (e) { how = "refused:" + (e.code || e.message); }
  console.log("HA-1", how, "| OTHER now:", role(OTHER), "| identity now:", role(A));
  assert.equal(role(OTHER), "owner", "someone else's Space lost its owner to the home's identity");
  assert.notEqual(role(A), "owner");
});
