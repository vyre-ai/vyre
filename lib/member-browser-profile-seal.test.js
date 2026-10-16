// @ts-check
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../test/scratch.mjs";
import { TEST_KDF } from "../core/vault/testing.js";
import { PeopleVaults } from "../core/vault/people.js";
import { MEMBER_BROWSER_PROFILE_KEY } from "./browser-profile.js";
import { memberProfileAesKey, keyMaterialFromFields } from "./member-browser-profile-key.js";
import { memberProfilePath, readSealedProfile, writeSealedProfile } from "./browser-profile-store.js";
import { keyFromVault } from "./browser-profile-store.js";

const OWNER = "per_" + "o".repeat(26);
const MEMBER = "per_" + "m".repeat(26);
const PW = "long-enough-master-password";
const AGENT_SPACE_KEY = "space-agent-wrap-key-material-not-for-people";

test("member sealed profiles: only that person's vault key opens them", async t => {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-mprof-seal-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const people = new PeopleVaults({ dir: home, testKdf: TEST_KDF });
  t.after(() => people.close());
  const ownerSk = (await people.create(OWNER, { password: PW })).secretKey;
  const memberSk = (await people.create(MEMBER, { password: PW })).secretKey;
  await people.put(OWNER, { name: MEMBER_BROWSER_PROFILE_KEY, kind: "secret", fields: { key: "a".repeat(64) } });
  await people.put(MEMBER, { name: MEMBER_BROWSER_PROFILE_KEY, kind: "secret", fields: { key: "b".repeat(64) } });
  await people.unlock(OWNER, { password: PW, secretKey: ownerSk });
  await people.unlock(MEMBER, { password: PW, secretKey: memberSk });
  const ownerKey = memberProfileAesKey(keyMaterialFromFields((await people.get(OWNER, { name: MEMBER_BROWSER_PROFILE_KEY })).fields));
  const memberKey = memberProfileAesKey(keyMaterialFromFields((await people.get(MEMBER, { name: MEMBER_BROWSER_PROFILE_KEY })).fields));
  const spaceKey = keyFromVault(AGENT_SPACE_KEY);
  const dataRoot = path.join(home, "data");
  const computerId = "browser-shared";
  const plain = Buffer.from(JSON.stringify({ v: 1, cookies: [{ name: "sid", value: "secret", domain: "x", path: "/" }] }));
  const ownerFile = memberProfilePath(dataRoot, computerId, OWNER);
  await writeSealedProfile(ownerKey, ownerFile, plain);
  assert.deepEqual(await readSealedProfile(ownerKey, ownerFile), plain);
  await assert.rejects(() => readSealedProfile(memberKey, ownerFile), /Unsupported state|unable to authenticate|bad decrypt/i);
  await assert.rejects(() => readSealedProfile(spaceKey, ownerFile), /Unsupported state|unable to authenticate|bad decrypt/i);
  const memberFile = memberProfilePath(dataRoot, computerId, MEMBER);
  await writeSealedProfile(memberKey, memberFile, plain);
  await assert.rejects(() => readSealedProfile(ownerKey, memberFile), /Unsupported state|unable to authenticate|bad decrypt/i);
});
