// @ts-check
// How a side panel shows: nothing when closed, a Sheet on a phone, the panel over the view otherwise. Pure.

/** @param {{ open: boolean, phone: boolean }} o @returns {"closed" | "sheet" | "panel"} */
export const sidePanelMode = ({ open, phone }) => (!open ? "closed" : phone ? "sheet" : "panel");
