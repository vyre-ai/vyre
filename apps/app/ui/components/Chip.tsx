import { Pressable, View } from "react-native";
import { cva } from "class-variance-authority";
import { cn } from "../lib/cn";
import { Text } from "./Text";
import { Icon, type IconName } from "./Icon";
import { useUiTheme } from "../theme";

const chip = cva("flex-row items-center self-start gap-s1 rounded-chip px-s2", {
  variants: {
    tone: { plain: "bg-hover", accent: "bg-accent-wash", ok: "bg-ok-wash", warn: "bg-warn-wash", sealed: "bg-warn-wash", err: "bg-err-wash", space: "bg-accent-wash" },
  },
  defaultVariants: { tone: "plain" },
});
const ink = { plain: "muted", accent: "accent", ok: "ok", warn: "warn", sealed: "warn", err: "err", space: "muted" } as const;

/**
 * A chip says one fact that changes what the person does (ui-system.md section 3): a state or a close deadline, never the space (that is the avatar
 * badge), the type, the stage, who asked or a count. At most two on a card or row: AskCard and the screens cap them. 24 high (26 on a phone), padding
 * 0 8, radius 6, caption role at weight 500. "sealed" is the only warm chip; "space" is kept for the one place that still names a space in words. With `onPress` it is a toggle (filters, kinds):
 * `selected` turns it to the accent wash, and the state is also in its accessibility state, so colour is never the only signal.
 */
export function Chip({ children, tone = "plain", icon, className, onPress, selected }: { children: string; tone?: keyof typeof ink; icon?: IconName; className?: string; onPress?: () => void; selected?: boolean }) {
  const { phone } = useUiTheme();
  const t = selected ? "accent" : tone;
  const body = (
    <View style={{ minHeight: phone ? 26 : 24 }} className={cn(chip({ tone: t }), onPress && "border border-transparent", selected && "border-accent", className)}>
      {icon ? <Icon name={icon} size={12} tone={t === "plain" ? "text-2" : t === "sealed" ? "warn" : t === "space" ? "text-2" : t} /> : null}
      <Text size="caption" medium tone={ink[t]}>{children}</Text>
    </View>
  );
  return onPress ? <Pressable accessibilityRole="button" accessibilityState={{ selected: !!selected }} onPress={onPress} className="self-start">{body}</Pressable> : body;
}
