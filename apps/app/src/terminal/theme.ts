// The terminal's colours from the app's tokens: background, text, cursor and selection are the roles; the sixteen ANSI colours are a
// restrained set that reads on both the dark and the paper surface (a real terminal needs its reds and greens: ls, git and test runners
// use them to carry meaning). The Deck's terminal folds ANSI onto bone; the app does not, so a coloured diff or test run stays readable.
import { tokens } from "../theme/tokens";
import { ANSI_DARK, ANSI_PAPER } from "./palettes";
export type XtermTheme = Record<string, string>;


/** @param color the resolved tokens by role (useUiTheme().color) @param scheme "dark" | "paper" */
export function termTheme(color: Record<string, string>, scheme: "dark" | "paper"): XtermTheme {
  const base = tokens.color[scheme];
  const bg = color["code-bg"] || base.codeBg;
  return { background: bg, foreground: color.text || base.text, cursor: color.focus || color.text, cursorAccent: bg,
    selectionBackground: color["rule-strong"] || base.ruleStrong, ...(scheme === "dark" ? ANSI_DARK : ANSI_PAPER) };
}

export const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
