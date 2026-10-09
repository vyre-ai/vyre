// @ts-check
// The Design MCP and the Module MCP, for people who set Vyre up with Claude Code, Codex or another agent (R031-62). One small stdio server, started with `vyre mcp design`, that is NOT in every
// session: it is added when the work is design or building a module, so its tools cost nothing the rest of the time. Inside Vyre only the Engineer designs; it calls the same functions.
//
// Design:  design_catalogue (the blocks, small), design_validate (a screen, with the fix for each problem), design_render (a picture of a screen, sample data where there is none),
//          design_propose (the screen goes to its owner for a yes, before and after), design_brand (the space's brand defaults, so a design is built in them)
// Module:  module_scaffold, module_check, module_test (the kit `vyre module new|check|test`, in a few lines), module_install (checks, then stages it for the owner: installing code is theirs)
//
// Answers are written for few tokens: a pass is a few words, a problem names its path and the fix, a picture comes back as one image and its path.
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { catalogue, validateScreen } from "../../lib/views/blocks.js";
import { renderScreen } from "../../lib/design/render.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VYRE_BIN = path.join(HERE, "..", "..", "bin", "vyre");
const PROTOCOL = "2025-06-18";

const obj = (/** @type {Record<string, any>} */ properties, /** @type {string[]} */ required = []) => ({ type: "object", properties, ...(required.length ? { required } : {}) });
const str = { type: "string" };

/** The tools, as short as they can be said. */
export const TOOLS = [
  { name: "design_catalogue", description: "The design language's blocks. level index (default), block+type, or layouts.", inputSchema: obj({ level: { type: "string", enum: ["index", "block", "layouts"] }, type: str }) },
  { name: "design_validate", description: "Check a screen; each problem names the path and the fix.", inputSchema: obj({ screen: { type: "object" } }, ["screen"]) },
  { name: "design_render", description: "A picture of a screen (sample data where a block has none).", inputSchema: obj({ screen: { type: "object" }, surface: { type: "string", enum: ["app", "phone", "chat"] }, theme: { type: "string", enum: ["dark", "paper"] } }, ["screen"]) },
  { name: "design_propose", description: "Send a screen to its owner for a yes, with why.", inputSchema: obj({ id: str, title: str, screen: { type: "object" }, why: str }, ["id", "screen", "why"]) },
  { name: "design_brand", description: "The space's brand defaults: names, colour, fonts, letterhead.", inputSchema: obj({}) },
  { name: "module_scaffold", description: "Start a module that passes the checks.", inputSchema: obj({ name: str, dir: str }, ["name"]) },
  { name: "module_check", description: "Check a module's manifest, screens and entry.", inputSchema: obj({ dir: str }, ["dir"]) },
  { name: "module_test", description: "Conformance and the module's own tests.", inputSchema: obj({ dir: str }, ["dir"]) },
  { name: "module_install", description: "Check a module and stage it for the owner to install.", inputSchema: obj({ dir: str }, ["dir"]) },
];

