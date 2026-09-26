// @ts-check
// Test support for Recall: an embedder that needs no model, so tests never download weights and
// pass whether or not the optional package is installed. Not used outside tests.

/** A fake embedder: words hashed into 384 buckets, unit length. Shared words mean similarity. */
export function fakeEmbedder({ fail = false } = {}) {
  let calls = 0;
  return {
    model: "fake", get calls() { return calls; },
    async embed(text) {
      calls++;
      if (fail) throw new Error("the model fell over");
      const v = new Float32Array(384);
      for (const w of String(text).toLowerCase().match(/[a-z0-9]+/g) || []) {
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
