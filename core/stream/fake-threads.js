// @ts-check
// A stand-in for the switchboard's threads.get, for tests of modules that ask it as the caller (not a test itself).
// fakeThreads(dir) writes a module into dir; discover([dir]) finds it. Thread ids that start with thr_ exist;
// `locked_*` ids exist but are refused to any caller whose label contains "bob" (a person who may not read them);
// an agent caller is refused as the real guard does. Every call is noted in globalThis.__fakeThreadsCalls.
import fs from "node:fs";
import path from "node:path";

/** @param {string} dir */
export function fakeThreads(dir) {
  const d = path.join(dir, "threads");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "module.json"), JSON.stringify({ name: "threads", version: "0.0.0", roles: ["box", "local"], requires: [], does: { tools: [{ name: "threads.get", reach: "person" }] }, watches: { emits: [] }, shows: {}, needs: {}, teaches: { tips: [] }, settings: [] }));
  fs.writeFileSync(path.join(d, "index.js"), `
export default { async start(ctx) {
  ctx.tool("threads.get", {
    description: "fake", input: { type: "object", properties: { thread: { type: "string" }, limit: { type: "integer" } }, required: ["thread"] }, callers: ["cli", "local", "deck", "capsule", "tailnet", "mcp", "harness"],
    run: async (i, meta) => {
      (globalThis.__fakeThreadsCalls ||= []).push({ thread: i.thread, caller: meta.caller });
      const e = (code) => Object.assign(new Error(code), { code });
      if (/^locked_/.test(i.thread)) { if (/bob/.test(String(meta.caller))) throw e("denied"); return { thread: { id: i.thread, cwd: "/tmp" }, events: [] }; }
      if (/^thr_/.test(i.thread)) return { thread: { id: i.thread, cwd: "/tmp" }, events: [] };
      throw e("not_found");
    },
  });
  return {};
} };
`);
}
