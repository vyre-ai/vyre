// Chat's avatar: app-design's generated marks (people faces, assistant characters) through
// react-native-svg, falling back to @vyre/ui's Avatar for a name with no art. A wrapper only:
// when @vyre/ui's Avatar ports the generators this file shrinks to a re-export.

import { View } from "react-native";
import { SvgXml } from "react-native-svg";
import { Avatar, useUiTheme } from "@vyre/ui";
import { AVATAR_ART } from "./avatar-art.generated";

export type ChatAvatarFamily = "person" | "assistant" | "agent" | "teammate";
const SIZES = { sm: 24, md: 32, lg: 40 } as const;

/** The art for a name: the first word, lowercase ("Alex Rivera" is alex). Pure. */
export function artKey(name: string, family: string, scheme: "dark" | "paper"): string | null {
  const first = (name || "").trim().toLowerCase().split(/[^a-z0-9]+/)[0];
  if (!first) return null;
  const fam = family === "person" ? "person" : "assistant";
  const k = `${fam}/${first}/${scheme}`;
  return AVATAR_ART[k] ? k : null;
}

export function ChatAvatar({ name, family = "person", size = "md" }: { name: string; family?: ChatAvatarFamily; size?: keyof typeof SIZES }) {
  const scheme = useUiTheme().resolved.scheme;
  const key = artKey(name, family, scheme);
  if (!key) return <Avatar name={name} family={family} size={size} />;
  const px = SIZES[size];
  return (
    <View accessibilityLabel={name} style={{ width: px, height: px }}>
      <SvgXml xml={AVATAR_ART[key]} width={px} height={px} />
    </View>
  );
}
