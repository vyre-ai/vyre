// The pure half of Appearance on the real box: the scheme setting (appearance.scheme: system, dark or paper, kept on the account so every device follows it) as the app's theme choice.
// The rest of what Appearance sets (density, font, motion, a space's look) is a device preference with no setting on the box, so it stays on this device and the page says so.

export type Scheme = "system" | "dark" | "paper";
export const SCHEMES: Scheme[] = ["system", "dark", "paper"];
export const isScheme = (v: unknown): v is Scheme => typeof v === "string" && (SCHEMES as string[]).includes(v);

/** The setting's value as the app's theme; anything the app does not know is "system". */
export const themeFrom = (value: unknown): Scheme => (isScheme(value) ? value : "system");

/** The word under the Theme control: where the choice is kept. */
export function themeNote(source: string | undefined): string {
  return source === "account" ? "Kept on your account: every device follows it." : source === "device" ? "Set for this device only." : "Following the default. Choose one and every device follows it.";
}

export function appearanceRefusal(code: string | undefined, message: string): string {
  return code === "bad_input" ? "Vyre does not know that theme." : message || "The setting did not save.";
}
