// @ts-check
// The words the server's terminal says while it pairs: the installer (scripts/install-box.sh pair_server) and `vyre up` (core/cli/commands/pair-here.js) say the same sentences, and
// test/install-box-pair.test.js keeps the installer's copy equal to these. Plain sentences, no jargon; `{code}`, `{minutes}`, `{tries}` and `{long}` are filled in.
export const PAIR_WORDS = Object.freeze({
  intro: "  Pair this server from your Vyre app: scan this with your phone,",
  introPaste: "  or paste the long code into the app on a computer.",
  longCode: "  Long code: {long}",
  longLife: "  It is good for five minutes.",
  typed: "  Or type this code in your app: {code}",
  typedLife: "  The typed code is good for {minutes} minutes and closes after {tries} wrong tries.",
  typedFound: "  Your app typed the code and now shows a code of its own.",
  prompt: "Type the code your app shows: ",
  matched: "  The codes match. Your app finishes the pairing.",
  unfinished: "  The app did not finish the pairing, so nothing was paired.",
  wrong: "  That is not the code your app shows, so this typed code is closed.",
  newCode: "  A new typed code is showing: {code}  (good for {minutes} minutes)",
  closed: "  The typed code closed: its time ran out, or it had {tries} wrong tries.",
  asking: "  {name} is asking to pair this server. Pick the three words your app shows:",
  pickPrompt: "Which one? (1, 2 or 3, Enter to refuse) ",
  refused: "  Refused. Nothing was paired.",
  wrongWords: "  Those were not the words the app shows, so nothing was paired.",
  ranOut: "  The code ran out before a device asked. Nothing was paired.",
});

/** @param {string} sentence @param {Record<string, string | number>} [v] */
export const say = (sentence, v = {}) => sentence.replace(/\{(\w+)\}/g, (_, k) => (k in v ? String(v[k]) : `{${k}}`));
