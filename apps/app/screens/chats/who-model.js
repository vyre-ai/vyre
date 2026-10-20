// @ts-check
// The side pane's small facts, pure so Node can test them: what kinds of who there are, the line under a name, and how a chat's title says which who it is with.

/** @typedef {"assistant" | "agent" | "person" | "group"} WhoKind */

/** The quiet line under a name in the pane. @param {WhoKind} kind */
export function whoLabel(kind) {
  return kind === "person" ? "Person" : kind === "group" ? "Group" : kind === "assistant" ? "Your assistant" : "Agent";
}

/**
 * Who the name and avatar in a chat's title open the pane for: the one other face of a one-to-one chat (an assistant, an agent or a person), or the group when there are several. Null when there is no one to open.
 * @param {readonly { id: string, name: string, family: string }[]} faces the chat's participants @param {string} viewer the viewer's id @param {string} chat the chat's id
 * @returns {{ kind: WhoKind, id: string } | null}
 */
export function whoOfChat(faces, viewer, chat) {
  const others = faces.filter((f) => f.id !== viewer && f.name !== "You");
  if (others.length > 1) return { kind: "group", id: chat };
  const o = others[0];
  if (!o) return null;
  if (o.family === "person") return { kind: "person", id: o.id };
  if (o.family === "assistant") return { kind: o.id.startsWith("agent:") ? "agent" : "assistant", id: o.id.replace(/^(agent|assistant):/, "") };
  return null;
}
