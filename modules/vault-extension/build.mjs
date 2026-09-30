// @ts-check
// build: one source, two clean packages. The folder itself loads in both browsers as it is
// (Chrome 121+ uses background.service_worker and ignores background.scripts; Firefox 121+ does
// the opposite, and Chrome ignores browser_specific_settings). The unused keys cost a warning on
// the extensions page, so this writes a package per browser without them:
//
//   node modules/vault-extension/build.mjs           writes dist/chrome/ and dist/firefox/
//   node modules/vault-extension/build.mjs <out>     writes <out>/chrome/ and <out>/firefox/
//
// A plain copy of the extension's files and a manifest transform. No dependencies, no bundler,
// no minifier: what ships is what is reviewed here.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Scripts the manifest does not name but the worker injects or registers by file name: fill.js,
 * cards.js and inline.js (executeScript, registerContentScripts), passkey-page.js and passkey-bridge.js
 * (registered for every page while passkeys are on), keyfind.js and keychip.js (registered for
 * every page while the API-key offer is on). A package without one of them loads fine
 * and then fails on a page, so the build refuses instead.
 */
export const INJECTED = ["fill.js", "cards.js", "inline.js", "passkey-page.js", "passkey-bridge.js", "keyfind.js", "keychip.js"];

/** The files a package carries. Tests, this script and dist/ stay behind. */
export function packageFiles(dir = HERE) {
  return fs.readdirSync(dir).filter(f => /\.(js|html|css|png|svg|json|md)$/.test(f) && !/\.test\.js$/.test(f) && f !== "build.mjs").sort();
}

/**
 * The manifest for one browser, from the shared one.
 * @param {any} manifest the parsed source manifest.json
 * @param {"chrome"|"firefox"} target
 */
export function forBrowser(manifest, target) {
  const m = JSON.parse(JSON.stringify(manifest));
  const script = m.background.service_worker || (m.background.scripts || [])[0];
  if (target === "chrome") {
    m.background = { service_worker: script };
    delete m.browser_specific_settings;
  } else if (target === "firefox") {
    // Firefox MV3 runs the background as an event page: the same file, as a script.
    m.background = { scripts: [script] };
    delete m.minimum_chrome_version;
    if (!m.browser_specific_settings || !m.browser_specific_settings.gecko || !m.browser_specific_settings.gecko.id) throw new Error("the manifest has no gecko id");
  } else {
    throw new Error(`no such target ${target}`);
  }
  return m;
}

/** Write <out>/chrome and <out>/firefox. @param {string} [out] @returns {{ chrome: string, firefox: string }} */
export function build(out = path.join(HERE, "dist")) {
  const manifest = JSON.parse(fs.readFileSync(path.join(HERE, "manifest.json"), "utf8"));
  const files = packageFiles();
  const missing = INJECTED.filter(f => !files.includes(f));
  if (missing.length) throw new Error(`the package would lack ${missing.join(", ")}`);
  const dirs = { chrome: path.join(out, "chrome"), firefox: path.join(out, "firefox") };
  for (const target of /** @type {const} */ (["chrome", "firefox"])) {
    const d = dirs[target];
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
    for (const f of files) if (f !== "manifest.json") fs.copyFileSync(path.join(HERE, f), path.join(d, f));
    fs.writeFileSync(path.join(d, "manifest.json"), JSON.stringify(forBrowser(manifest, target), null, 2) + "\n");
  }
  return dirs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dirs = build(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  console.log(`wrote ${dirs.chrome}\nwrote ${dirs.firefox}`);
}
