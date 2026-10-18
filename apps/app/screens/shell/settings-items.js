// @ts-check
// The Settings sidebar panel's list: the same rows as the Settings home (settings/logic.js), so the two cannot drift. Pure, so a test can check every entry opens a real screen (settings-routes.test.js).
import { settingsGroups } from "../settings/logic.js";

/** Each entry opens one existing screen; the one-line description of each is on the Settings home. */
export const SETTINGS_ITEMS = settingsGroups("Space").flatMap((g) => g.rows.map(([label, , href, icon]) => ({ id: href, label, href, icon, group: g.title })));
