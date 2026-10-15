// @ts-check
// What the first-run proof reads off the app's screens, as pure functions so a test can hold them to what the app prints.

/** The one-time setup code in the install line the app shows (`... | VYRE_CODE=<code> VYRE_STORE=auto sh`), or "". @param {string} text */
export function codeFromInstallLine(text) {
  const m = /\bVYRE_CODE=([A-Za-z0-9-]+)/.exec(String(text ?? ""));
  return m ? m[1] : "";
}

/** The words a screen shows under "Words on this screen", from the page's text: the four lower-case words after the label. @param {string} text @returns {string[]} */
export function wordsFromPage(text) {
  const m = /Words on this screen\s+((?:[a-z]+\s+){3}[a-z]+)/.exec(String(text ?? "").replace(/\s+/g, " ") + " ");
  return m ? m[1].trim().split(/\s+/) : [];
}

/** True when a page's text shows this screen's title. @param {string} text @param {string} title */
export const shows = (text, title) => String(text ?? "").replace(/\s+/g, " ").includes(title);
