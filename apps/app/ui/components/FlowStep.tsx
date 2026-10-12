import { ScrollView, View } from "react-native";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { StageSteps } from "./StageSteps";
import { Text } from "./Text";
import { VyreMark, type MarkState } from "./VyreMark";
import { Appear } from "../motion";

type Action = { label: string; onPress: () => void; disabled?: boolean; loading?: boolean };

/**
 * One screen of a guided flow (setup, create a space, join a space, invite people). It is the same page every time so a flow feels like one thing: Back at the top left,
 * the step strip with "Step 2 of 6" and the current step's name, a title and one line under it, the body, an optional failure (a Banner that names what went wrong and
 * what to do), then one primary action at full width and at most one quiet alternative under it. `onBack` omitted on the first screen. The page scrolls, so the actions
 * are never lost behind a keyboard; on a wide window the column stops at the reading width and sits in the middle.
 */
export function FlowStep({ mark = "static", hero, steps, title, lead, failure, onBack, primary, secondary, children }: {
  /** The flow's steps and the current one (index). The strip is left out when a screen is not a step (the first one). */
  steps?: { labels: string[]; current: number };
  /** The Vyre mark's state: at rest by default, "working" while something waits, "intro" on the first screen, "done" when a step succeeds. */
  mark?: MarkState;
  /** The mark large and in the middle, above the title (the first screen and Ready), instead of the small lockup at the top left. */
  hero?: boolean;
  title: string;
  lead?: string;
  /** What went wrong, in words, with the way forward. Drawn above the actions as an error Banner. */
  failure?: string;
  onBack?: () => void;
  primary?: Action;
  secondary?: Action;
  children?: React.ReactNode;
}) {
  return (
    <ScrollView className="flex-1 bg-bg" contentContainerClassName="grow items-center px-s4 py-s5" keyboardShouldPersistTaps="handled">
      <View className="w-full max-w-read gap-s5">
        <View className="min-h-control flex-row items-center justify-between">
          {hero ? <View /> : <VyreMark lockup size="sm" state={mark} />}
          {onBack ? <Button kind="ghost" size="sm" icon="back" label="Back" onPress={onBack} /> : null}
        </View>
        {hero ? <View className="items-center py-s4"><VyreMark size="lg" state={mark} /></View> : null}
        {steps ? (
          <View className="gap-s1" accessible accessibilityLabel={`Step ${steps.current + 1} of ${steps.labels.length}, ${steps.labels[steps.current]}`}>
            <Text size="caption" tone="label">{`Step ${steps.current + 1} of ${steps.labels.length}`}</Text>
            <StageSteps stages={steps.labels} current={steps.current} strip />
          </View>
        ) : null}
        <Appear index={1}><View className={hero ? "items-center gap-s2" : "gap-s2"}>
          <Text size="page" strong accessibilityRole="header">{title}</Text>
          {lead ? <Text tone="muted" className={hero ? "text-center" : undefined}>{lead}</Text> : null}
        </View></Appear>
        <Appear index={2}><View className="gap-s4">{children}</View></Appear>
        {failure ? <Banner tone="err">{failure}</Banner> : null}
        {primary || secondary ? (
          <Appear index={3}><View className="gap-s2">
            {primary ? <Button kind="primary" size="lg" className="w-full" label={primary.label} onPress={primary.onPress} disabled={primary.disabled} loading={primary.loading} /> : null}
            {secondary ? <Button kind="ghost" size="lg" className="w-full" label={secondary.label} onPress={secondary.onPress} disabled={secondary.disabled} loading={secondary.loading} /> : null}
          </View></Appear>
        ) : null}
      </View>
    </ScrollView>
  );
}
