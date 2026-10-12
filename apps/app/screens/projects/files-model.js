// @ts-check
// A member's project files in the app: what the team's door carries (core/work/member-files.js: 150 KB up, 1.4 MB down, a plain file name) said in words BEFORE she picks a file, and what a file she picked or
// opened comes to. Pure: FilesPane draws it. The server decides every limit; these only say them first and refuse early in the same words.

export const LIMIT_UP = 150 * 1024;
export const LIMIT_DOWN = 1_400_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/;
const kb = (/** @type {number} */ n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** The line above "Add a file" and the line above the list. */
export const ADD_WORDS = `A file you add here can be up to ${LIMIT_UP / 1024} KB. For a larger one, ask the owner.`;
export const OPEN_WORDS = `A file opens here when it is up to ${(LIMIT_DOWN / 1_000_000).toFixed(1)} MB, and as text. Save is not in the app yet.`;

/** Is this file one she may send? { name, data } to send, or { error } in words. @param {{ name: string, bytes: number, base64: string }} f */
export function checkUpload(f) {
  const name = String(f.name || "").trim();
  if (!NAME.test(name) || name.includes("..") || name.endsWith(".")) return { error: "A file name is letters, numbers, spaces, dots, dashes and underscores (up to 120), starting with a letter or number, with no folder in it. Rename the file and try again." };
  if (f.bytes > LIMIT_UP) return { error: `That file is ${kb(f.bytes)}; a file added here is at most ${LIMIT_UP / 1024} KB. Send a smaller one, or ask the owner to add it.` };
  return { name, data: f.base64 };
}

const TEXT = /\.(txt|md|markdown|csv|tsv|json|log|yaml|yml|xml|html|htm|css|js|ts)$/i;

/** What an opened file shows: its text, or words saying why not. @param {{ name: string, size?: number, data?: string }} r */
export function openedView(r) {
  const name = String(r.name || "file");
  if (!TEXT.test(name)) return { name, words: "This kind of file does not open in the app yet. Ask the owner, or open it on your computer." };
  try {
    const bin = typeof atob === "function" ? atob(String(r.data || "")) : Buffer.from(String(r.data || ""), "base64").toString("binary");
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return { name, text: new TextDecoder("utf-8").decode(bytes) };
  } catch { return { name, words: "That file could not be read as text." }; }
}
