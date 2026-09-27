// Writes VyreTests/Fixtures/canonical-vectors.json: inputs, and what core/presence's own
// canonical() and inputHash() make of them, so the Swift port is checked byte for byte.
//   node apps/ios/scripts/canonical-vectors.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, inputHash } from "../../../core/presence/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const inputs = [
  {},
  [],
  null,
  true,
  0,
  -0,
  "",
  { id: "a1b2c3d4e5f6a7b8c9", edited: { subject: "Re: Intake form rebuild" } },
  { b: 1, a: 2, c: { z: [3, 2, 1], y: null, x: false } },
  { ask: "0f1e2d3c4b5a697887", decision: "allow", surface: "ios" },
  { name: "harlow-gmail", field: "password" },
  { text: "line one\nline two\ttabbed \"quoted\" back\\slash \u0001\u001f\u007f" },
  { text: "Café, naïve, 日本語, emoji 🙂, é vs é" },
  { n: [1, -1, 1.5, 0.1, 0.000001, 0.0000001, 1e21, 1e20, 123456789012345680000, 5e-324, 1.7976931348623157e308, 2 ** 53, -2.5e-8, 100, 1e6] },
  { "Z": 1, "a": 2, "_": 3, "0": 4, "10": 5, "9": 6, "é": 7, "e": 8, "🙂": 9, "￿": 10 },
  { nested: [{ b: [{ d: 1, c: 2 }], a: {} }, [], [[]]] },
  { to: ["dana@harlowlegal.com"], body: "Hi Dana,\n\nThe new intake form is on staging.\n\nAlex" },
  { kind: "device", public_key: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE", alg: -7, name: "alex's iPhone" },
];
const vectors = inputs.map(input => ({ input, canonical: canonical(input), hash: inputHash(input) }));
const out = path.join(here, "..", "VyreTests", "Fixtures", "canonical-vectors.json");
fs.writeFileSync(out, JSON.stringify(vectors, null, 2) + "\n");
console.log(`wrote ${vectors.length} vectors to ${out}`);
