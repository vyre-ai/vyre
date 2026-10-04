// What place-release.sh runs after copying the host's release files: when the release folder carries no modules.json or appbuild.json of its own (a release put there by an old updater, which
// knows only shell.json), write them from the shell.json that carries them, if and only if SHA256SUMS is signed by the release key, lists that shell.json and lists each text (lib/release-shell.js).
// Prints what it wrote; writes nothing and exits 0 when anything does not verify, so a tampered or missing list starts no module.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { placeFromShell } from "../../lib/release-shell.js";

const root = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const wrote = placeFromShell(root);
if (wrote.length) console.log("place-release: rebuilt " + wrote.join(", ") + " from the signed shell.json");
