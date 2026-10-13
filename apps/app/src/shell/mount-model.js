// @ts-check
// Vyre in Finder and File Explorer, as the page sees it: which server calls the computer app's file extension may have the page make for it, and the words Settings shows. Pure.
// The Mac app (Sources/Mount/MountCalls.swift allowedTools) and the Windows app (app/src/mountctl.rs) hold the same list on their side; the page checks again so a call outside it is never made.

/** The tools the file extension may ask for: the Space Drive's mount tools, and nothing that deletes for good or restores. */
export const MOUNT_TOOLS = Object.freeze([
  "files.drive.space.changes", "files.drive.space.read", "files.drive.upload", "files.drive.space.upload.begin", "files.drive.space.upload.part",
  "files.drive.space.upload.commit", "files.drive.space.upload.abort", "files.drive.space.trash", "files.drive.space.move", "files.drive.space.stat",
]);

/** @param {unknown} name */
export const mountCallable = name => typeof name === "string" && MOUNT_TOOLS.includes(name);

/**
 * What Settings shows for the switch. `state` is what the computer app answered ({ supported, on, paired? }) or null when it did not answer.
 * @param {"mac" | "windows" | null} kind @param {{ supported?: boolean, on?: boolean, paired?: boolean } | null} state
 * @returns {{ show: boolean, on: boolean, place: string, title: string, sub: string, button: string, enabled: boolean }}
 */
export function mountView(kind, state) {
  const place = kind === "windows" ? "File Explorer" : "Finder";
  const title = `Show Vyre in ${place}`;
  const none = { show: false, on: false, place, title, sub: "", button: "", enabled: false };
  if (!kind || !state || state.supported !== true) return none;
  const on = state.on === true;
  if (state.paired === false) return { show: true, on, place, title, sub: "Pair this computer with your Vyre first.", button: "Show", enabled: false };
  return {
    show: true, on, place, title, enabled: true,
    sub: on ? `Your files are in ${place}. A file downloads when you open it, and what you change there goes back to Vyre. What you delete goes to the trash on your server.` : `Put your Vyre files in ${place}, the way iCloud Drive or OneDrive does. You see only what you may open.`,
    button: on ? "Stop showing" : "Show",
  };
}
