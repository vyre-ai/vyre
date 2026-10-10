// What is connected: one list block, a row each, with what it is, how it is doing and where it lives. A connection that needs attention is a chip with the reason. Tapping a row opens its own tab.
import { BlockScreen, type BlockScreenData } from "@vyre/ui";
import { connectedRows, type Connected } from "./any-app";

export function ConnectedList({ list, onOpen }: { list: Connected[]; onOpen: (c: Connected) => void }) {
  const screen: BlockScreenData = { v: 2, id: "connected", layout: { block: "connected" }, blocks: { connected: { type: "list", props: { density: "tight" }, content: { rows: connectedRows(list) } } } };
  return <BlockScreen screen={screen} handlers={{ open: (_b, row) => { const c = list.find((x) => x.key === String(row.id)); if (c) onOpen(c); } }} />;
}
