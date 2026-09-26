// @ts-check
// Terminal colour, from the brand tokens. Plain text when stdout is not a terminal, so piping
// `vyre` into anything gets clean output.

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const rgb = (r, g, b) => s => (tty ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m` : String(s));

export const dim = s => (tty ? `\x1b[2m${s}\x1b[0m` : String(s));
export const bold = s => (tty ? `\x1b[1m${s}\x1b[0m` : String(s));
/** Focus and primary action. */
export const signal = rgb(198, 243, 107);
/** Anything that came from memory rather than a model. */
export const recall = rgb(235, 199, 107);
/** Needs the user. Nothing else uses it. */
export const beacon = rgb(255, 122, 89);
export const out = (...a) => console.log(...a);
