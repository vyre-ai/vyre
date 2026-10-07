// The terminal's literal colours, and the only place in the app besides the avatar art (ui/marks/source.js) allowed to hold them
// (src/theme/raw-colours.test.js lists both). A terminal needs its reds and greens: ls, git and test runners use them to carry meaning,
// so these are not roles from the token file. Everything else in a terminal (background, text, cursor, selection) comes from the tokens.

export const ANSI_DARK = { black: "#3A3733", red: "#E08A7E", green: "#9CC49B", yellow: "#D9C27A", blue: "#8FB1E0", magenta: "#C3A2D6", cyan: "#86C5C8", white: "#B3AEA4",
  brightBlack: "#6B665D", brightRed: "#F0A398", brightGreen: "#B5DCB4", brightYellow: "#EBD795", brightBlue: "#A9C6EE", brightMagenta: "#D6BAE6", brightCyan: "#A2DADD", brightWhite: "#F1EEE6" };
export const ANSI_PAPER = { black: "#141311", red: "#A63A2E", green: "#2F6B3A", yellow: "#8A6A12", blue: "#2D5A9E", magenta: "#7A3F96", cyan: "#1F6B70", white: "#6B665D",
  brightBlack: "#4A463F", brightRed: "#C4503F", brightGreen: "#3F8A4D", brightYellow: "#A47F1A", brightBlue: "#4673B8", brightMagenta: "#955CB0", brightCyan: "#2E8A90", brightWhite: "#141311" };

/** The inline terminal block in a chat (always dark, in either scheme): the eight base colours of a parsed ANSI line. */
export const ANSI_BLOCK: Record<string, string> = { black: "#6B665D", red: "#F2796B", green: "#7FD08A", yellow: "#E3B26B", blue: "#8FB7E8", magenta: "#D6A5E8", cyan: "#7BD3D3", white: "#D8D3C8" };
