// @ts-check
// Close on a press outside or on Esc: the one rule for every popover and picker in @vyre/ui. Menu gets it from its primitive (an outside press and Esc close it on the web, the overlay on a
// phone); a popover drawn as a plain view (the New menu, the composer's pickers) wires it here through usePopoverDismiss. Pure: the document is passed in, so a test hands it a fake one.

/**
 * Listen on a document while a popover is open: a pointer press whose target is outside every node in `inside()` closes it, and so does Esc. Capture phase, so a press on something that stops
 * its own event still closes. Returns the function that stops listening.
 * @param {{ addEventListener: (t: string, f: (e: any) => void, c?: boolean) => void, removeEventListener: (t: string, f: (e: any) => void, c?: boolean) => void } | null | undefined} doc
 * @param {() => readonly ({ contains?: (n: any) => boolean } | null | undefined)[]} inside the popover itself and the control that opened it (pressing that one toggles, it does not close twice)
 * @param {() => void} onClose
 * @param {{ esc?: boolean }} [o] esc: false when the popover reads Esc itself (the composer's picker steps back a level on Esc before it closes)
 * @returns {() => void}
 */
export function attachDismiss(doc, inside, onClose, o) {
  const esc = o?.esc !== false;
  if (!doc) return () => {};
  const press = (/** @type {any} */ e) => {
    const t = e?.target;
    if (!t) return;
    if (inside().some((n) => !!n && typeof n.contains === "function" && n.contains(t))) return;
    onClose();
  };
  const key = (/** @type {any} */ e) => { if (e?.key === "Escape") onClose(); };
  doc.addEventListener("pointerdown", press, true);
  if (esc) doc.addEventListener("keydown", key, true);
  return () => { doc.removeEventListener("pointerdown", press, true); if (esc) doc.removeEventListener("keydown", key, true); };
}
