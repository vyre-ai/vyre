// @ts-check
// present — put the Capsule's panel in front of the user, ready to type, on the Space they are on.
//
// Two ways, chosen by `stay`:
//   stay false (today's default): show the panel, then activate the app (app.focus steal) and focus
//     the panel. Over a normal app this is what makes typing reach the page (measured: over
//     TextEdit, a panel focused without activating the app got no keys). Over a full-screen app the
//     activation makes macOS switch to the desktop Space and open the Capsule there.
//   stay true (VYRE_CAPSULE_STAY=1, until verified over a full-screen window): join every Space,
//     full-screen ones included, again before each show (app.dock.hide() and app.hide() are known to
//     reset it in Electron), stay above full-screen windows, then show and make the panel key
//     without activating the app. Electron's panel type is a non-activating NSPanel, and focus() on
//     a panel does not activate the app, so no Space switch happens.
// scripts/capsule-spaces.mjs checks both against a throwaway full-screen window.

/** The level above full-screen windows. */
export const LEVEL = "screen-saver";

/**
 * @param {import("electron").BrowserWindow} w
 * @param {import("electron").App} app
 * @param {{ stay?: boolean, driven?: boolean }} [opts] driven: a test drives it, so it never takes the keyboard
 */
export function present(w, app, { stay = false, driven = false } = {}) {
  if (stay) {
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    w.setAlwaysOnTop(true, LEVEL);
  }
  if (driven) { w.showInactive(); w.setAlwaysOnTop(true, LEVEL); return; }
  w.show();
  w.setAlwaysOnTop(true, LEVEL);
  if (!stay) app.focus({ steal: true });
  w.focus();
  w.webContents.focus();
}
