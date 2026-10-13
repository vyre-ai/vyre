import { View } from "react-native";
import { cn } from "../lib/cn";
import { PressableScale } from "../motion/PressableScale";
import { Icon, type IconName } from "./Icon";
import { IconTile } from "./IconTile";
import { Text } from "./Text";

export type Choice<T extends string = string> = { value: T; title: string; sub?: string; icon?: IconName };

/**
 * A short list of cards where one is chosen: Create a space or Join a space, run here or on the server. Each card holds an icon tile, a title, one line, and a mark at the right
 * that is filled when it is the choice (the state is also in the accessibility state, so colour is never the only signal). Two to four cards. `value` empty means nothing chosen yet.
 */
export function ChoiceList<T extends string>({ options, value, onChange, label }: { options: Choice<T>[]; value?: T; onChange: (v: T) => void; label?: string }) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} className="gap-s3">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <PressableScale key={o.value} accessibilityRole="radio" accessibilityLabel={o.title} accessibilityState={{ selected: on }} onPress={() => onChange(o.value)} depth={0.985}
            {...({ onKeyDown: (e: { key: string; preventDefault: () => void }) => { if (e.key === " ") { e.preventDefault(); onChange(o.value); } } } as object)}
            style={{ flexDirection: "row", alignItems: "center" }}>
            <View className={cn("w-full flex-row items-center gap-s3 rounded-card border p-s4", on ? "border-primary bg-selected" : "border-edge bg-surface-2")}>
              {o.icon ? <IconTile name={o.icon} size={40} tone={on ? "text" : "text-2"} /> : null}
              <View className="min-w-0 flex-1 gap-s1">
                <Text strong>{o.title}</Text>
                {o.sub ? <Text size="secondary" tone="muted">{o.sub}</Text> : null}
              </View>
              {on ? <Icon name="ok" tone="text" /> : null}
            </View>
          </PressableScale>
        );
      })}
    </View>
  );
}
