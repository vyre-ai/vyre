// The Kits of this space as list blocks: the installed ones (Update, and a held Remove) and the ones on offer (Read the card).
import { BlockScreen, type BlockScreenData } from "@vyre/ui";
import { availableRows, installedRows, type KitRow, type LibraryKit } from "./kits-model";

const one = (id: string, rows: unknown[]): BlockScreenData => ({ v: 2, id, layout: { block: "k" }, blocks: { k: { type: "list", content: { rows } } } });

export function InstalledKits({ shown, newer, busy, onUpdate, onRemove }: { shown: KitRow[]; newer: Record<string, number>; busy: boolean; onUpdate: (k: KitRow) => void; onRemove: (k: KitRow) => void }) {
  const find = (id: unknown) => shown.find((k) => k.id === String(id));
  return <BlockScreen screen={one("installed-kits", installedRows(shown, newer))} handlers={{ act: (_b, action, id) => { const k = find(id); if (!k || busy) return; if (action === "update") onUpdate(k); else if (action === "remove") onRemove(k); } }} />;
}

export function AvailableKits({ offer, loadingCard, onRead }: { offer: LibraryKit[]; loadingCard: string; onRead: (k: LibraryKit) => void }) {
  return <BlockScreen screen={one("available-kits", availableRows(offer, loadingCard))} handlers={{ act: (_b, _action, id) => { const k = offer.find((x) => x.id === String(id)); if (k && !loadingCard) onRead(k); } }} />;
}
