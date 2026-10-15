import { useState } from "react";
import { Card, Row, IconTile, showToast } from "@vyre/ui";
import { shell } from "../../src/shell/shell";

/**
 * In the Mac app only: forget this Mac's key. The Mac's own alert asks first and names every server this Mac stops reaching; after the yes the Mac lets go of them all and starts again at the pair-again
 * screen (src/identity/forget-mac.ts). A no leaves everything as it was, and says so.
 */
export function ForgetThisMac() {
  const [busy, setBusy] = useState(false);
  if (!shell()?.identity?.forget) return null;
  const go = async () => {
    setBusy(true);
    try { const { forgetThisMacHere } = await import("../../src/identity/forget-mac"); await forgetThisMacHere(); }
    catch (e) { showToast(e instanceof Error && e.message ? e.message : "Nothing was forgotten."); }
    finally { setBusy(false); }
  };
  return (
    <Card flush>
      <Row dense lead={<IconTile name="key" />} title="Forget this Mac" sub="This Mac lets go of your name and every server it reaches. You can add it again later." onPress={busy ? undefined : () => { void go(); }} chevron />
    </Card>
  );
}
