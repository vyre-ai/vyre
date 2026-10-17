// @ts-check
// lib/mcp-catalog-pull: what the snapshot script reads. The registry is paged by cursor (a free, unauthenticated API); a plugin repo is a checkout the workflow cloned, read from disk. `fetchJson` is
// passed in, so the tests feed fixtures and nothing here reaches a network by itself. A page that cannot be read, or a loop that does not end, fails the pull: a partial snapshot would read as
// "everything else is gone" in the weekly diff.
import fs from "node:fs";
import path from "node:path";

export const REGISTRY = "https://registry.modelcontextprotocol.io/v0/servers";
const MAX_PAGES = 2000;   // the registry passed 400 pages of 100 in Oct 2026; a pull that needs more than this is a loop or a change worth a look

/** Every page of the registry, first to last. @param {(url: string) => Promise<any>} fetchJson @param {{ base?: string, limit?: number, maxPages?: number }} [o] @returns {Promise<any[]>} */
export async function pullRegistry(fetchJson, o = {}) {
  const base = o.base || REGISTRY, pages = [], seen = new Set();
  let cursor = "";
  for (let i = 0; i < (o.maxPages || MAX_PAGES); i++) {
    const u = new URL(base);
    u.searchParams.set("limit", String(o.limit || 100));
    u.searchParams.set("version", "latest");   // the registry lists every version of every server; only the latest is read
    if (cursor) u.searchParams.set("cursor", cursor);
    const page = await fetchJson(u.toString());
    if (!page || !Array.isArray(page.servers)) throw new Error(`the registry page ${i + 1} is not a server list`);
    pages.push(page);
    const next = page.metadata && typeof page.metadata.nextCursor === "string" ? page.metadata.nextCursor : "";
    if (!next) return pages;
    if (seen.has(next)) throw new Error("the registry cursor repeats: the pull would not end");
    seen.add(next); cursor = next;
  }
  throw new Error(`the registry has more than ${o.maxPages || MAX_PAGES} pages: raise the cap on purpose`);
}

/** @param {string} p */
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };

/**
 * The plugins of one repo checkout: every directory (up to three deep) with a .mcp.json, or a .claude-plugin/plugin.json that names mcpServers.
 * @param {string} root @returns {{ plugin: string, author?: string, description?: string, servers: Record<string, any> }[]}
 */
export function readPluginRepo(root) {
  /** @type {any[]} */ const out = [];
  const walk = (/** @type {string} */ dir, /** @type {number} */ depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const mcp = readJson(path.join(dir, ".mcp.json"));
    const meta = readJson(path.join(dir, ".claude-plugin", "plugin.json")) || {};
    const servers = (mcp && typeof mcp === "object" ? (mcp.mcpServers && typeof mcp.mcpServers === "object" ? mcp.mcpServers : mcp) : null) || (meta.mcpServers && typeof meta.mcpServers === "object" ? meta.mcpServers : null);
    if (servers && Object.values(servers).some(s => s && typeof s === "object")) {
      const author = typeof meta.author === "string" ? meta.author : meta.author && typeof meta.author.name === "string" ? meta.author.name : undefined;
      out.push({ plugin: path.basename(dir), ...(author ? { author } : {}), ...(typeof meta.description === "string" ? { description: meta.description } : {}), servers });
    }
    if (depth >= 3) return;
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") walk(path.join(dir, e.name), depth + 1);
  };
  walk(root, 0);
  return out.sort((a, b) => (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0));
}
