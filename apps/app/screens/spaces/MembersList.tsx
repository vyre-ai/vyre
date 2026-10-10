// The people in a space: one list block, a row each with their face, their role (or the temp scope and end), and Extend for a temp member you may manage. Tapping a row you may manage opens its role sheet.
import { BlockScreen, type BlockScreenData } from "@vyre/ui";
import type { Member, Teammate } from "./data";
import { memberRows } from "./roles.js";

export function MembersList({ members, can, team = [], onOpen, onExtend }: { members: Member[]; can: (m: Member) => boolean; team?: Teammate[]; onOpen: (m: Member) => void; onExtend: (m: Member) => void }) {
  const screen: BlockScreenData = { v: 2, id: "members", layout: { block: "m" }, blocks: { m: { type: "list", content: { rows: memberRows(members, can, team) } } } };
  const find = (id: unknown) => members.find((m) => m.id === String(id));
  return <BlockScreen screen={screen} handlers={{ open: (_b, row) => { const m = find(row.id); if (m && can(m)) onOpen(m); }, act: (_b, action, id) => { const m = find(id); if (m && action === "extend") onExtend(m); } }} />;
}
