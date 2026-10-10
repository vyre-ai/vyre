// The list of chats: one list block. Each row shows who is in it (faces), what it is about, where it runs, its state and when it last moved; a row for a chat you are not in is dim and does not open.
import { BlockScreen, type BlockScreenData } from "@vyre/ui";
import { chatRowsOf, type ChatRow } from "./chats-model.js";

export function ChatsList({ rows, now, places, onOpen }: { rows: ChatRow[]; now: number; places: unknown; onOpen: (id: string) => void }) {
  const screen: BlockScreenData = { v: 2, id: "chats", layout: { block: "chats" }, blocks: { chats: { type: "list", content: { rows: chatRowsOf(rows, now, places) } } } };
  return <BlockScreen screen={screen} handlers={{ open: (_b, row) => { const t = rows.find((x) => x.id === String(row.id)); if (t && t.open) onOpen(t.id); } }} />;
}
