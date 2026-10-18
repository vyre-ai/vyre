// @ts-check
// Forward: a message sent into another chat or agent thread as a quoted forward. Pure: the words that are sent.

/** "Forwarded from <chat>", then the message quoted line by line. @param {string} text @param {string} from the chat it came from */
export function forwardText(text, from) {
  const quoted = String(text ?? "").replace(/\r\n/g, "\n").trimEnd().split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
  return `Forwarded from ${String(from || "a chat").trim() || "a chat"}\n\n${quoted}`;
}
