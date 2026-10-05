// Web: the page a version rendered, in a sandboxed frame with its own origin, or media as itself. Whatever the page shows inside its border is untrusted and labelled by the screen.
import { createElement, useEffect, useState } from "react";
import { View } from "react-native";
import { Text } from "@vyre/ui";
import { BLANK_FRAME_TEXT, FRAME_SANDBOX, MEDIA_KINDS, frameLoaded, frameStart, mediaPath, renderPath } from "./more-model.ts";

export function ArtifactFrame({ id, v, title, kind, onLeft }: { id: string; v: number; title: string; kind: string; onLeft?: () => void }) {
  const [state, setState] = useState(frameStart);
  useEffect(() => setState(frameStart()), [id, v]);
  useEffect(() => { if (state.left) onLeft?.(); }, [state.left]);
  if (MEDIA_KINDS.has(kind)) {
    const src = mediaPath(id);
    const el = kind === "video" ? createElement("video", { src, controls: true, preload: "metadata", "aria-label": title, style: { width: "100%", borderRadius: 8 } })
      : kind === "audio" ? createElement("audio", { src, controls: true, preload: "metadata", "aria-label": title, style: { width: "100%" } })
      : createElement("img", { src, alt: title, loading: "lazy", style: { width: "100%", borderRadius: 8 } });
    return <View>{el}</View>;
  }
  if (state.left) return <View style={{ height: 120, justifyContent: "center" }}><Text tone="muted">{BLANK_FRAME_TEXT}</Text></View>;
  // No allow-same-origin: the page runs on an opaque origin and cannot reach the box's session. A second load means the page sent the frame elsewhere (see frameLoaded).
  return <View style={{ height: 520 }}>{createElement("iframe", { key: `${id}:${v}`, src: renderPath(id, v), title, sandbox: FRAME_SANDBOX, referrerPolicy: "no-referrer", onLoad: () => setState(frameLoaded), style: { border: 0, width: "100%", height: "100%", borderRadius: 8 } })}</View>;
}
