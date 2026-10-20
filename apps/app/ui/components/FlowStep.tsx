import { createContext, useContext, useEffect, useRef } from "react";
import { Platform, ScrollView, View } from "react-native";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { StageSteps } from "./StageSteps";
import { Text } from "./Text";
import { VyreMark, type MarkState } from "./VyreMark";
import { Appear } from "../motion";
import { useUiTheme } from "../theme";
import { focusFirst, wireFormKeys } from "../lib/form-keys.js";

/** True when something sits behind the step (the welcome flow's halftone field): the page is then left clear instead of painted. */
export const FlowOver = createContext(false);

type Action = { label: string; onPress: () => void; disabled?: boolean; loading?: boolean };

/**
 * One screen of a guided flow (setup, create a space, join a space, invite people). It is the same page every time so a flow feels like one thing: Back at the top left,
 * the step strip with "Step 2 of 6" and the current step's name, a title and one line under it, the body, an optional failure (a Banner that names what went wrong and
 * what to do), then one primary action at full width and at most one quiet alternative under it. `onBack` omitted on the first screen. The page scrolls, so the actions
 * are never lost behind a keyboard; on a wide window the column stops at the reading width and sits in the middle.
 * On the web and in the Mac app the step is a keyboard form (lib/form-keys.js): each new step puts the caret in its first empty field (or on the primary when it has no field),
 * Enter goes to the next field and, in the last one, presses the primary.
 */
export function FlowStep({ mark = "static", hero, steps, title, lead, failure, onBack, backLabel = "Back", primary, secondary, enterSubmits = true, children }: {
  /** The flow's steps and the current one (index). The strip is left out when a screen is not a step (the first one). */
  /** `phase` names the phase (Identity, Space, Ready). The default counts "Step 2 of 6". */
  steps?: { labels: string[]; current: number; kind?: "count" | "phase" };
  /** The Vyre mark's state: at rest by default, "working" while something waits, "intro" on the first screen, "done" when a step succeeds. */
  mark?: MarkState;
  /** The mark large and in the middle, above the title (the first screen and Ready), instead of the small lockup at the top left. */
  hero?: boolean;
  title: string;
  lead?: string;
  /** What went wrong, in words, with the way forward. Drawn above the actions as an error Banner. */
  failure?: string;
  onBack?: () => void;
  /** What the back button says: "Cancel" on the first step of a flow opened from the app, which leaves the flow. */
  backLabel?: string;
  primary?: Action;
  secondary?: Action;
  /** false when the step's body has its own action for its fields (an Add button): Enter in the last field then leaves the primary alone. */
  enterSubmits?: boolean;
  children?: React.ReactNode;
}) {
  const over = useContext(FlowOver);
  const form = useRef<View>(null);
  const actions = useRef<View>(null);
  const latest = useRef({ primary, enterSubmits });
  latest.current = { primary, enterSubmits };
  const web = Platform.OS === "web";
  useEffect(() => {
    if (!web) return;
    return wireFormKeys(form.current, () => { const { primary: p, enterSubmits: on } = latest.current; if (on && p && !p.disabled && !p.loading) p.onPress(); });
  }, [web]);
  // Escape leaves the step the same way Back does (on the web and in the Mac app).
  const backRef = useRef(onBack);
  backRef.current = onBack;
  useEffect(() => {
    if (!web || typeof document === "undefined") return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented && backRef.current) { e.preventDefault(); backRef.current(); } };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [web]);
  // The same FlowStep draws one step after another, so a new title is a new step.
  useEffect(() => {
    if (web) focusFirst(form.current, latest.current.primary ? (actions.current as unknown as HTMLElement | null)?.querySelector?.('[role="button"]') : null);
  }, [web, title]);
  const { color } = useUiTheme();
  // Over the halftone field the step sits on a glass surface (the prototype's form look): the page colour at about three quarters, blurred behind, with a hairline edge; the dots show faintly through it.
  const glass = over ? ({ backgroundColor: /^#[0-9a-fA-F]{6}$/.test(color["surface-1"] || "") ? `${color["surface-1"]}bd` : color["surface-1"], borderWidth: 0.5, borderColor: color["edge-strong"], borderRadius: 20, padding: 24, backdropFilter: "blur(18px) saturate(1.3)" } as object) : undefined;
  return (
    <ScrollView className={over ? "flex-1" : "flex-1 bg-bg"} contentContainerClassName={over ? "grow items-center justify-center px-s4 py-s5" : "grow items-center px-s4 py-s5"} keyboardShouldPersistTaps="handled">
      <View ref={form} id="onboard-content" className="w-full max-w-read gap-s5" style={glass}>
        <View className="min-h-control flex-row items-center justify-between">
          {hero ? <View /> : <VyreMark lockup size="sm" state={mark} />}
          {onBack ? <Button kind="ghost" size="sm" icon="back" label={backLabel} onPress={onBack} /> : null}
        </View>
        {hero ? <View className="items-center py-s4"><VyreMark size="lg" state={mark} /></View> : null}
        {steps ? (
          <View className="gap-s1" accessible accessibilityLabel={steps.kind === "phase" ? steps.labels[steps.current] : `Step ${steps.current + 1} of ${steps.labels.length}, ${steps.labels[steps.current]}`}>
            <Text size="caption" tone="label">{steps.kind === "phase" ? `${steps.current + 1} of ${steps.labels.length} \u00b7 ${steps.labels[steps.current]}` : `Step ${steps.current + 1} of ${steps.labels.length}`}</Text>
            <StageSteps stages={steps.labels} current={steps.current} strip quiet={steps.kind === "phase"} />
          </View>
        ) : null}
        <Appear index={1}><View className={hero ? "items-center gap-s2" : "gap-s2"}>
          <Text size="page" strong accessibilityRole="header">{title}</Text>
          {lead ? <Text tone="muted" className={hero ? "text-center" : undefined}>{lead}</Text> : null}
        </View></Appear>
        <Appear index={2}><View className="gap-s4">{children}</View></Appear>
        {failure ? <Banner tone="err">{failure}</Banner> : null}
        {primary || secondary ? (
          <Appear index={3}><View ref={actions} className="gap-s2">
            {primary ? <Button kind="primary" size="lg" className="w-full" label={primary.label} onPress={primary.onPress} disabled={primary.disabled} loading={primary.loading} /> : null}
            {secondary ? <Button kind="ghost" size="lg" className="w-full" label={secondary.label} onPress={secondary.onPress} disabled={secondary.disabled} loading={secondary.loading} /> : null}
          </View></Appear>
        ) : null}
      </View>
    </ScrollView>
  );
}
