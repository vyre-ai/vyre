// @ts-check
// `vyre update` removes only this server's old record-store containers and volumes. Another server's stacks on the same Docker host stay.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { oldRecordStackNames, reportOldRecordStacks, spacesOnHome } from "../box/old-record-stacks.js";
import { tempHome } from "./helpers.js";

const MINE = "spc_aaaabbbbcccc";
const OTHER = "spc_ddddeeeeffff";

test("cleanup names only this server's old record-store containers and volumes", () => {
  const named = oldRecordStackNames({
    spaces: [MINE],
    containers: [
      "vyre-vyre-1",
      "vyre-spc-aaaabbbbcccc-twenty-server-1",
      "vyre-spc-aaaabbbbcccc-twenty-worker-1",
      "vyre-spc-aaaabbbbcccc-twenty-db-1",
      "vyre-spc-ddddeeeeffff-twenty-server-1",
      "vyre-app-documents-1",
      "vyre-spc-aaaabbbbcccc-gotenberg-1",
    ],
    volumes: [
      "vyre-spc-aaaabbbbcccc-twenty_db-data",
      "vyre-spc-aaaabbbbcccc-twenty_server-data",
      "vyre-spc-ddddeeeeffff-twenty_db-data",
      "vyre_vyre-home",
      "vyre-app-documents_data",
    ],
  });
  assert.deepEqual(named.containers, [
    "vyre-spc-aaaabbbbcccc-twenty-server-1",
    "vyre-spc-aaaabbbbcccc-twenty-worker-1",
    "vyre-spc-aaaabbbbcccc-twenty-db-1",
  ]);
  assert.deepEqual(named.volumes, [
    "vyre-spc-aaaabbbbcccc-twenty_db-data",
    "vyre-spc-aaaabbbbcccc-twenty_server-data",
  ]);
});

test("a Space id with underscores matches the hyphenated container name, and a name that is not a Space id is ignored", () => {
  const named = oldRecordStackNames({
    spaces: [OTHER, "not a space", "vyre-spc-aaaabbbbcccc"],
    containers: [`vyre-${OTHER.replace(/_/g, "-")}-twenty-server-1`, "vyre-spc-aaaabbbbcccc-twenty-server-1"],
    volumes: [],
  });
  assert.deepEqual(named.containers, [`vyre-${OTHER.replace(/_/g, "-")}-twenty-server-1`]);
});

test("the report read from the home names only that home's stacks", t => {
  const home = tempHome(t);
  fs.mkdirSync(path.join(home, "kernel", "spaces", MINE), { recursive: true });
  fs.writeFileSync(path.join(home, "kernel", "space.json"), JSON.stringify({ space: OTHER }));
  const stdin = [
    "container vyre-vyre-1",
    `container vyre-${MINE.replace(/_/g, "-")}-twenty-server-1`,
    `container vyre-${OTHER.replace(/_/g, "-")}-twenty-worker-1`,
    "volume vyre-spc-zzz-twenty_db-data",
    `volume vyre-${OTHER.replace(/_/g, "-")}-twenty_db-data`,
    "not a line",
  ].join("\n");
  assert.deepEqual(spacesOnHome(home).sort(), [MINE, OTHER].sort());
  assert.equal(reportOldRecordStacks(stdin, home), [
    `container vyre-${MINE.replace(/_/g, "-")}-twenty-server-1`,
    `container vyre-${OTHER.replace(/_/g, "-")}-twenty-worker-1`,
    `volume vyre-${OTHER.replace(/_/g, "-")}-twenty_db-data`,
    "",
  ].join("\n"));
});
