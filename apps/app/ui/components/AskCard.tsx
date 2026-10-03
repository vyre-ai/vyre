import { View } from "react-native";
import { Card } from "./Card";
import { Chip } from "./Chip";
import { Text } from "./Text";
import { Button, type ButtonProps } from "./Button";
import { SwipeActions, type SwipeSet } from "../motion/SwipeActions";
import { PressableScale } from "../motion/PressableScale";
import { useUiTheme } from "../theme";

type Tag = string | { text: string; tone?: "plain" | "accent" | "ok" | "warn" | "err" | "sealed" | "space" };

/**
 * The one inbox card for a Gate approval, a Flow step that needs a person, a pairing request, a task: a Card, and the hero card (surface-3, level-2
 * elevation, radius 20 or 16, padding 20) when a decision waits on the person. No coloured strip, and no "Needs you" chip: what needs you is the
 * first card, the step up and the filled primary button. Anatomy: the mark (a 44 face with the space badge in a hero), the title, one secondary line,
 * at most two chips (a state such as Stuck, never the space or who asked), then the actions: one primary, the rest ghost. A phone stacks them, the
 * primary full width. `hero` defaults to `needsYou`; `onTitlePress` makes the title open the thing; `children` sit above the buttons (an inline field).
 */
export function AskCard({ lead, title, why, tags, actions = [], needsYou = true, hero, onTitlePress, children, swipe }: {
  lead?: React.ReactNode; title: string; why?: string; tags?: Tag[]; needsYou?: boolean; hero?: boolean; onTitlePress?: () => void; children?: React.ReactNode; swipe?: SwipeSet;
  actions?: (ButtonProps & { label: string })[];
}) {
  const { phone } = useUiTheme();
  const big = hero ?? needsYou;
  const t = <Text strong size={big ? "title" : "headline"}>{title}</Text>;
  const chips = (tags ?? []).slice(0, 2);
  const stack = phone && big;
  const card = (
    <Card hero={big}>
      <View className="flex-row items-start gap-s3">
        {lead ? <View className="flex-none">{lead}</View> : null}
        <View className="min-w-0 flex-1 gap-s2">
          {onTitlePress ? <PressableScale depth={0.99} accessibilityRole="button" onPress={onTitlePress}>{t}</PressableScale> : t}
          {why ? <Text size={big && phone ? "body" : "secondary"} tone="label">{why}</Text> : null}
          {chips.length ? <View className="flex-row flex-wrap gap-s2">{chips.map((g) => { const x = typeof g === "string" ? { text: g } : g; return <Chip key={x.text} tone={x.tone}>{x.text}</Chip>; })}</View> : null}
          {children}
          {actions.length ? (
            <View className={stack ? "gap-s2 pt-s2" : "flex-row flex-wrap gap-s2 pt-s1"}>
              {actions.map((a, i) => <Button key={a.label} size={big && !phone ? "md" : "sm"} {...a} kind={a.kind ?? (i === 0 ? "primary" : "ghost")} className={stack ? "self-stretch" : undefined} />)}
            </View>
          ) : null}
        </View>
      </View>
    </Card>
  );
  return swipe ? <SwipeActions leading={swipe.leading} trailing={swipe.trailing} enabled={phone}>{card}</SwipeActions> : card;
}
