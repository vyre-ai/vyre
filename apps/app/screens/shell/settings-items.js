// @ts-check
// The Settings sidebar panel's list: the same rows as the Settings home (settings/logic.js), so the two cannot drift. Pure, so a test can check every entry opens a real screen (settings-routes.test.js).
import { settingsGroups } from "../settings/logic.js";

/** The panel's entries; with Labs on (settings/labs.tsx) the archived pages follow as a Labs group. @param {boolean} [labs] */
export const settingsItems = (labs = false) => settingsGroups("Space", undefined, { labs }).flatMap((g) => g.rows.map(([label, , href, icon]) => ({ id: href, label, href, icon, group: g.title })));

/** Each entry opens one existing screen; the one-line description of each is on the Settings home. Labs off: what everyone sees. */
export const SETTINGS_ITEMS = settingsItems(false);
