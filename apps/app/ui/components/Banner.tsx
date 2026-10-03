import { View } from "react-native";
import { cn } from "../lib/cn";
import { Text } from "./Text";
import { Icon, type IconName } from "./Icon";

/** A quiet status line: plain, warn or err. `icon` replaces the default mark (a boundary or an isolation note shows a shield). */
export function Banner({ tone = "plain", icon, children }: { tone?: "plain" | "warn" | "err"; icon?: IconName; children: React.ReactNode }) {
  return (
    <View accessibilityRole="alert" className={cn("flex-row items-center gap-s3 rounded-card border px-s4 py-s3", tone === "plain" ? "border-edge bg-surface-3" : tone === "warn" ? "border-transparent bg-warn-wash" : "border-transparent bg-err-wash")}>
      <Icon name={icon ?? (tone === "plain" ? "check" : "failed")} tone={tone === "plain" ? "text-2" : tone} />
      <View className="min-w-0 flex-1">{typeof children === "string" ? <Text>{children}</Text> : children}</View>
    </View>
  );
}
