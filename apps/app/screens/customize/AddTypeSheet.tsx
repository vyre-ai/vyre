import { useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Sheet, Text, TypeStarter, allowsMock, showToast } from "@vyre/ui";
import type { Starter } from "@vyre/ui";
import { listKits, listLibrary, libraryKit, proposeKit } from "../flows/kits";
import { proposeNote } from "../flows/kits-model";
import { TEMPLATES, buildType, kitStarters, templateBlurb, templateName } from "./logic.js";
import { toKernelType } from "./real-model.js";

const TEMPLATE_STARTERS: Starter[] = [
  { id: "blank", label: "Blank", blurb: "Two fields, Name and ID. Add the rest yourself.", fields: ["Name", "ID"] },
  ...TEMPLATES.filter(([id]) => id !== "blank").map(([id, label]) => ({ id, label, blurb: templateBlurb(id), fields: buildType(id, "x", false, "s").fields.map((f: any) => f.label) })),
];

/** Add a type, opened on its templates: Blank, Order, Property and Deal, then the Kits the box offers (each adds ready-made types and asks for a yes in Now). Shared by Records and Settings. */
export function AddTypeSheet({ open, onClose, space, taken, onAdd }: { open: boolean; onClose: () => void; space: string; taken: string[]; onAdd: (type: any, label: string) => void }) {
  const [picked, setPicked] = useState("blank");
  const [name, setName] = useState(templateName("blank"));
  const [work, setWork] = useState(true);
  const [kits, setKits] = useState<Starter[]>([]);
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!open || allowsMock()) return;
    // A box with no Kit library offers none; the templates stand on their own.
    void Promise.all([listLibrary(), listKits().catch(() => [])]).then(([lib, rows]) => setKits(lib ? kitStarters(lib, rows.filter((r) => r.status === "installed" || r.status === "pending").map((r) => r.id)) : [])).catch(() => setKits([]));
  }, [open]);
  const starters = [...TEMPLATE_STARTERS, ...kits];
  const kit = starters.find((s) => s.id === picked)?.from;
  const submit = async () => {
    if (kit) {
      try {
        const r = proposeNote(await proposeKit(await libraryKit(kit)));
        if (r.ok) { onClose(); showToast("Waiting for your yes in Now."); } else setNote(r.text);
      } catch (e) { setNote(e instanceof Error ? e.message : "That did not go through."); }
      return;
    }
    const t = buildType(picked, name, work, space, taken);
    onAdd(toKernelType(t, undefined), t.plural);
    onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title="Add a type">
      <View className="gap-s3">
        <Text tone="muted">A new kind of record. It gets a list, a board and a record page.</Text>
        <TypeStarter starters={starters} picked={picked} onPick={(id) => { setPicked(id); setNote(""); const s = starters.find((x) => x.id === id); if (!s?.from) setName(templateName(id)); }} name={name} onName={setName} work={work} onWork={setWork} />
        {note ? <Text tone="muted">{note}</Text> : null}
        <View className="flex-row gap-s2">
          <Button kind="primary" label={kit ? "Ask to install" : "Add type"} onPress={() => void submit()} />
          <Button kind="ghost" label="Cancel" onPress={onClose} />
        </View>
      </View>
    </Sheet>
  );
}
