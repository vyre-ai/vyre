// @ts-check
// notes: new notes and additions to existing ones in the Notes app, through its AppleScript
// dictionary.
//
// A note's body is HTML, and Notes takes its title from the body's first line. So the text is
// escaped and split into <div> lines here in JS, and only the finished HTML crosses into
// AppleScript, as argv. The scripts below are constants: no user text is ever part of one.

import { AppsError } from "../env.js";

/** Field and record separators for script output: characters no note name contains. */
const US = "\u001f", RS = "\u001e";

export const CREATE = `on run argv
set argv to rest of argv
set theBody to item 1 of argv
set folderName to item 2 of argv
tell application "Notes"
if folderName is "" then
set n to make new note at default folder of default account with properties {body:theBody}
else
set n to make new note at folder folderName with properties {body:theBody}
end if
return (id of n) & (character id 31) & (name of n)
end tell
end run`;

// Setting the body rewrites the whole note, and anything that is not HTML text (an image, a
// scan, a drawing) would be lost, and a locked note cannot be read at all. So both refuse, with
// a code the Capsule can say in words.
export const APPEND = `on run argv
set argv to rest of argv
set theId to item 1 of argv
set extra to item 2 of argv
tell application "Notes"
set n to note id theId
if password protected of n then error "vyre:not_supported: that note is locked, so Vyre cannot add to it"
if (count of attachments of n) > 0 then error "vyre:not_supported: that note has attachments, which adding text would lose"
set body of n to (body of n) & extra
return name of n
end tell
end run`;

// Every note outside the trash: names, ids and how many seconds ago each changed, fetched in
// bulk per folder (three Apple events a folder, not three a note). Seconds ago rather than a
// date string, so no locale is involved. Records are gathered in a list and joined once with
// text item delimiters; concatenating in the loop is quadratic.
//
// The trash is found by name (argv item 1, "Recently Deleted" unless config apps.notes.trash
// says otherwise). Notes' dictionary gives the Recently Deleted folder no property that sets it
// apart, so on a Mac in another language the trash is only skipped once that is configured.
export const LIST = `on run argv
set argv to rest of argv
set trashName to item 1 of argv
set recs to {}
set nowDate to current date
set US to character id 31
tell application "Notes"
repeat with f in (every folder)
if (name of f) is not trashName then
set theIds to id of every note of f
set theNames to name of every note of f
set theDates to modification date of every note of f
repeat with i from 1 to count of theIds
set end of recs to (item i of theIds) & US & (item i of theNames) & US & (((nowDate - (item i of theDates)) as integer) as text)
end repeat
end if
end repeat
end tell
set AppleScript's text item delimiters to character id 30
set out to recs as text
set AppleScript's text item delimiters to ""
return out
end run`;

/** Listing every folder's notes can take a while on a big library. */
export const LIST_TIMEOUT_MS = 30000;
export const TRASH = "Recently Deleted";

/** Escape text for a note's HTML body. */
export function escapeHtml(/** @type {string} */ s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Text as note HTML: one <div> per line, an empty line kept as a blank one. */
export function toHtml(/** @type {string} */ text) {
  return String(text).replace(/\r\n?/g, "\n").split("\n").map(l => (l.trim() ? `<div>${escapeHtml(l)}</div>` : "<div><br></div>")).join("");
}

const firstLine = (/** @type {string} */ text) => String(text).split(/\r?\n/).find(l => l.trim())?.trim() || "";

/** @type {import("./index.js").Adapter} */
export default {
  id: "notes",
  app: "Notes",
  bundleIds: ["com.apple.Notes"],
  tier: "script",
  actions: {
    create: {
      title: "New note",
      input: { type: "object", required: ["text"], properties: {
        text: { type: "string" },
        title: { type: "string", description: "Default: the first line of text." },
        folder: { type: "string", description: "A folder name. Default: Notes' default folder." },
      } },
      sends: false,
      async run({ text, title, folder }, env) {
        if (!String(text).trim()) throw new AppsError("bad_input", "a note needs some text");
        const head = title && title.trim() && title.trim() !== firstLine(text) ? `<div><b>${escapeHtml(title.trim())}</b></div>` : "";
        const out = await env.osa(CREATE, [head + toHtml(text), folder || ""]);
        const [id, name] = out.split(US);
        return { said: `Note saved: ${name || title || firstLine(text)}`, id, title: name || title || firstLine(text) };
      },
    },
    append: {
      title: "Add to a note",
      input: { type: "object", required: ["note", "text"], properties: {
        note: { type: "string", description: "A note's id, from apps.targets." },
        text: { type: "string" },
      } },
      sends: false,
      async run({ note, text }, env) {
        if (!String(text).trim()) throw new AppsError("bad_input", "nothing to add");
        const name = await env.osa(APPEND, [note, toHtml(text)]);
        return { said: `Note saved: ${name}`, id: note, title: name };
      },
    },
  },
  /** The 50 most recently changed notes outside the trash whose name contains q, newest first. */
  async targets(q, env) {
    const trash = (env.config && env.config.notes && env.config.notes.trash) || TRASH;
    const out = await env.osa(LIST, [trash], { timeoutMs: LIST_TIMEOUT_MS });
    const seen = new Set();
    const needle = String(q || "").toLowerCase();
    return out.split(RS).filter(Boolean).map(r => r.split(US))
      .map(([id, title, ago]) => ({ id, title, ago: Number(ago) || 0 }))
      .filter(n => n.id && !seen.has(n.id) && seen.add(n.id) && (!needle || n.title.toLowerCase().includes(needle)))
      .sort((a, b) => a.ago - b.ago)
      .slice(0, 50)
      .map(({ id, title }) => ({ id, title, kind: "note" }));
  },
};
