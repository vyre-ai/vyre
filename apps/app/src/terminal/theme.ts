// The terminal's colours from the app's tokens: background, text, cursor and selection are the roles; the sixteen ANSI colours are a
// restrained set that reads on both the dark and the paper surface (a real terminal needs its reds and greens: ls, git and test runners
// use them to carry meaning). The Deck's terminal folds ANSI onto bone; the app does not, so a coloured diff or test run stays readable.
export type XtermTheme = Record<string, string>;

const DARK = { black: "#3A3733", red: "#E08A7E", green: "#9CC49B", yellow: "#D9C27A", blue: "#8FB1E0", magenta: "#C3A2D6", cyan: "#86C5C8", white: "#B3AEA4",
  brightBlack: "#6B665D", brightRed: "#F0A398", brightGreen: "#B5DCB4", brightYellow: "#EBD795", brightBlue: "#A9C6EE", brightMagenta: "#D6BAE6", brightCyan: "#A2DADD", brightWhite: "#F1EEE6" };
const PAPER = { black: "#141311", red: "#A63A2E", green: "#2F6B3A", yellow: "#8A6A12", blue: "#2D5A9E", magenta: "#7A3F96", cyan: "#1F6B70", white: "#6B665D",
  brightBlack: "#4A463F", brightRed: "#C4503F", brightGreen: "#3F8A4D", brightYellow: "#A47F1A", brightBlue: "#4673B8", brightMagenta: "#955CB0", brightCyan: "#2E8A90", brightWhite: "#141311" };

/** @param color the resolved tokens by role (useUiTheme().color) @param scheme "dark" | "paper" */
export function termTheme(color: Record<string, string>, scheme: "dark" | "paper"): XtermTheme {
  const bg = color["code-bg"] || (scheme === "dark" ? "#121110" : "#FBFAF6");
  return { background: bg, foreground: color.text || (scheme === "dark" ? "#F1EEE6" : "#141311"), cursor: color.focus || color.text, cursorAccent: bg,
    selectionBackground: color["rule-strong"] || "#3A3733", ...(scheme === "dark" ? DARK : PAPER) };
}

export const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
