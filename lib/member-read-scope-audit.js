// @ts-check
// Registry audit: every MEMBER_MAY read tool must scope via lib/member-scope.js (or a documented native/kernel path).

import fs from "node:fs";
import path from "node:path";

/** @param {string} dir */
export function dirUsesMemberScope(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  /** @param {string} d */
  const walk = d => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "node_modules") continue;
        if (walk(p)) return true;
      } else if (ent.isFile() && ent.name.endsWith(".js")) {
        const src = fs.readFileSync(p, "utf8");
        if (/from\s+["'][^"']*member-scope(?:\.js)?["']/.test(src) || /require\([^)]*member-scope/.test(src)) return true;
        if (/person_id/.test(src) && /projects\.reach/.test(src)) return true;
      }
    }
    return false;
  };
  return walk(dir);
}

/**
 * Read tools scoped on the kernel chain or a module-local person gate (not the cli→owner projects.reach leak class).
 * Adding a tool here requires a live leak test in member-read-scope.test.js; prefer lib/member-scope.js for new tools.
 * @param {string} tool
 */
export function usesNativeReadScope(tool) {
  const native = [
    "records.", "vault.me.", "planner.", "presence.person.", "wink.",
    "stream.", "work.", "flows.", "agents.", "sessions.accounts.",
    "goals.", "tasks.", "team.", "runner.", "roles.", "rules.", "mentions.",
    "models.", "providers.", "previews.", "appmods.", "documents.template.",
    "flows.kit.", "views.", "mcp.mine.", "connectors.", "documents.",
    "onboard.", // ownerWrite / joinOwnerOnly on writes; reads are the person's setup state only
    "releases.", // releases.info is reach anyone (version + secret names, never values)
  ];
  return native.some(p => tool.startsWith(p));
}

/**
 * @param {import("../core/modules/index.js").Registry} registry
 * @param {ReadonlySet<string>} memberMay
 */
export function memberReadTools(registry, memberMay) {
  return [...memberMay].filter(name => {
    const def = registry.tools.get(name);
    return def && def.effect === "read" && !def.internal && !def.hook;
  }).sort();
}

/**
 * Every MEMBER_MAY read tool must be wired: native/kernel path or member-scope in its module tree.
 * @param {import("../core/modules/index.js").Registry} registry
 * @param {ReadonlySet<string>} memberMay
 */
export function assertMemberReadScopeWiring(registry, memberMay) {
  /** @param {string} mod */
  const dirOf = mod => {
    const rec = registry.modules.get(mod);
    return rec && rec.dir ? String(rec.dir) : "";
  };

  const missing = [];
  for (const tool of memberReadTools(registry, memberMay)) {
    if (usesNativeReadScope(tool)) continue;
    const def = registry.tools.get(tool);
    const dir = def ? dirOf(def.module) : "";
    if (!dirUsesMemberScope(dir)) missing.push(`${tool} (module ${def && def.module}): import lib/member-scope.js or add a usesNativeReadScope prefix in lib/member-read-scope-audit.js`);
  }
  return missing;
}
