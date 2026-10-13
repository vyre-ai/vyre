import { useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { Button } from "./Button";
import { Text } from "./Text";

/** How long a revealed value stays up, and how long after Copy the clipboard is emptied. A reveal is a click; every reveal and copy is reported to `onAudit`. */
export const SECRET_REVEAL_MS = 60_000;
export const SECRET_CLIPBOARD_MS = 30_000;

/**
 * A key and value row where the value is never drawn until the person clicks Reveal. It shows for 60 seconds and hides again (Hide hides at once); Copy puts it on the clipboard
 * and empties the clipboard 30 seconds later. `read` fetches the value only at the click, so a screen holds no value before then. An agent is never given this component's value.
 * See docs/design/system/components/secret-field.md.
 */
export function SecretField({ label, read, onAudit, revealMs = SECRET_REVEAL_MS }: {
  label: string; read: () => string | Promise<string>; onAudit?: (what: "reveal" | "copy") => void; revealMs?: number;
}) {
  const [shown, setShown] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const clear = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (shown === null) return;
    const end = Date.now() + revealMs;
    setLeft(Math.ceil(revealMs / 1000));
    const t = setInterval(() => { const s = Math.ceil((end - Date.now()) / 1000); if (s <= 0) { setShown(null); clearInterval(t); } else setLeft(s); }, 1000);
    return () => clearInterval(t);
  }, [shown, revealMs]);
  useEffect(() => () => { if (clear.current) clearTimeout(clear.current); }, []);

  const reveal = async () => {
    if (busy) return;
    setBusy(true); setNote("");
    try { const v = await read(); onAudit?.("reveal"); setShown(v); } catch (e: any) { setNote(String(e?.message || "Could not read it.")); } finally { setBusy(false); }
  };
  const write = (text: string) => { if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) void navigator.clipboard.writeText(text).catch(() => {}); };
  const copy = async () => {
    try {
      const v = shown ?? (await read());
      write(v); onAudit?.("copy"); setNote(`Copied. The clipboard is emptied in ${SECRET_CLIPBOARD_MS / 1000} seconds.`);
      if (clear.current) clearTimeout(clear.current);
      clear.current = setTimeout(() => { write(""); setNote(""); }, SECRET_CLIPBOARD_MS);
    } catch (e: any) { setNote(String(e?.message || "Could not copy it.")); }
  };
  return (
    <View className="gap-s1">
      <View className="min-h-control flex-row items-center justify-between gap-s2">
        {shown !== null ? <Text mono size="headline" className="min-w-0 flex-1" selectable>{shown}</Text> : <Text mono size="headline" accessibilityLabel={`${label}, hidden`}>{"•".repeat(12)}</Text>}
        <View className="flex-row items-center gap-s1">
          {shown !== null ? <Button kind="ghost" size="sm" label="Hide" onPress={() => setShown(null)} /> : <Button kind="ghost" size="sm" icon="eye" label="Reveal" onPress={reveal} />}
          <Button kind="ghost" size="sm" icon="copy" label="Copy" onPress={copy} />
        </View>
      </View>
      <Text size="caption" tone="label">{note || (shown !== null ? `Shown for ${left} seconds, then hidden again. Agents never see it.` : "Hidden until you reveal it. Every reveal is logged.")}</Text>
    </View>
  );
}
