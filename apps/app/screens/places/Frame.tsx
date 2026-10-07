// The one page frame for Settings, Spaces, Vault, Memory, Drive, Sites, Flows and their detail pages (ui-system.md section 7).
// Phone: a top-level page has the large title (28/34, collapsing to a 17 inline title); a pushed page has the one 56 pt header row.
// Wider: the title, one sub line and the actions, as before. The header row is the shared PageHeader.
import { ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Icon, LargeTitleScreen, PageHeader, SectionLabel, Text, type AvatarRef } from "@vyre/ui";
import { ScopeBar, usePhone } from "./Page";

export type FrameProps = {
  title: string;
  /** The context line: one line, 13 label, under the title. */
  sub?: string;
  /** Where Back goes when there is nothing to go back to. */
  back?: string;
  /** Back is handled by the page (a detail pushed inside it): called instead of navigating. */
  onBack?: () => void;
  /** A top-level page (Settings): the large title, no back. */
  top?: boolean;
  actions?: React.ReactNode;
  /** Up to three marks shown before the title in the phone header. */
  marks?: AvatarRef[];
  scope?: boolean;
  children: React.ReactNode;
};

export function Frame({ title, sub, back, onBack, top, actions, marks, scope, children }: FrameProps) {
  const phone = usePhone();
  const router = useRouter();
  const goBack = () => (onBack ? onBack() : router.canGoBack() ? router.back() : router.replace((back ?? "/u/settings") as never));
  const body = (
    <>
      {actions ? <View className={phone ? "gap-s2" : "flex-row flex-wrap items-center gap-s2 self-end"}>{actions}</View> : null}
      {scope ? <ScopeBar /> : null}
      {children}
    </>
  );
  if (phone && top) return <LargeTitleScreen title={title}><View className="gap-s2">{body}</View></LargeTitleScreen>;
  if (phone) {
    return (
      <View className="min-h-0 flex-1">
        <PageHeader title={title} context={sub} faces={marks} onBack={goBack} />
        <ScrollView contentContainerClassName="w-full gap-s2 p-s4 pb-s12">{body}</ScrollView>
      </View>
    );
  }
  return (
    <ScrollView contentContainerClassName="w-full max-w-page gap-s2 self-center p-s4 pb-s12">
      {back || onBack ? <View className="self-start"><Button kind="ghost" size="sm" icon="chev-l" label="Back" onPress={() => (onBack ? onBack() : router.push(back as never))} /></View> : null}
      <View className="flex-row items-start gap-s3">
        <View className="min-w-0 flex-1 gap-s1">
          <Text size="page" strong accessibilityRole="header">{title}</Text>
          {sub ? <Text tone="muted">{sub}</Text> : null}
        </View>
        {actions ? <View className="flex-none flex-row flex-wrap gap-s2">{actions}</View> : null}
      </View>
      {scope ? <ScopeBar /> : null}
      {children}
    </ScrollView>
  );
}

/** A section: the 11 mono label (24 above, 8 below) then its content. The frame's 8 gap makes 32 between sections. */
export function Sec({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return <View><SectionLabel meta={meta}>{title}</SectionLabel>{children}</View>;
}

/** A 13 label footnote, with an optional leading 16 icon: a statement that is not a card. */
export function Footnote({ icon, children }: { icon?: "shield" | "sealed" | "info"; children: React.ReactNode }) {
  return (
    <View className="flex-row items-start gap-s2 px-s1 pt-s2">
      {icon ? <View className="pt-px"><Icon name={icon} size={16} tone="label" /></View> : null}
      <Text size="secondary" tone="label" className="min-w-0 flex-1">{children}</Text>
    </View>
  );
}

/** Drop-in for the settings-style Page: a title, a sub line, Back as a path, actions. Same frame, so every pushed page gets the phone header rule. */
export function Page(p: Omit<FrameProps, "scope"> & { scope?: boolean }) {
  return <Frame {...p} />;
}

/** The settings-style group: a section when it has a title (with its note as the meta), else a plain stack. */
export function Group({ title, note, children }: { title?: string; note?: string; children: React.ReactNode }) {
  if (title) return <Sec title={title}>{note ? <View className="pb-s2"><Text size="caption" tone="label">{note}</Text></View> : null}<View className="gap-s2">{children}</View></Sec>;
  return <View className="gap-s2">{children}</View>;
}
