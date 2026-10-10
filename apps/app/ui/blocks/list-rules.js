// How a list row's accessory is drawn. A quiet list (the settings density) says it as plain text; a state that needs the person (accent, warn or err) stays a chip so it is not missed. Every other list draws a chip.
/** @param {boolean} tight a tight list @param {string | undefined} tone the row's tone */
export const accessoryAsChip = (tight, tone) => !tight || tone === "accent" || tone === "warn" || tone === "err";