const text = (/** @type {string} */ t, /** @type {boolean} */ isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/** Run the vyre CLI and keep the last lines. @param {string[]} args */
function cli(args) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [VYRE_BIN, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    let out = "";
    p.stdout.on("data", d => { out += String(d); });
    p.stderr.on("data", d => { out += String(d); });
    const timer = setTimeout(() => p.kill("SIGKILL"), 180_000);
    p.on("close", code => { clearTimeout(timer); resolve({ code: code ?? 1, out: out.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").slice(-25).join("\n") }); });
    p.on("error", e => { clearTimeout(timer); resolve({ code: 1, out: e.message }); });
  });
}

/** One tool call. `box` calls a Vyre box tool (design.propose); injected so the server can be tested without one. */
export async function callTool(/** @type {string} */ name, /** @type {any} */ a = {}, /** @type {{ box?: (tool: string, input: any) => Promise<any>, appUrl?: string, chrome?: string, cli?: typeof cli }} */ env = {}) {
  const run = env.cli || cli;
  switch (name) {
    case "design_catalogue": return text(catalogue(a.level || "index", a.type));
    case "design_validate": {
      const problems = validateScreen(a.screen);
      return text(problems.length ? problems.slice(0, 12).join("\n") + (problems.length > 12 ? `\n(${problems.length - 12} more)` : "") : "ok", problems.length > 0);
    }
    case "design_render": {
      const problems = validateScreen(a.screen);
      if (problems.length) return text(problems.slice(0, 8).join("\n"), true);
      try {
        const r = await renderScreen({ screen: a.screen, surface: a.surface, theme: a.theme, appUrl: env.appUrl || process.env.VYRE_APP_URL || "", chrome: env.chrome });
        const b64 = fs.readFileSync(r.file).toString("base64");
        return { content: [{ type: "text", text: `${r.file} (${r.width} wide${r.sampled.length ? `; sample data in ${r.sampled.join(", ")}` : ""})` }, { type: "image", data: b64, mimeType: "image/png" }] };
      } catch (e) { return text(/** @type {Error} */ (e).message, true); }
    }
    case "design_propose": {
      const problems = validateScreen(a.screen);
      if (problems.length) return text(problems.slice(0, 8).join("\n"), true);
      if (!env.box) return text("no Vyre box to send it to: start Vyre (vyre up), then ask again", true);
      const r = await env.box("design.propose", { id: a.id, title: a.title, screen: a.screen, why: a.why });
      if (r.error) return text(`${r.error.code}: ${r.error.message}`, true);
      if (r.data && r.data.problems) return text(r.data.problems.join("\n"), true);
      const p = r.data.proposal;
      return text(`proposal ${p.id} sent to the owner${p.replaces ? " (replaces a screen)" : ""}; reads ${p.uses.reads.join(", ") || "nothing"}; runs ${p.uses.runs.join(", ") || "nothing"}`);
    }
    case "design_brand": {
      if (!env.box) return text("no Vyre box to ask: start Vyre (vyre up)", true);
      const r = await env.box("brand.resolve", {});
      if (r.error) return text(`${r.error.code}: ${r.error.message}`, true);
      const b = r.data;
      return text(JSON.stringify({ names: b.names, accent: b.accent && { light: b.accent.paper, dark: b.accent.dark }, fonts: b.fonts, letterhead: b.letterhead.on, logo: Boolean(b.logos.light || b.logos.mark) }));
    }
    case "module_scaffold": { const r = /** @type {any} */ (await run(["module", "new", String(a.name), ...(a.dir ? ["--dir", String(a.dir)] : [])])); return text(r.out, r.code !== 0); }
    case "module_check": { const r = /** @type {any} */ (await run(["module", "check", String(a.dir)])); return text(r.out || "ok", r.code !== 0); }
    case "module_test": { const r = /** @type {any} */ (await run(["module", "test", String(a.dir)])); return text(r.out || "ok", r.code !== 0); }
    case "module_install": {
      const r = /** @type {any} */ (await run(["module", "check", String(a.dir)]));
      if (r.code !== 0) return text(r.out, true);
      const dir = path.resolve(String(a.dir));
      return text(`checked and ready. Installing code is the owner's act: they run  vyre module add ${dir}  and say yes to what it reaches.`);
    }
    default: return text(`no tool ${name}`, true);
  }
}

/** The JSON-RPC handler. @param {any} msg @param {Parameters<typeof callTool>[2]} [env] */
export async function handle(msg, env = {}) {
  const { method, params } = msg;
  switch (method) {
    case "initialize": return { protocolVersion: params?.protocolVersion || PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "vyre-design", version: "0.3.1" },
      instructions: "Design with blocks: design_catalogue (index) first, build a screen as { v: 2, layout, blocks }, design_validate it, design_render to see it, design_propose to send it to its owner. Modules: module_scaffold, module_check, module_test, module_install." };
    case "ping": return {};
    case "tools/list": return { tools: TOOLS };
    case "tools/call": return callTool(String(params?.name || ""), params?.arguments || {}, env);
    default: if (msg.id === undefined) return undefined; throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
  }
}

export async function serve() {
  const { call } = await import("../../core/daemon/client.js");
  const box = async (/** @type {string} */ tool, /** @type {any} */ input) => call(tool, input, { caller: "mcp" });
  const send = (/** @type {any} */ o) => process.stdout.write(JSON.stringify(o) + "\n");
  readline.createInterface({ input: process.stdin }).on("line", async line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
    try {
      const result = await handle(msg, { box });
      if (msg.id !== undefined && result !== undefined) send({ jsonrpc: "2.0", id: msg.id, result });
    } catch (e) { if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: /** @type {any} */ (e).code || -32603, message: /** @type {Error} */ (e).message } }); }
  });
}
