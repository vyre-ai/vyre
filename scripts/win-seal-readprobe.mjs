#!/usr/bin/env node
// @ts-check
// Windows CI only (the Windows home walk): try to list a folder and read master.dpapi in it, and say what happened. Run as a second local user, both must be denied.
import fs from "node:fs";
import path from "node:path";
const dir = process.argv[2];
if (!dir) { console.error("usage: win-seal-readprobe.mjs <dir>"); process.exit(2); }
try { fs.readdirSync(dir); console.log("LISTED"); } catch (e) { console.log(`LIST_DENIED ${/** @type {any} */ (e).code}`); }
try { fs.readFileSync(path.join(dir, "master.dpapi")); console.log("MASTER_READ"); } catch (e) { console.log(`MASTER_DENIED ${/** @type {any} */ (e).code}`); }
