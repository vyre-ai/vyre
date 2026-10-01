#!/usr/bin/env node
// write-release-json: dist/release.json, in one small file the approver can read in full: it runs in the release job next to the signing key.
//   node scripts/write-release-json.mjs <dist> <version> <channel> <commit> <min_from> [<box-ref> <computer-ref>]
// Without refs (a dry run pushes no images) the file has no `images`; with them, images.box and images.computer name the digests, and the
// updater refuses a pulled release that lacks them. Reads dist/notes.md; touches nothing else; never reads the environment.
import fs from "node:fs";
import path from "node:path";

const [dir, version, channel, commit, min_from, box, computer] = process.argv.slice(2);
if (!dir || !version || !channel || !commit || !min_from) { console.error("usage: write-release-json.mjs <dist> <version> <channel> <commit> <min_from> [<box-ref> <computer-ref>]"); process.exit(2); }
const platforms = ["linux/amd64", "linux/arm64"];
const images = box ? { box: { ref: box, platforms }, computer: { ref: computer, platforms } } : undefined;
fs.writeFileSync(path.join(dir, "release.json"), JSON.stringify({ version, channel, commit, date: new Date().toISOString(), min_from,
  notes: fs.readFileSync(path.join(dir, "notes.md"), "utf8"), ...(images ? { images } : {}) }, null, 2) + "\n");
