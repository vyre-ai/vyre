// The slot a person token is kept under: the origin of the box address. A page on a custom scheme (the Mac app's vyreapp://box) has the opaque origin "null" (location.origin is that string), which is not
// a URL: it keeps and reads its token under "null". Writing and reading both come through here, so they always meet in one slot.
export function tokenOrigin(box: string): string {
  try { return new URL(box).origin; } catch { return String(box) === "null" ? "null" : String(box); }
}
