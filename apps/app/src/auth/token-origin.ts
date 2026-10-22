// The slot a person token is kept under: the origin of the box address. A page on a custom scheme (the Mac app's vyreapp://box) has the opaque origin "null" (location.origin is that string), which is not
// a URL: it keeps and reads its token under "null". Writing and reading both come through here, so they always meet in one slot.
export function tokenOrigin(box: string): string {
  try { return new URL(box).origin; } catch { return String(box) === "null" ? "null" : String(box); }
}

/**
 * Slots to read a paired web token, route first. A second server keeps its own slot, so it does not overwrite the first.
 * The page origin is read after, for a token saved before routes. A write uses only the first slot.
 */
export function tokenSlots(route: string | null | undefined, origin: string): string[] {
  const primary = tokenOrigin(route || origin);
  const page = tokenOrigin(origin);
  return primary === page ? [page] : [primary, page];
}
