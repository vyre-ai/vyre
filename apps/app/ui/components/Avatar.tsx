import { View } from "react-native";
import { cn } from "../lib/cn";
import { Text } from "./Text";

export type AvatarFamily = "person" | "assistant" | "agent" | "teammate" | "device" | "project" | "space";
const SIZES = { sm: 24, md: 32, lg: 40 } as const;

/**
 * Who, as a mark. The person is a circle, everything else a rounded square; an assistant or teammate carries the accent hairline.
 * `tint` draws the space's corner badge. (The generated mark families, ring included, replace the initial when the ports land;
 * the shape, size and badge contract stays.)
 */
export function Avatar({ name, family = "person", size = "md", tint }: { name: string; family?: AvatarFamily; size?: keyof typeof SIZES; tint?: boolean }) {
  const px = SIZES[size];
  return (
    <View accessibilityLabel={name} style={{ width: px, height: px }} className={cn("items-center justify-center border", family === "person" ? "rounded-full bg-hover border-transparent" : "rounded-row bg-surface-3", family === "assistant" || family === "teammate" ? "border-accent" : family === "person" ? "" : "border-edge-strong")}>
      <Text strong size={size === "lg" ? "body" : "caption"}>{(name || "?").slice(0, 1).toUpperCase()}</Text>
      {tint ? <View className="absolute -right-s1 -bottom-s1 h-s3 w-s3 rounded-full border border-surface-2 bg-accent" /> : null}
    </View>
  );
}
