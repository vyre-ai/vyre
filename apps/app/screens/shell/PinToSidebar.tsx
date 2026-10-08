import { useState } from "react";
import { Button, showToast } from "@vyre/ui";
import { MOCK, said, tool } from "../../src/real/box";
import { useSidebar } from "./sidebar";
import { useSpaces } from "./state";

/** "Add to sidebar": keeps this page (a records list or one saved view of it, a project, a Flow) as an entry in this person's own sidebar. Hidden in the sample world, which cannot save one. */
export function PinToSidebar({ id, label, href }: { id: string; label: string; href: string }) {
  const [busy, setBusy] = useState(false);
  const space = useSpaces((s) => s.space);
  const load = useSidebar((s) => s.load);
  const have = useSidebar((s) => s.mine.some((e) => e.kind === "view" && e.id === id && !e.hidden));
  if (MOCK) return null;
  const pin = async () => {
    setBusy(true);
    try {
      await tool("sidebar.edit", { op: "add", scope: "me", entry: { kind: "view", id: id.slice(0, 64).toLowerCase().replace(/[^a-z0-9._-]/g, "-"), label: label.slice(0, 60), href } });
      await load(space);
      showToast(`${label} is in your sidebar.`);
    } catch (e) { showToast(said(e)); } finally { setBusy(false); }
  };
  return <Button kind="ghost" size="sm" icon="pin" label={have ? "In your sidebar" : "Add to sidebar"} disabled={busy || have} onPress={() => void pin()} />;
}
