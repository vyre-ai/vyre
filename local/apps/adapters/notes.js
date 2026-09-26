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
set n to make new note with properties {body:theBody}
else
set n to make new note at folder folderName with properties {body:theBody}
end if
return (id of n) & (character id 31) & (name of n)
end tell
end run`;

export const APPEND = `on run argv
set argv to rest of argv
set theId to item 1 of argv
set extra to item 2 of argv
tell application "Notes"
set n to note id theId
set body of n to (body of n) & extra
return name of n
end tell
end run`;

// Names, ids and how many seconds ago each changed, fetched in bulk (three Apple events, not
// three per note). Seconds ago rather than a date string, so no locale is involved.
export const LIST = `on run argv
set argv to rest of argv
set out to ""
set nowDate to current date
tell application "Notes"
set theIds to id of every note
set theNames to name of every note
set theDates to modification date of every note
end tell
repeat with i from 1 to count of theIds
set out to out & (item i of theIds) & (character id 31) & (item i of theNames) & (character id 31) & ((nowDate - (item i of theDates)) as integer) & (character id 30)
end repeat
return out
end run`;

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
  /** The 50 most recently changed notes whose name contains q, newest first. */
  async targets(q, env) {
    const out = await env.osa(LIST, []);
    const needle = String(q || "").toLowerCase();
    return out.split(RS).filter(Boolean).map(r => r.split(US))
      .map(([id, title, ago]) => ({ id, title, ago: Number(ago) || 0 }))
      .filter(n => n.id && (!needle || n.title.toLowerCase().includes(needle)))
      .sort((a, b) => a.ago - b.ago)
      .slice(0, 50)
      .map(({ id, title }) => ({ id, title, kind: "note" }));
  },
};
