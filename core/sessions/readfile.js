// @ts-check
// Read one regular file as the account that owns it, for a provider that leaves a generated file in the account's own folder (Grok Build writes an image
// as a 0600 file there). Run as a script under the account's uid (`node readfile.js <home> <path> <maxBytes>`), the bytes go to stdout; vyred never reads
// the account's folder itself. The path must be absolute and already canonical (no symlink anywhere along it), inside the account's HOME, opened with
// O_NOFOLLOW, a regular file, and no larger than the cap. One line on stderr and a non-zero exit say why not.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_BYTES = 20 * 1024 * 1024;

/** Where a provider leaves what it generated, relative to the account's HOME: Grok's per-session media folders, Codex's generated_images. Nothing else of .grok or .codex (the login lives there). */
const OUTPUT_FOLDERS = [/^\.grok\/sessions\/[^/]+\/[^/]+\/(?:images|videos|media|audio)\/[^/]+$/, /^\.codex\/generated_images\/[^/]+\/[^/]+$/];
const MEDIA_EXT = /\.(?:jpe?g|png|webp|gif|mp4|webm|mp3|wav|ogg|m4a)$/i;
const SENSITIVE_NAME = /auth|token|credential|config|secret|key|passw/i;

/** The first bytes must be a picture, a video or a sound, whatever the name says. @param {Buffer} b */
export function looksLikeMedia(b) {
  const at = (i, hex) => b.length >= i + hex.length / 2 && b.subarray(i, i + hex.length / 2).toString("hex") === hex;
  return at(0, "89504e470d0a1a0a") || at(0, "ffd8ff") || at(0, "474946383761") || at(0, "474946383961")
    || (at(0, "52494646") && (b.subarray(8, 12).toString("latin1") === "WEBP" || b.subarray(8, 12).toString("latin1") === "WAVE"))
    || b.subarray(4, 8).toString("latin1") === "ftyp" || at(0, "1a45dfa3") || at(0, "4f676753") || at(0, "494433") || at(0, "fffb") || at(0, "fff3") || at(0, "fff2");
}

/**
 * @param {string} home @param {string} file @param {number} [max]
 * @returns {{ fd: number, size: number } | { error: string }}
 */
export function openConfined(home, file, max = MAX_BYTES) {
  try {
    if (!path.isAbsolute(file) || file.includes("\0")) return { error: "the path must be absolute" };
    // The path as given must sit under the HOME as given, and resolving it must land on exactly that spot under the real HOME: any link between
    // them (a folder or the file) moves the result and is refused. (The HOME itself may be reached through a link, as /var is on a Mac.)
    const given = path.resolve(file), base = path.resolve(home);
    if (!(given === base || given.startsWith(base + path.sep))) return { error: "the path is outside the account's folder" };
    const realHome = fs.realpathSync(home);
    const real = fs.realpathSync(given);
    if (real !== path.join(realHome, path.relative(base, given))) return { error: "the path goes through a link" };
    const rel = path.relative(base, given).split(path.sep).join("/");
    if (!OUTPUT_FOLDERS.some(re => re.test(rel))) return { error: "not a place the provider writes generated files" };
    if (!MEDIA_EXT.test(rel) || SENSITIVE_NAME.test(path.basename(rel))) return { error: "not a media file name" };
    const fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) { fs.closeSync(fd); return { error: "not a regular file" }; }
    if (st.size > Math.min(max, MAX_BYTES)) { fs.closeSync(fd); return { error: "the file is larger than the limit" }; }
    // The first bytes, before a single byte leaves: a login file renamed .png is not a picture.
    const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0);
    if (!looksLikeMedia(head)) { fs.closeSync(fd); return { error: "not a picture, video or sound" }; }
    return { fd, size: st.size };
  } catch (e) { return { error: /** @type {any} */ (e).code === "ENOENT" ? "no such file" : "cannot read it" }; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const opened = openConfined(String(process.argv[2] || ""), String(process.argv[3] || ""), Number(process.argv[4]) || MAX_BYTES);
  if ("error" in opened) { process.stderr.write(opened.error + "\n"); process.exit(2); }
  const out = fs.createReadStream("", { fd: opened.fd, autoClose: true });
  out.on("error", () => process.exit(3));
  out.pipe(process.stdout);
}
