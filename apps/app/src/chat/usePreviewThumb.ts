// The picture on a preview's card: asked of the box (previews.thumb) when the card appears and whenever the card says a new one was taken. None until the first is taken (no browser on the box, or it is not up yet).
import { useEffect, useState } from "react";
import { allowsMock, useUiTheme } from "@vyre/ui";
import { tool } from "../real/box";

/** The sample world has no box and no browser: a stand-in picture of a form, so the card can be seen the way it looks with a real one. */
const sample = (c: Record<string, string>) => "data:image/svg+xml;base64," + (typeof btoa === "function" ? btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500"><rect width="800" height="500" fill="${c.bg}"/><rect x="0" y="0" width="800" height="64" fill="${c.accent}"/><text x="40" y="40" font-family="sans-serif" font-size="22" font-weight="600" fill="${c.bg}">Juniper Studio</text><text x="40" y="130" font-family="sans-serif" font-size="30" font-weight="700" fill="${c.text}">Tell us about your case</text><text x="40" y="168" font-family="sans-serif" font-size="16" fill="${c.label}">It takes about two minutes.</text><rect x="40" y="200" width="720" height="48" rx="8" fill="${c.bg}" stroke="${c.edge}"/><text x="56" y="231" font-family="sans-serif" font-size="16" fill="${c.label}">Your name</text><rect x="40" y="266" width="350" height="48" rx="8" fill="${c.bg}" stroke="${c.edge}"/><text x="56" y="297" font-family="sans-serif" font-size="16" fill="${c.label}">Date of the incident</text><rect x="410" y="266" width="350" height="48" rx="8" fill="${c.bg}" stroke="${c.edge}"/><text x="426" y="297" font-family="sans-serif" font-size="16" fill="${c.label}">Phone</text><rect x="40" y="340" width="160" height="48" rx="24" fill="${c.accent}"/><text x="78" y="371" font-family="sans-serif" font-size="17" font-weight="600" fill="${c.bg}">Send it</text></svg>`) : "");

export function usePreviewThumb(id: string, taken: number): string | null {
  const { color } = useUiTheme();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (allowsMock() || id === "00000000") { setSrc(allowsMock() ? sample(color) : null); return; }
    let dead = false;
    tool<{ image: string | null; svg?: string }>("previews.thumb", { id }).then((r) => { if (dead) return; if (r.image) setSrc(`data:image/png;base64,${r.image}`); else if (r.svg) setSrc(`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(r.svg)))}`); }).catch(() => {});
    return () => { dead = true; };
  }, [id, taken, color]);
  return src;
}
