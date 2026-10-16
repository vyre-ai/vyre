// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentProfilePath, keyFromVault, readSealedProfile, writeSealedProfile } from "./browser-profile-store.js";

test("browser-profile-store: round-trip sealed file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vyre-prof-"));
  const key = keyFromVault("test-vault-material-for-profile-key");
  const file = agentProfilePath(root, "browser-shared", "agt_abc");
  const plain = Buffer.from("cookie-jar-bytes");
  await writeSealedProfile(key, file, plain);
  const back = await readSealedProfile(key, file);
  assert.deepEqual(back, plain);
  await fs.rm(root, { recursive: true, force: true });
});
