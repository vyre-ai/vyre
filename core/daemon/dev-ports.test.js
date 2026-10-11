// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { tempHome } from "../../test/helpers.js";
import { devAllowedPorts } from "./dev-ports.js";

test("a development build lets the named ports pass the confinement check; junk names none; a packaged build ignores it", t => {
  assert.deepEqual(devAllowedPorts({ VYRE_DEV_ALLOW_LISTEN: "35491,4000" }, undefined), [35491, 4000]);
  for (const bad of ["", "abc", "1;2", "70000", "35491, 4000", "-1"]) assert.deepEqual(devAllowedPorts({ VYRE_DEV_ALLOW_LISTEN: bad }, undefined), [], JSON.stringify(bad));
  assert.deepEqual(devAllowedPorts({}, undefined), []);
  const pkg = tempHome(t);   // a folder with no development build marker is a packaged one
  assert.deepEqual(devAllowedPorts({ VYRE_DEV_ALLOW_LISTEN: "35491" }, pkg), [], "packaged: ignored");
});
