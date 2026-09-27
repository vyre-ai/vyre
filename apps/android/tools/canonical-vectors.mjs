// Regenerates app/src/test/resources/canonical-vectors.json from the box's own canonical() and
// inputHash(), so the JVM tests check the app byte for byte against core/presence/index.js.
//
//   node apps/android/tools/canonical-vectors.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { canonical, inputHash } from "../../../core/presence/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const inputs = [
  `{}`,
  `[]`,
  `{"b":1,"a":2}`,
  `{"id":"a1b2c3","edited":{"subject":"Q3 report, the short version","to":["dana@harlowlegal.com"]}}`,
  `{"z":{"y":{"x":[3,2,{"d":1,"c":[{"b":true,"a":null}]}]}},"a":false}`,
  `{"text":"line one\\nline two\\ttab \\"quoted\\" back\\\\slash"}`,
  `{"ctl":"\\u0000\\u0001\\u001f\\u007f\\b\\f\\r"}`,
  `{"uni":"caf\\u00e9 \\u2028 \\u2029 \\ud83d\\ude00 \\u00a0","slash":"a/b"}`,
  `{"lone":"\\ud800 and \\udfff"}`,
  `{"n":[0,-0,1,-1,1.5,0.1,1e21,1e20,123456789012345680000,1e-6,1e-7,2.5e-8,3.14159,100,1.0,2.50,-0.000001,5e-324,1.7976931348623157e308]}`,
  `{"B":1,"a":2,"_":3,"é":4,"Z":5,"aa":6,"a_":7,"10":8,"9":9}`,
  `{"ask":"4f1e2d3c4b5a697887","decision":"allow","surface":"android"}`,
  `{"thread":"5b0c6a1e-8d2f-4b7a-9c3e-1f2a3b4c5d6e","text":"run the tests","surface":"android"}`,
  `{"name":"harlow-gmail","field":"password"}`,
  `{"kind":"device","name":"Pixel 7","public_key":"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE","alg":-7}`,
  `{"deep":[[[[[]]]],{"":""}],"empty":""}`,
];
const vectors = inputs.map(text => {
  const v = JSON.parse(text);
  return { input: text, canonical: canonical(v), hash: inputHash(v) };
});
fs.writeFileSync(path.join(here, "..", "app", "src", "test", "resources", "canonical-vectors.json"), JSON.stringify(vectors, null, 2) + "\n");

// A device proof the way the box checks it (core/presence SIGNERS.device): a P-256 key, its id,
// and one signed message, so the JVM side checks the id, the message and the signature format.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const tool = "gate.approve", input = { id: "a1b2c3d4e5f6a7b8c9", edited: { subject: "Q3 report" } };
const ts = 1790000000000, nonce = "n0nce-Harlow_1234";
const msg = `vyre-presence-v1\n${tool}\n${inputHash(input)}\n${ts}\n${nonce}`;
const sig = crypto.sign("sha256", Buffer.from(msg), { key: privateKey, dsaEncoding: "der" }).toString("base64url");
const id = crypto.createHash("sha256").update(Buffer.from(spki, "base64url")).digest("base64url").slice(0, 22);
fs.writeFileSync(path.join(here, "..", "app", "src", "test", "resources", "device-vector.json"),
  JSON.stringify({ spki, id, tool, input: JSON.stringify(input), ts, nonce, message: msg, sig }, null, 2) + "\n");
console.log(`${vectors.length} vectors`);
