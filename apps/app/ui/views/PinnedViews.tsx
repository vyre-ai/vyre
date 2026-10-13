import { createElement, useState } from "react";
import { Platform, View } from "react-native";
import { Button } from "../components/Button";
import { Field } from "../components/Field";
import { Menu } from "../components/Menu";
import { Row } from "../components/Row";
import { Sheet } from "../components/Sheet";
import { pinnedViews } from "./saved-views.js";

export type PinnedEntry = { kind: "view"; id: string; label: string; href: string; icon?: string; hidden?: boolean };

/** A row a mouse can drag on the web; elsewhere the menu's Move up and Move down do the same. */
function Draggable({ id, onDropOn, children }: { id: string; onDropOn: (from: string, to: string) => void; children: React.ReactNode }) {
  if (Platform.OS !== "web") return <>{children}</>;
  return createElement("div", {
    draggable: true,
    onDragStart: (e: DragEvent) => { e.dataTransfer?.setData("text/plain", id); },
    onDragOver: (e: DragEvent) => e.preventDefault(),
    onDrop: (e: DragEvent) => { e.preventDefault(); const from = e.dataTransfer?.getData("text/plain"); if (from && from !== id) onDropOn(from, id); },
  }, children);
}

/**
 * The views a person pinned under Records, in their order: the visible `view` entries whose href is a records page. Drag one onto another to reorder (onMove(id, beforeId)); the menu renames
 * (onRename) or unpins (onUnpin), and moves up or down where there is no mouse. The caller applies the change to the sidebar list (saved-views.js reorderPinned, renameView, unpinList) and mounts this
 * in the Records panel; this draws rows only.
 */
export function PinnedViews({ entries, onMove, onRename, onUnpin, onOpen }: { entries: readonly PinnedEntry[]; onMove: (id: string, beforeId: string) => void; onRename: (id: string, label: string) => void; onUnpin: (id: string) => void; onOpen?: (href: string) => void }) {
  const pins = pinnedViews(entries as any[]) as PinnedEntry[];
  const [editing, setEditing] = useState<PinnedEntry | null>(null);
  const [name, setName] = useState("");
  if (!pins.length) return null;
  return (
    <View>
      {pins.map((e, i) => (
        <Draggable key={e.id} id={e.id} onDropOn={onMove}>
          <Row dense title={e.label} onPress={onOpen ? () => onOpen(e.href) : undefined}
            end={<Menu trigger={<Button size="sm" kind="ghost" label="More" />} items={[
              { label: "Rename", onPress: () => { setName(e.label); setEditing(e); } },
              ...(i > 0 ? [{ label: "Move up", onPress: () => onMove(e.id, pins[i - 1].id) }] : []),
              ...(i < pins.length - 1 ? [{ label: "Move down", onPress: () => onMove(pins[i + 1].id, e.id) }] : []),
              { label: "Unpin", danger: true, onPress: () => onUnpin(e.id) },
            ]} />} />
        </Draggable>
      ))}
      <Sheet open={!!editing} onClose={() => setEditing(null)} title="Rename view">
        <View className="gap-s3">
          <Field label="Name" value={name} onChangeText={setName} />
          <View className="flex-row gap-s2">
            <Button kind="primary" label="Rename" disabled={!name.trim()} onPress={() => { if (editing) onRename(editing.id, name.trim()); setEditing(null); }} />
            <Button kind="ghost" label="Cancel" onPress={() => setEditing(null)} />
          </View>
        </View>
      </Sheet>
    </View>
  );
}
