import { View } from "react-native";
import { cn } from "../lib/cn";
import { Text } from "./Text";
import { Icon } from "./Icon";

/** A quiet status line: plain, warn or err. */
export function Banner({ tone = "plain", children }: { tone?: "plain" | "warn" | "err"; children: React.ReactNode }) {
  return (
    <View accessibilityRole="alert" className={cn("flex-row items-center gap-s3 rounded-card border px-s4 py-s3", tone === "plain" ? "border-edge bg-surface-3" : tone === "warn" ? "border-transparent bg-warn-wash" : "border-transparent bg-err-wash")}>
      <Icon name={tone === "plain" ? "check" : "failed"} tone={tone === "plain" ? "text-2" : tone} />
      <View className="min-w-0 flex-1">{typeof children === "string" ? <Text>{children}</Text> : children}</View>
    </View>
  );
}
