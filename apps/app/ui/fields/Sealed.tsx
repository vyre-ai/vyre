import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Text } from "../components/Text";
import { Chip } from "../components/Chip";
import { Button } from "../components/Button";
import { Sheet } from "../components/Sheet";
import { haptic } from "../motion/haptics";
import { Field } from "../components/Field";
import { REVEAL_MS, REVEAL_PURPOSE, isEmpty, isRevealable, maskText, sealedPhrase } from "./logic.js";
import type { EditProps, ViewProps } from "./types";

/**
 * A sealed value (ui-primitives.md section 4.1). A person sees a fixed mask and a Reveal button; Reveal asks for the owner's yes (the store's reveal is held on the box until the phone answers), shows the value for 30 seconds, then masks it again. A placeholder (no ref) is what an assistant
 * reads: "<Label> on file, sealed", nothing to reveal.
 */
export function SealedView({ p }: ViewProps) {
  const v = p.value;
  const [shown, setShown] = useState<string | null>(null);
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mask = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; setShown(null); };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  if (isEmpty(v)) return <Text tone="faint">Empty</Text>;
  if (!isRevealable(v)) return <Chip tone="sealed" icon="vault">{sealedPhrase(p.definition.label)}</Chip>;
  const canReveal = !!p.reveal && p.mode !== "compact";
  const go = async () => {
    if (busy || !p.reveal) return;
    setBusy(true); setFailed("");
    try {
      const got = await p.reveal(REVEAL_PURPOSE);
      setAsk(false);
      haptic.approve();
      if (typeof got === "string") {
        setShown(got);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(mask, REVEAL_MS);
      }
    } catch (e: any) {
      if (e?.code !== "cancelled") setFailed(String(e?.message || "Could not reveal it."));
    } finally { setBusy(false); }
  };
  return (
    <View className="flex-row flex-wrap items-center gap-s2">
      {shown === null ? (
        <>
          <Text mono accessibilityLabel={`${p.definition.label}, sealed`}>{maskText(p.definition, v)}</Text>
          {canReveal ? <Button size="sm" icon="key" label="Reveal" onPress={() => { setFailed(""); setAsk(true); }} /> : null}
          {failed ? <Text size="caption" tone="err">{failed}</Text> : null}
        </>
      ) : (
        <>
          <Text mono>{shown}</Text>
          <Chip tone="ok">Shown for 30 s</Chip>
          <Button size="sm" kind="ghost" label="Hide" onPress={mask} />
        </>
      )}
      <Sheet open={ask} onClose={() => setAsk(false)} title={`Reveal ${p.definition.label}`}>
        <Text tone="muted">Vyre shows it on this screen for 30 seconds, then masks it again. No assistant sees it.</Text>
        {failed ? <Text tone="err">{failed}</Text> : null}
        <View className="flex-row gap-s2">
          <Button kind="primary" icon="faceid" label="Ask for my yes" loading={busy} onPress={go} />
          <Button kind="ghost" label="Cancel" onPress={() => setAsk(false)} />
        </View>
      </Sheet>
    </View>
  );
}

/** Password style, and never prefilled: the value is not on this screen. It emits undefined until the person types, so saving leaves a held value alone. */
export function SealedEdit({ p, emit }: EditProps) {
  const [text, setText] = useState("");
  return <Field kind="password" value={text} placeholder="Enter a new value" onChangeText={(t) => { setText(t); emit(t || undefined); }} />;
}

/**
 * The mask of a sealed value that has no field definition (a Vault credential): 17 mono, 12 dots, fixed, so it says nothing about the value, not even
 * its length. The fields' own mask (maskText) is for a sealed field of a record; this is the same idea at the Vault's size.
 */
export function SealedMask({ label }: { label: string }) {
  return <Text mono size="headline" accessibilityLabel={`${label}, sealed`}>{"\u2022".repeat(12)}</Text>;
}
