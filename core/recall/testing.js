// @ts-check
// Test support for Recall: an embedder that needs no model, so tests never download weights and
// pass whether or not the optional package is installed. Not used outside tests.

import fs from "node:fs";
import path from "node:path";
import { PACKAGE, DIM } from "./embed.js";

/**
 * A fake embedder: words hashed into 384 buckets, unit length. Shared words mean similarity.
 * `same` maps a word to another it should mean, which is how a test gives two texts with no word
 * in common the same meaning.
 * @param {{ fail?: boolean, same?: Record<string, string> }} [opts]
 */
export function fakeEmbedder({ fail = false, same = {} } = {}) {
  let calls = 0;
  return {
    model: "fake", get calls() { return calls; },
    async embed(text) {
      calls++;
      if (fail) throw new Error("the model fell over");
      const v = new Float32Array(384);
      for (const raw of String(text).toLowerCase().match(/[a-z0-9]+/g) || []) {
        const w = same[raw] || raw;
        let h = 0;
        for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        v[h % 384] += 1;
      }
      let n = 0;
      for (const x of v) n += x * x;
      n = Math.sqrt(n) || 1;
      return v.map(x => x / n);
    },
  };
}

/**
 * A fake npm in `dir`: records its arguments in <dir>/calls, then writes a library whose pipeline
 * returns a unit vector, plus ONNX Runtime binaries for this and another platform. With `fail` it
 * leaves a half-written tree and exits 1, as a dropped connection does.
 * @param {string} dir
 * @param {{ fail?: boolean }} [opts]
 */
export function fakeNpm(dir, { fail = false } = {}) {
  const lib = path.join("node_modules", ...PACKAGE.split("/"));
  const file = path.join(dir, "npm");
  fs.writeFileSync(file, `#!/bin/sh
echo "$@" >> "${path.join(dir, "calls")}"
${fail ? 'mkdir -p node_modules/half; echo "npm error network ETIMEDOUT" >&2; exit 1' : `
mkdir -p "${lib}"
echo '{"name":"${PACKAGE}","version":"4.3.0","main":"index.cjs"}' > "${lib}/package.json"
cat > "${lib}/index.cjs" <<'EOF'
exports.env = {};
exports.pipeline = async () => async () => { const d = new Float32Array(${DIM}); d[0] = 1; return { data: d }; };
EOF
here=node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}
mkdir -p node_modules/onnxruntime-node/bin/napi-v6/other-os/x64 "$here" node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/not-this-arch node_modules/onnxruntime-web/dist
touch "$here/libonnxruntime.so.1" "$here/libonnxruntime_providers_shared.so" "$here/libonnxruntime_providers_cuda.so" node_modules/onnxruntime-web/dist/ort.node.min.js node_modules/onnxruntime-web/dist/ort.node.min.js.map node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm`}
`);
  fs.chmodSync(file, 0o755);
  return file;
}
