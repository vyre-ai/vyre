// @ts-check
// A draft can hold # tags (a file the person asked about): the word in the text, and what the composer needs to send it as a tag. Only tags whose word is still in the text are kept.

/** @param {string} text @param {{ kind: string, id: string, name: string }[]} mentions */
export function keptMentions(text, mentions) {
  return (mentions || []).filter((m) => m && m.id && m.name && text.includes(`#${m.name}`));
}
