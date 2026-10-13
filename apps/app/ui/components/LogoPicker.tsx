import { useState } from "react";
import { Platform, View } from "react-native";
import { Button } from "./Button";
import { SpaceTile } from "./SpaceTile";
import { Text } from "./Text";
import { checkLogoFile, coverSquare, keepableLogo } from "../marks/logo.js";

/** Reads a chosen image into a small square data address (web: a canvas). Throws a sentence a person can read. */
async function squareOf(file: File): Promise<string> {
  const why = checkLogoFile({ type: file.type, size: file.size });
  if (why) throw new Error(why);
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error("That image could not be read.")); i.src = url; });
    const box = coverSquare(img.naturalWidth, img.naturalHeight);
    if (!box) throw new Error("That image could not be read.");
    const c = document.createElement("canvas"); c.width = c.height = box.out;
    c.getContext("2d")!.drawImage(img, box.sx, box.sy, box.side, box.side, 0, 0, box.out, box.out);
    const out = keepableLogo(c.toDataURL("image/webp", 0.9)) ?? keepableLogo(c.toDataURL("image/png"));
    if (!out) throw new Error("That image is too detailed to keep as a logo. Try a simpler one.");
    return out;
  } finally { URL.revokeObjectURL(url); }
}

/**
 * Where a person gives a space its own logo: the tile as it shows now, Upload and Remove. The image is cropped to a centred square and kept small. Without a logo the tile is the monogram.
 * On a phone there is no file chooser here yet, so it says so and keeps the monogram.
 */
export function LogoPicker({ space, onChange }: { space: { id: string; name: string; logo?: string | null }; onChange: (logo: string | null) => void }) {
  const [wrong, setWrong] = useState("");
  const web = Platform.OS === "web";
  const choose = () => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "image/png,image/jpeg,image/webp";
    input.onchange = () => { const f = input.files?.[0]; if (f) squareOf(f).then((l) => { setWrong(""); onChange(l); }, (e) => setWrong(String(e?.message ?? e))); };
    input.click();
  };
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
        <SpaceTile space={space} size={56} />
        <View style={{ flexDirection: "row", gap: 8 }}>
          {web ? <Button kind="secondary" size="sm" icon="upload" label={space.logo ? "Change logo" : "Upload logo"} onPress={choose} /> : null}
          {space.logo ? <Button kind="ghost" size="sm" label="Remove" onPress={() => { setWrong(""); onChange(null); }} /> : null}
        </View>
      </View>
      <Text size="caption" tone="label">{web ? "A square image works best. Without one, the space shows its initials." : "Add a logo from the desktop app. Until then the space shows its initials."}</Text>
      {wrong ? <Text size="caption" tone="err">{wrong}</Text> : null}
    </View>
  );
}
