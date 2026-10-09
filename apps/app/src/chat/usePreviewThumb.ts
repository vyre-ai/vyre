// The picture on a preview's card: asked of the box (previews.thumb) when the card appears and whenever the card says a new one was taken. None until the first is taken (no browser on the box, or it is not up yet).
import { useEffect, useState } from "react";
import { allowsMock } from "@vyre/ui";
import { tool } from "../real/box";

/** The sample world has no box and no browser: a stand-in picture of a form, so the card can be seen the way it looks with a real one. */
const SAMPLE = "data:image/svg+xml;base64," + (typeof btoa === "function" ? btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500"><rect width="800" height="500" fill="#faf9f6"/><rect x="0" y="0" width="800" height="64" fill="#1f3a5f"/><text x="40" y="40" font-family="sans-serif" font-size="22" font-weight="600" fill="#fff">Juniper Studio</text><text x="40" y="130" font-family="sans-serif" font-size="30" font-weight="700" fill="#171716">Tell us about your case</text><text x="40" y="168" font-family="sans-serif" font-size="16" fill="#6a675f">It takes about two minutes.</text><rect x="40" y="200" width="720" height="48" rx="8" fill="#fff" stroke="#dcd9d1"/><text x="56" y="231" font-family="sans-serif" font-size="16" fill="#9a968c">Your name</text><rect x="40" y="266" width="350" height="48" rx="8" fill="#fff" stroke="#dcd9d1"/><text x="56" y="297" font-family="sans-serif" font-size="16" fill="#9a968c">Date of the incident</text><rect x="410" y="266" width="350" height="48" rx="8" fill="#fff" stroke="#dcd9d1"/><text x="426" y="297" font-family="sans-serif" font-size="16" fill="#9a968c">Phone</text><rect x="40" y="340" width="160" height="48" rx="24" fill="#4b3fcf"/><text x="78" y="371" font-family="sans-serif" font-size="17" font-weight="600" fill="#fff">Send it</text></svg>`) : "");

export function usePreviewThumb(id: string, taken: number): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (allowsMock() || id === "00000000") { setSrc(allowsMock() ? SAMPLE : null); return; }
    let dead = false;
    tool<{ image: string | null }>("previews.thumb", { id }).then((r) => { if (!dead && r.image) setSrc(`data:image/png;base64,${r.image}`); }).catch(() => {});
    return () => { dead = true; };
  }, [id, taken]);
  return src;
}
