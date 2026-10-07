/** A theme custom property ("--s-4": "16px") as a number: for the few places a style prop is needed because a third-party primitive drops className. */
export function px(map: Record<string, string | number>, key: string): number {
  const v = map[key];
  return typeof v === "number" ? v : Number.parseFloat(String(v));
}
