// The assistants of this space: one list block, a row each with its face, what it does, a Paused chip and Pause or Resume. Tapping a row opens its page.
import { BlockScreen, type BlockScreenData } from "@vyre/ui";
import { assistantRows, type Agent } from "./agents-model";

export function AssistantsList({ list, busy, onFlip, onOpen }: { list: Agent[]; busy: string | null; onFlip: (a: Agent) => void; onOpen: (a: Agent) => void }) {
  const screen: BlockScreenData = { v: 2, id: "assistants", layout: { block: "a" }, blocks: { a: { type: "list", content: { rows: assistantRows(list) } } } };
  const find = (id: unknown) => list.find((a) => a.name === String(id));
  return <BlockScreen screen={screen} handlers={{ open: (_b, row) => { const a = find(row.id); if (a) onOpen(a); }, act: (_b, _action, id) => { const a = find(id); if (a && busy !== a.name) onFlip(a); } }} />;
}
