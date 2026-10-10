// Everything that can reach your spaces: one list block, a row each with its face, what it may do and since when. Remove says what it does in a sheet first, then asks.
import { BlockScreen, EmptyState, type BlockScreenData } from "@vyre/ui";
import { Card } from "@vyre/ui";
import type { AccessItem } from "./data";
import { accessRows } from "./wink.js";

export function AccessList({ rows, empty, onRemove }: { rows: AccessItem[]; empty: string; onRemove: (a: AccessItem) => void }) {
  if (!rows.length) return <Card flush><EmptyState title="Nothing here" body={empty} /></Card>;
  const screen: BlockScreenData = { v: 2, id: "access", layout: { block: "a" }, blocks: { a: { type: "list", content: { rows: accessRows(rows as never) } } } };
  return <BlockScreen screen={screen} handlers={{ act: (_b, action, id) => { const a = rows.find((x) => x.id === String(id)); if (a && action === "remove") onRemove(a); } }} />;
}
