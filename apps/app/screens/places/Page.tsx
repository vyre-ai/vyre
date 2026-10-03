import { ScrollView, View, useWindowDimensions } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Card, Chip, Icon, Segmented, Sheet, Text, PHONE_MAX, haptic, type IconName } from "@vyre/ui";
import { SPACES, useScope, type Scope, type SpaceId } from "./scope";

/** True below the phone width. The same test the theme uses. */
export function usePhone(): boolean {
  return useWindowDimensions().width < PHONE_MAX;
}

/** The one page frame for a place: a title, a line under it, actions, the space bar, then the content. */
export function Page({ title, sub, actions, scope = true, back, children }: { title: string; sub?: string; actions?: React.ReactNode; scope?: boolean; back?: { label: string; to: string }; children: React.ReactNode }) {
  const router = useRouter();
  const phone = usePhone();
  return (
    <ScrollView contentContainerClassName="w-full max-w-page gap-s4 self-center p-s4 pb-s12">
      {back ? <View className="self-start"><Button kind="ghost" size="sm" icon="chev-l" label={back.label} onPress={() => router.push(back.to as never)} /></View> : null}
      <View className={phone ? "gap-s3" : "flex-row items-start gap-s3"}>
        <View className="min-w-0 flex-1 gap-s1">
          <Text size="page" strong accessibilityRole="header">{title}</Text>
          {sub ? <Text tone="muted">{sub}</Text> : null}
        </View>
        {actions ? <View className={phone ? "flex-row flex-wrap gap-s2" : "flex-none"}>{actions}</View> : null}
      </View>
      {scope ? <ScopeBar /> : null}
      {children}
    </ScrollView>
  );
}

/** All spaces, Mine, Harlow Legal. */
export function ScopeBar() {
  const { scope, setScope } = useScope();
  return <Segmented<Scope> label="Space" value={scope} onChange={setScope} options={[["all", "All spaces"], ["mine", SPACES.mine.name], ["harlow", SPACES.harlow.name]]} />;
}

/** A labelled group: a small caption, an optional count, then the content. */
export function Section({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return (
    <View className="gap-s2">
      <View className="flex-row items-baseline gap-s2"><Text size="caption" strong tone="label">{title}</Text>{meta ? <Text size="caption" tone="faint">{meta}</Text> : null}</View>
      {children}
    </View>
  );
}

/** A square mark with an icon, the leading mark of a Row that is a thing and not a person. */
export function IconTile({ icon, tone = "text-2" }: { icon: IconName; tone?: string }) {
  return <View className="h-control w-control items-center justify-center rounded-row bg-surface-3"><Icon name={icon} size={20} tone={tone} /></View>;
}

/** The space a thing lives in, shown only when more than one space is on screen. */
export function SpaceChip({ sp }: { sp: SpaceId }) {
  const scope = useScope((s) => s.scope);
  return scope === "all" ? <Chip tone="space">{SPACES[sp].name}</Chip> : null;
}

/** A quiet two-line note with a title: the boundary and isolation statements. */
export function Note({ title, body, tone = "plain" }: { title: string; body: string; tone?: "plain" | "warn" }) {
  return (
    <Banner tone={tone} icon="shield">
      <View className="gap-s1"><Text strong>{title}</Text><Text size="caption" tone="muted">{body}</Text></View>
    </Banner>
  );
}

/** Mono text in a recessed block: a value, a log, a record to add. */
export function Block({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <View className="gap-s1 rounded-card border border-edge bg-surface-3 p-s3">
      {label ? <Text size="caption" strong tone="label">{label}</Text> : null}
      {typeof children === "string" ? <Text mono size="caption">{children}</Text> : children}
    </View>
  );
}

/** A diff or a piece of code: one line each, "+" added, "-" removed, anything else context. */
export function DiffBlock({ lines }: { lines: { t: "a" | "d" | "c"; s: string }[] }) {
  return (
    <View accessibilityLabel="Changes" className="gap-s1 rounded-card border border-edge bg-surface-3 p-s3">
      {lines.map((l, i) => (
        <Text key={i} mono size="caption" tone={l.t === "a" ? "ok" : l.t === "d" ? "err" : "muted"}>{(l.t === "a" ? "+ " : l.t === "d" ? "- " : "  ") + l.s}</Text>
      ))}
    </View>
  );
}

/** Face ID, as a Sheet with one button. The platform prompt replaces the button on a real device; the screen only learns "approved". */
export function FaceIdSheet({ open, onClose, title, body, confirm, onConfirm, children }: { open: boolean; onClose: () => void; title: string; body: string; confirm: string; onConfirm: () => void; children?: React.ReactNode }) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <Text tone="muted">{body}</Text>
      {children}
      <Button kind="primary" icon="faceid" label={confirm} onPress={() => { onClose(); haptic.approve(); onConfirm(); }} />
      <Button kind="ghost" label="Not now" onPress={onClose} />
    </Sheet>
  );
}

/** The empty state of a Card of Rows. */
export function Empty({ title, body }: { title: string; body: string }) {
  return <Card><View className="items-center gap-s1 p-s4"><Text strong>{title}</Text><Text tone="muted" className="text-center">{body}</Text></View></Card>;
}
