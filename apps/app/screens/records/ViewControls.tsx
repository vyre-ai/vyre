import { useState } from "react";
import { View } from "react-native";
import { Button, Field, Menu, Sheet, showToast } from "@vyre/ui";
import { pinList, renameView, deleteView, unpinList } from "../../ui/views/saved-views.js";
import { editList, useEffectiveList } from "./views-actions";

/**
 * What a person does with the view they are looking at: pin it to the sidebar (under Records) or unpin it, and, for one they made, rename or delete it. A view of the type that is not theirs (the type's
 * own or one shared with the space) is pinned as a link to it; unpinning takes that link away and leaves the view where it was.
 */
export function ViewControls({ type, viewName, label, personal, space, size }: { type: string; viewName?: string; label: string; personal: boolean; space: string; size: "sm" | "md" }) {
  const list = useEffectiveList();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(label);
  const id = `records-${type}${viewName ? `-${viewName}` : ""}`.slice(0, 64);
  const pinned = list.some((e) => e.kind === "view" && e.id === id && !e.hidden);
  const href = `/u/records/${type}${viewName ? `?view=${encodeURIComponent(viewName)}` : ""}`;
  const toggle = async () => {
    const ok = await editList(space, (l) => (pinned ? (unpinList(l as any, id) as any) : l.some((e) => e.kind === "view" && e.id === id) ? (pinList(l as any, id) as any) : (pinList(l as any, { kind: "view", id, label, href, icon: "records" }) as any)));
    if (ok) showToast(pinned ? `${label} is off your sidebar.` : `${label} is in your sidebar.`);
  };
  return (
    <View className="flex-row items-center gap-s2">
      <Button kind="ghost" size={size} icon="pin" label={pinned ? "Unpin" : "Pin to sidebar"} onPress={() => void toggle()} />
      {personal ? (
        <Menu trigger={<Button kind="ghost" size={size} label="Edit view" />} items={[
          { label: "Rename", onPress: () => { setName(label); setRenaming(true); } },
          { label: "Delete view", danger: true, onPress: () => void editList(space, (l) => deleteView(l as any, id) as any).then((ok) => { if (ok) showToast(`${label} deleted.`); }) },
        ]} />
      ) : null}
      <Sheet open={renaming} onClose={() => setRenaming(false)} title="Rename view">
        <View className="gap-s3">
          <Field label="Name" value={name} onChangeText={setName} />
          <View className="flex-row gap-s2">
            <Button kind="primary" label="Rename" disabled={!name.trim()} onPress={() => { void editList(space, (l) => renameView(l as any, id, name) as any); setRenaming(false); }} />
            <Button kind="ghost" label="Cancel" onPress={() => setRenaming(false)} />
          </View>
        </View>
      </Sheet>
    </View>
  );
}
