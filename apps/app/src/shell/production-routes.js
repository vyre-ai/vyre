// @ts-check
// Every /u route a production build registers. Gallery, demo, proof and shots pages stay on disk for the mock build and are left out here.
import fs from "node:fs";
import path from "node:path";
import { MOCK_ONLY, PROOF_OR_MOCK } from "../../scripts/sample-routes.js";

const SKIP = new Set(["_layout.tsx", "+not-found.tsx", "+html.tsx"]);
const BLOCKED = [...MOCK_ONLY, ...PROOF_OR_MOCK].map((n) => new RegExp(`^${n}$`));

/** @param {string} rel path under app/, no extension */
export function isProductionRoute(rel) {
  return !BLOCKED.some((re) => re.test(rel));
}

/**
 * Route patterns under /u that a production build keeps, sorted. `appDir` is the Expo `app/` directory.
 * @param {string} appDir
 * @returns {string[]}
 */
export function productionRoutes(appDir) {
  /** @type {string[]} */ const out = [];
  const walk = (/** @type {string} */ dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (!e.name.endsWith(".tsx") || SKIP.has(e.name)) continue;
      let rel = path.relative(appDir, f).split(path.sep).join("/").replace(/\.tsx$/, "");
      if (rel.endsWith("/index")) rel = rel.slice(0, -"/index".length);
      if (!rel.startsWith("u/") && rel !== "u") continue;
      if (!isProductionRoute(rel)) continue;
      out.push(rel === "u" ? "/u" : `/${rel}`);
    }
  };
  walk(appDir);
  return out.sort();
}
