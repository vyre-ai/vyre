import { View } from "react-native";
import { Avatar, AvatarStack, type AvatarRef } from "./Avatar";
import { Icon } from "./Icon";
import { Text } from "./Text";
import { PressableScale } from "../motion/PressableScale";
import { useUiTheme } from "../theme";
import { px } from "../lib/measure";

/**
 * The header of every pushed page (ui-system.md section 7): one row, 56 high, a back chevron (44 target), up to three faces (or one emblem) with "+N" past
 * three, the title on one line (headline role, truncated) and one context line under it (caption, truncated: "Jane Doe · Harlow Legal"). No chips, no actions, no
 * status. Top-level pages (Now, Chat, Projects) keep the large title instead. `onPress` makes the whole header open the About sheet, only where a page has one.
 */
export function PageHeader({ title, context, faces = [], onBack, onPress }: { title: string; context?: string; faces?: AvatarRef[]; onBack?: () => void; onPress?: () => void }) {
  const { map, phone } = useUiTheme();
  const height = px(map, "--s-12") + px(map, "--s-2");
  const emblem = faces.length === 1 && (faces[0].kind === "project" || faces[0].kind === "space");
  const size = emblem ? (phone ? 32 : 40) : 28;
  const text = (
    <View className="min-w-0 flex-1">
      <Text strong size="headline" numberOfLines={1} accessibilityRole="header">{title}</Text>
      {context ? <Text size="caption" tone="label" numberOfLines={1}>{context}</Text> : null}
    </View>
  );
  const marks = faces.length ? (
    <View className="flex-none">
      {faces.length === 1 ? <Avatar of={faces[0]} size={size as 28} /> : <AvatarStack of={faces} size={28} max={3} />}
    </View>
  ) : null;
  return (
    <View style={{ minHeight: height }} className="flex-row items-center gap-s2 pr-s4">
      <PressableScale accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} className="h-touch w-touch flex-none items-center justify-center" depth={0.9}>
        <Icon name="chevron-left" size={24} tone="text" />
      </PressableScale>
      {onPress ? (
        <PressableScale accessibilityRole="button" accessibilityLabel={`${title}. About this`} onPress={onPress} depth={0.99} className="min-w-0 flex-1 flex-row items-center gap-s3">
          {marks}{text}<Icon name="chevron" size={16} tone="faint" />
        </PressableScale>
      ) : (
        <View className="min-w-0 flex-1 flex-row items-center gap-s3">{marks}{text}</View>
      )}
    </View>
  );
}
