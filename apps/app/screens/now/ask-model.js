// The Home ask box: who the words go to, and the thread's title (ask-model.test.js). Pure.

/** `@juno what is open?` goes to juno; anything else goes to the assistant. Only a known agent name counts, so an @ in ordinary text stays in it. @param {string} text @param {string[]} names agent names @param {string} assistant @returns {{ agent: string, text: string }} */
export function route(text, names, assistant) {
  const t = String(text || "").trim();
  const m = /^@([A-Za-z0-9_-]+)\s+([\s\S]+)$/.exec(t);
  if (m) { const hit = names.find((n) => n.toLowerCase() === m[1].toLowerCase()); if (hit) return { agent: hit, text: m[2].trim() }; }
  return { agent: assistant, text: t };
}

/** A thread title from the first words: at most 6 words and 48 characters. @param {string} text */
export function titleOf(text) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  return words.length > 48 ? `${words.slice(0, 47).trimEnd()}…` : words;
}
