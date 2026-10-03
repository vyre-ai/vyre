import { Pressable, View } from "react-native";
import { cva } from "class-variance-authority";
import { cn } from "../lib/cn";
import { Text } from "./Text";
import { Icon, type IconName } from "./Icon";

const chip = cva("flex-row items-center self-start gap-s1 rounded-chip px-s2 min-h-s6", {
  variants: {
    tone: { plain: "bg-hover", accent: "bg-accent-wash", ok: "bg-ok-wash", warn: "bg-warn-wash", sealed: "bg-warn-wash", err: "bg-err-wash", space: "bg-accent-wash" },
  },
  defaultVariants: { tone: "plain" },
});
const ink = { plain: "muted", accent: "accent", ok: "ok", warn: "warn", sealed: "warn", err: "err", space: "muted" } as const;

/**
 * A small label. "sealed" is the only warm chip; "space" takes the space's row tint on its outline. With `onPress` it is a toggle (filters, kinds):
 * `selected` turns it to the accent wash, and the state is also in its accessibility state, so colour is never the only signal.
 */
export function Chip({ children, tone = "plain", icon, className, onPress, selected }: { children: string; tone?: keyof typeof ink; icon?: IconName; className?: string; onPress?: () => void; selected?: boolean }) {
  const t = selected ? "accent" : tone;
  const body = (
    <View className={cn(chip({ tone: t }), t === "space" && "border border-accent", onPress && "border border-transparent", selected && "border-accent", className)}>
      {icon ? <Icon name={icon} size={12} tone={t === "plain" ? "text-2" : t === "sealed" ? "warn" : t === "space" ? "text-2" : t} /> : null}
      <Text size="caption" strong tone={ink[t]}>{children}</Text>
    </View>
  );
  return onPress ? <Pressable accessibilityRole="button" accessibilityState={{ selected: !!selected }} onPress={onPress} className="self-start">{body}</Pressable> : body;
}
