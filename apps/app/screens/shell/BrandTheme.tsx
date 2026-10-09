// The space's brand as its theme (core/brand): the primary colour becomes the space accent, the density and font follow, and the theme's own guard still moves a colour that cannot be read.
// Drawn once the box answers; nothing here reads or keeps the profile beyond the theme. A person's own appearance choices (dark or paper, their density) still sit on top.
import { useEffect } from "react";
import { allowsMock, useAppearance } from "@vyre/ui";
import { tool } from "../../src/real/box";

export function BrandTheme() {
  useEffect(() => {
    if (allowsMock()) return;
    let live = true;
    tool<{ theme?: { accent?: string; hex?: string; density?: string; font?: string } }>("brand.resolve", {})
      .then((b) => { if (live && b.theme && Object.keys(b.theme).length) useAppearance.getState().setSpace(b.theme); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return null;
}
