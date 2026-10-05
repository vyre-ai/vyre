// Web: the page a version rendered, in a sandboxed frame with its own origin, or media as itself. Whatever the page shows inside its border is untrusted and labelled by the screen.
import { createElement } from "react";
import { View } from "react-native";
import { MEDIA_KINDS, mediaPath, renderPath } from "./more-model.ts";

export function ArtifactFrame({ id, v, title, kind }: { id: string; v: number; title: string; kind: string }) {
  if (MEDIA_KINDS.has(kind)) {
    const src = mediaPath(id);
    const el = kind === "video" ? createElement("video", { src, controls: true, preload: "metadata", "aria-label": title, style: { width: "100%", borderRadius: 8 } })
      : kind === "audio" ? createElement("audio", { src, controls: true, preload: "metadata", "aria-label": title, style: { width: "100%" } })
      : createElement("img", { src, alt: title, loading: "lazy", style: { width: "100%", borderRadius: 8 } });
    return <View>{el}</View>;
  }
  // No allow-same-origin: the page runs on an opaque origin and cannot reach the box's session.
  return <View style={{ height: 520 }}>{createElement("iframe", { src: renderPath(id, v), title, sandbox: "allow-scripts", referrerPolicy: "no-referrer", style: { border: 0, width: "100%", height: "100%", borderRadius: 8 } })}</View>;
}
