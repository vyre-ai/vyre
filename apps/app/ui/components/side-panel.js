// @ts-check
// How a side panel shows: nothing when closed, a Sheet on a phone, the panel beside the view otherwise. Pure.

/** @param {{ open: boolean, phone: boolean }} o @returns {"closed" | "sheet" | "panel"} */
export const sidePanelMode = ({ open, phone }) => (!open ? "closed" : phone ? "sheet" : "panel");

/**
 * The panel's box on a wide screen: in the row beside the view, with its own width, never laid over it. It takes at most half the row, so a narrow window keeps the list readable, and it keeps its width
 * when the list is wide. (It was drawn over the view with position: absolute, which put the record on top of the list's header and toolbar.) @param {number} [width] @param {boolean} [narrow]
 */
export const sidePanelBox = (width = 520, narrow = false, maxPct = 50) => (narrow ? { position: "absolute", top: 0, right: 0, bottom: 0, width, maxWidth: "92%" } : { width, maxWidth: `${maxPct}%`, flexShrink: 0, alignSelf: "stretch" });

/** The narrowest and widest a dragged panel goes: 360 up to 60% of the window. @param {number} windowWidth */
export const panelLimits = (windowWidth) => ({ min: 360, max: Math.max(360, Math.round(windowWidth * 0.6)) });

/** Below this window width the panel is a solid sheet over the list (half the row would be too little for either). */
export const NARROW = 900;

/**
 * Whether a press or key closes the panel: Escape anywhere (a field keeps its own Escape to cancel its edit), and a press outside the panel that is not on a menu, dialog or tip drawn above it.
 * @param {{ type: "key" | "press", key?: string, inField?: boolean, inside?: boolean, onTop?: boolean }} e
 */
export const closesPanel = (e) => (e.type === "key" ? e.key === "Escape" && !e.inField : !e.inside && !e.onTop);
