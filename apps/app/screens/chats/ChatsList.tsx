// The list of chats: one list block. Each row shows who is in it (faces), what it is about, where it runs, its state and when it last moved; a row for a chat you are not in is dim and does not open.
import { BlockScreen, type BlockScreenData } from "@vyre/ui";
import { chatRowsOf, type ChatRow } from "./chats-model.js";

export function ChatsList({ rows, now, places, onOpen, tag, menu }: { /** The items of a chat row's own menu (a "..." on hover or focus, a right-click, the menu key). */ menu?: (id: string) => { label: string; onPress: () => void; selected?: boolean }[]; rows: ChatRow[]; now: number; places: unknown; onOpen: (id: string) => void; /** where these chats live (placeTag): each row carries it */ tag?: string | null }) {
  const screen: BlockScreenData = { v: 2, id: "chats", layout: { block: "chats" }, blocks: { chats: { type: "list", content: { ...(tag ? { tag } : {}), rows: chatRowsOf(rows, now, places) } } } };
  return <BlockScreen screen={screen} handlers={{ ...(menu ? { rowMenu: (_b: string, row: any) => { const t = rows.find((x) => x.id === String(row.id)); return t && t.open ? menu(t.id) : []; } } : {}), open: (_b, row) => { const t = rows.find((x) => x.id === String(row.id)); if (t && t.open) onOpen(t.id); } }} />;
}
