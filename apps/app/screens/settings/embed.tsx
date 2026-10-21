// A settings page's own chrome, or a plain stack when that page is a section of another.
import { View } from "react-native";
import { Frame, Page, type FrameProps } from "../places/Frame";

export function EmbedPage({ embedded, ...rest }: FrameProps & { embedded?: boolean }) {
  if (embedded) return <View className="gap-s4">{rest.children}</View>;
  return <Page {...rest} />;
}

export function EmbedFrame({ embedded, ...rest }: FrameProps & { embedded?: boolean }) {
  if (embedded) return <View className="gap-s4">{rest.children}</View>;
  return <Frame {...rest} />;
}
