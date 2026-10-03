import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { conformance, SUITE_TYPES } from "./conformance-suite.js";
import { MemoryStore } from "./memory-store.js";

const harness = {
  async make() {
    const store = new MemoryStore();
    await store.define({ types: SUITE_TYPES });
    return { store, behind: (t, id, p) => store._behind(t, id, p), touch: (t, id) => store._touch(t, id), cleanup: async () => {} };
  },
  async empty(types) { const store = new MemoryStore(); await store.define({ types }); return { store, cleanup: async () => {} }; },
};
conformance("memory store", { test, before, after }, { assert }, harness);
