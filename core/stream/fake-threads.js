// @ts-check
// A stand-in for the switchboard's threads.get, for tests of modules that ask it as the caller (not a test itself).
// fakeThreads(dir) writes a module into dir; discover([dir]) finds it. Thread ids that start with thr_ exist;
// `locked_*` ids exist but are refused to any caller whose label contains "bob" (a person who may not read them);
// the manifest says reach anyone like the real threads.get, so an assistant reaches it and the caller pattern decides. globalThis.__fakeThreadsKnown (a Map: id to { cwd, deny? }) names more threads, with a folder and a caller pattern refused. Every call is noted in globalThis.__fakeThreadsCalls.
import fs from "node:fs";
import path from "node:path";

/** @param {string} dir */
export function fakeThreads(dir) {
  const d = path.join(dir, "threads");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "module.json"), JSON.stringify({ name: "threads", version: "0.0.0", roles: ["box", "local"], requires: [], does: { tools: [{ name: "threads.get", reach: "anyone" }] }, watches: { emits: [] }, shows: {}, needs: {}, teaches: { tips: [] }, settings: [] }));
  fs.writeFileSync(path.join(d, "index.js"), `
export default { async start(ctx) {
  ctx.tool("threads.get", {
    description: "fake", input: { type: "object", properties: { thread: { type: "string" }, limit: { type: "integer" } }, required: ["thread"] }, callers: ["cli", "local", "deck", "capsule", "mcp", "harness", "module"],
    run: async (i, meta) => {
      // only the term module's relayed call is admitted among modules (the others are refused before anything is recorded, as the real caller list does)
      if (/^module:/.test(String(meta.caller)) && meta.caller !== "module:term") throw Object.assign(new Error("denied"), { code: "denied" });
      (globalThis.__fakeThreadsCalls ||= []).push({ thread: i.thread, caller: meta.caller });
      const e = (code) => Object.assign(new Error(code), { code });
      const known = globalThis.__fakeThreadsKnown && globalThis.__fakeThreadsKnown.get(i.thread);
      if (known) { if (known.deny && new RegExp(known.deny).test(String(meta.caller) + JSON.stringify(meta.kernelFacts || {}))) throw e("denied"); return { thread: { id: i.thread, cwd: known.cwd }, events: [] }; }
      if (/^locked_/.test(i.thread)) { if (/bob/.test(String(meta.caller) + JSON.stringify(meta.kernelFacts || {}))) throw e("denied"); return { thread: { id: i.thread, cwd: "/tmp" }, events: [] }; }
      if (/^thr_/.test(i.thread)) return { thread: { id: i.thread, cwd: "/tmp" }, events: [] };
      throw e("not_found");
    },
  });
  return {};
} };
`);
}
