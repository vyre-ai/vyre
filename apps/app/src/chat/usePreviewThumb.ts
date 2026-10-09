// The picture on a preview's card: asked of the box (previews.thumb) when the card appears and whenever the card says a new one was taken. None until the first is taken (no browser on the box, or it is not up yet).
import { useEffect, useState } from "react";
import { tool } from "../real/box";

export function usePreviewThumb(id: string, taken: number): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    tool<{ image: string | null }>("previews.thumb", { id }).then((r) => { if (!dead && r.image) setSrc(`data:image/png;base64,${r.image}`); }).catch(() => {});
    return () => { dead = true; };
  }, [id, taken]);
  return src;
}
