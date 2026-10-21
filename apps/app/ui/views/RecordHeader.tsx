import type { ReactNode } from "react";
import { View } from "react-native";
import { Button, IconButton } from "../components/Button";
import { Menu, type MenuItem } from "../components/Menu";
import { PageHeader } from "../components/PageHeader";
import { Text } from "../components/Text";
import type { AvatarRef } from "../components/Avatar";
import { copyAndTell } from "../records/clipboard";
import { QuietIcon } from "./QuietIcon";

/**
 * The record page's header: the face, the name, and one quiet line ("Contact · Juniper Studio") that ends with the record's ID.
 * The gallery card header is ui/records/RecordHeader.tsx. This one is the page.
 */
export function RecordHeader({ title, context, id, faces, onBack, onChat, menu }: {
  title: string; context?: string; /** The record's ID (PER-0001). Empty until the record has one: then the line does not show it. */ id?: string;
  faces?: AvatarRef[]; onBack?: () => void; onChat: () => void; menu: MenuItem[];
}) {
  const extra = id ? (
    <View className="flex-none flex-row items-center gap-s1">
      <Text size="caption" tone="faint" mono numberOfLines={1}>{id}</Text>
      <QuietIcon icon="copy" label="Copy ID" visible onPress={() => void copyAndTell(id)} />
    </View>
  ) : null;
  const actions: ReactNode = (
    <View className="flex-row items-center gap-s2">
      <Button kind="secondary" size="sm" label="Chat about this" onPress={onChat} />
      <Menu align="end" trigger={<IconButton icon="more" label="More" />} items={menu} />
    </View>
  );
  return <PageHeader title={title} context={context} contextExtra={extra} faces={faces} onBack={onBack} actions={actions} />;
}
