// @ts-check
// The one place the app reads and writes a frame's type name. On the wire a type carries a prefix (`session.user-message`); the engine renames it to `chat.` in one commit (CONTRACT-one-chat.md
// section 3), and that commit is an edit to PREFIX here. Reading accepts either prefix, so a box on either side of the rename works.

/** The prefix the wire's frame types carry (the engine renamed session. to chat. in E3; reading accepts both). */
export const PREFIX = "chat.";

/** The kind of a frame type: `session.text-done` and `chat.text-done` are both "text-done". @param {string} type */
export const kindOf = (type) => String(type).replace(/^(?:session|chat)\./, "");

/** The wire type of a kind. @param {string} kind */
export const typeOf = (kind) => `${PREFIX}${kind}`;

/** Is this frame of that kind? @param {{ type?: string } | null | undefined} f @param {string} kind */
export const isKind = (f, kind) => Boolean(f) && typeof f?.type === "string" && kindOf(f.type) === kind;
