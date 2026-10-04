import { useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Field, Row, Segmented, Switch, Text, allowsMock, showToast, useAppearance, useUiTheme } from "@vyre/ui";
import { V3 } from "@vyre/deck-ui/tokens-v3.js";
import { Group, Page } from "../places/Frame";
import { useSpaces } from "../shell/state";
import { useShell } from "../shell/shared";
import { DEFAULT_LOOKS } from "../shell/spaces.js";
import { appearanceRefusal, themeFrom, themeNote, type Scheme } from "./appearance-model";
import { readScheme, setScheme } from "./appearance";
import { showingLine } from "../shell/spaces.js";
import { ComponentGallery } from "./Gallery";

const FONT_NAMES: Record<string, string> = Object.fromEntries(Object.entries((V3 as any).font.stacks).map(([k, v]: [string, any]) => [k, v.label]));
// The font setting is System and Serif; Instrument Sans is the brand's, not the app's (font ruling, 4 Oct 2026).
const fonts = Object.keys(FONT_NAMES).filter((k) => k !== "sans").map((k) => [k, FONT_NAMES[k]] as [string, string]);
const ACCENTS = ["violet", "amber", "sky", "sage", "rose"].map((k) => [k, k[0].toUpperCase() + k.slice(1)] as [string, string]);

/** Settings, Appearance: the scope control (Me, Mine, Harlow Legal), the controls for that scope, what is showing now, and every base component drawn live. */
export function AppearanceScreen() {
  const { person, setPerson } = useAppearance();
  const { resolved } = useUiTheme();
  const { space, looks, setLook } = useSpaces();
  const shell = useShell((s) => s.data);
  const real = !allowsMock();
  const own = shell.spaces.filter((x) => x.id !== "all");
  const NAMES: Record<string, string> = Object.fromEntries(own.map((x) => [x.id, x.name]));
  const [scope, setScope] = useState<string>("me");
  const [hex, setHex] = useState("#7AA2F7");
  const [source, setSource] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!real) return;
    readScheme().then((r) => { setPerson({ theme: themeFrom(r.value) }); setSource(r.source); }).catch(() => {});
  }, [real]);
  const chooseTheme = (v: Scheme) => {
    setPerson({ theme: v });
    if (real) setScheme(v).then(() => setSource("account")).catch((e) => showToast(appearanceRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "")));
  };
  const look = scope === "me" ? null : looks[scope] ?? DEFAULT_LOOKS.mine;
  const showing = space === "all" ? own[0]?.id ?? "mine" : space;
  const set = (patch: Record<string, string | undefined>) => look && setLook(scope, patch as any);
  const ownLook = resolved.own.length > 0;
  return (
    <Page title="Appearance" sub="Who sets what. A firm looks like itself; you control what reaches your eyes." back="/u/settings">
      <Segmented label="Whose settings" value={scope} onChange={setScope} options={[["me", "Me"], ...own.map((x) => [x.id, x.name] as [string, string])]} />
      <Banner><Text strong>Showing now: </Text><Text>{showingLine(NAMES[showing] ?? "Space", resolved, { ...FONT_NAMES, sans: FONT_NAMES.system }, ownLook)}</Text></Banner>
      {scope === "me" ? (
        <Group title="Belongs to you, on every space">
          <Card className="gap-s3">
            <Segmented label="Theme" value={person.theme ?? "system"} onChange={(v) => chooseTheme(v as Scheme)} options={[["dark", "Dark"], ["paper", "Paper"], ["system", "System"]]} />
            {real ? <Text size="caption" tone="label">{themeNote(source)}</Text> : null}
            <Segmented label="Density" value={person.density ?? ""} onChange={(v) => setPerson({ density: v || null })} options={[["", "Use the space"], ["compact", "Compact"], ["default", "Default"], ["comfortable", "Comfortable"]]} />
            <Segmented label="Font" value={person.font ?? ""} onChange={(v) => setPerson({ font: v || null })} options={[["", "Use the space"], ...fonts]} />
            <Row title="Reduce motion" sub="No springs, shorter fades." end={<Switch label="Reduce motion" on={!!person.reducedMotion} onChange={(reducedMotion) => setPerson({ reducedMotion })} />} />
            <Row title="Larger text" sub="Every size goes up a step." end={<Switch label="Larger text" on={!!person.largerText} onChange={(largerText) => setPerson({ largerText })} />} />
          </Card>
        </Group>
      ) : look ? (
        <Group title={real ? `${NAMES[scope]} looks like this on this device` : `${NAMES[scope]} looks like this for everyone in it`}>
          <Card className="gap-s3">
            <Segmented label="Brand accent" value={look.accent} onChange={(accent) => set({ accent, hex: undefined })} options={[...ACCENTS, ["custom", "Custom"]]} />
            {look.accent === "custom" || hex !== "#7AA2F7" ? (
              <View className="gap-s2">
                <View className="flex-row flex-wrap items-end gap-s2"><Field className="w-ring" label="Custom accent" value={hex} onChangeText={setHex} mono /><Button size="sm" label="Use this colour" onPress={() => set({ accent: "custom", hex })} /></View>
                {resolved.note && scope === showing ? <Text size="caption" tone="warn">{resolved.note}</Text> : <Text size="caption" tone="label">Any colour, checked for contrast. A colour that fails is replaced by the nearest one that passes.</Text>}
              </View>
            ) : null}
            <Segmented label="Row tint" value={look.tint ?? "accent"} onChange={(tint) => set({ tint })} options={[["accent", "Same as accent"], ...ACCENTS]} />
            <Segmented label="Density" value={look.density} onChange={(density) => set({ density })} options={[["compact", "Compact"], ["default", "Default"], ["comfortable", "Comfortable"]]} />
            <Segmented label="Font" value={look.font} onChange={(font) => set({ font })} options={fonts} />
            <Segmented label="Corners" value={look.corners} onChange={(corners) => set({ corners })} options={[["sharp", "Sharp"], ["default", "Default"], ["round", "Round"]]} />
          </Card>
          {scope !== showing ? <Text size="caption" tone="label">{`${NAMES[scope]} is not showing. Switch to it in the rail to see these.`}</Text> : null}
        </Group>
      ) : null}
      {real ? null : <Group title="Every base component, live"><ComponentGallery /></Group>}
    </Page>
  );
}
