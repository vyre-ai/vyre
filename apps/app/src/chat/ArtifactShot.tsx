// A picture the agent made or a screenshot its browser tool took, shown inline in the chat where it happened (0.3.3 G25); a tap opens it as the artifact. The bytes are read from the box once
// (artifacts.media.read, a person's own call); a picture too large for one read stays the plain link.
import { useEffect, useState } from "react";
import { Image, Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { Icon, Text, useUiTheme } from "@vyre/ui";
import { tool } from "../real/box";

export function ArtifactShot({ id, mime, title, href, wide }: { id: string; mime: string; title: string; href: string; wide: boolean }) {
  const router = useRouter();
  const { color } = useUiTheme();
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void tool<{ bytes_b64?: string; mime?: string; eof?: boolean }>("artifacts.media.read", { id, offset: 0, length: 4 * 1024 * 1024 }).then((r) => { if (live && r.bytes_b64 && r.eof) setUri(`data:${r.mime || mime};base64,${r.bytes_b64}`); }).catch(() => undefined);
    return () => { live = false; };
  }, [id, mime]);
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={`Open ${title}`} onPress={() => router.push(href as never)} style={{ gap: 6, minHeight: 44 }}>
      {uri ? <Image accessibilityLabel={title} source={{ uri }} resizeMode="contain" style={{ width: "100%", height: wide ? 320 : 220, borderRadius: 10, backgroundColor: color.hover }} /> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Icon name="file" /><Text size="caption" tone="muted" numberOfLines={1}>{title}</Text></View>
    </Pressable>
  );
}
