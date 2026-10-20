// @ts-check
// How a side panel shows: nothing when closed, a Sheet on a phone, the panel beside the view otherwise. Pure.

/** @param {{ open: boolean, phone: boolean }} o @returns {"closed" | "sheet" | "panel"} */
export const sidePanelMode = ({ open, phone }) => (!open ? "closed" : phone ? "sheet" : "panel");

/**
 * The panel's box on a wide screen: in the row beside the view, with its own width, never laid over it. It takes at most half the row, so a narrow window keeps the list readable, and it keeps its width
 * when the list is wide. (It was drawn over the view with position: absolute, which put the record on top of the list's header and toolbar.) @param {number} [width]
 */
export const sidePanelBox = (width = 520) => ({ width, maxWidth: "50%", flexShrink: 0, alignSelf: "stretch" });
