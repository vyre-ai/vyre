// @ts-check
// A quiet line from the box can name a person by id, as `{person:<id>}` ("{person:per_x} switched to GPT-5.5": a person's own model pick in a chat, core/switchboard/picks.js), so it reads as their
// name in each viewer's own chat: the box never guesses a name, and a person never reads an id. Pure.

/** The line with each `{person:<id>}` as the name `nameOf` gives it. @param {string} text @param {(id: string) => string} nameOf */
export function personWords(text, nameOf) {
  return String(text ?? "").replace(/\{person:([A-Za-z0-9_.:-]{1,80})\}/g, (_, id) => nameOf(String(id)) || "Someone");
}
