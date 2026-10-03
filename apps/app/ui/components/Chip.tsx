import { View } from "react-native";
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

/** A small label. "sealed" is the only warm chip; "space" takes the space's row tint on its outline. */
export function Chip({ children, tone = "plain", icon, className }: { children: string; tone?: keyof typeof ink; icon?: IconName; className?: string }) {
  return (
    <View className={cn(chip({ tone }), tone === "space" && "border border-accent", className)}>
      {icon ? <Icon name={icon} size={12} tone={tone === "plain" ? "text-2" : tone === "sealed" ? "warn" : tone === "space" ? "text-2" : tone} /> : null}
      <Text size="caption" strong tone={ink[tone]}>{children}</Text>
    </View>
  );
}
