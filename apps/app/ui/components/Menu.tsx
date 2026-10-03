import * as P from "@rn-primitives/dropdown-menu";
import { cn } from "../lib/cn";
import { Text } from "./Text";
import { elevation } from "../lib/elevation";
import { useUiTheme } from "../theme";
import { px } from "../lib/measure";

export type MenuItem = { label: string; onPress: () => void; danger?: boolean };

/** Anchored choices. `trigger` is any pressable element, passed as the anchor. */
export function Menu({ trigger, items }: { trigger: React.ReactNode; items: MenuItem[] }) {
  const { resolved, color, map } = useUiTheme();
  return (
    <P.Root>
      <P.Trigger asChild>{trigger as any}</P.Trigger>
      <P.Portal>
        <P.Overlay style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} />
        <P.Content style={{ ...elevation(resolved.scheme, 2), minWidth: px(map, "--s-12") * 4, borderRadius: px(map, "--r-card"), borderWidth: 1, borderColor: color["edge-strong"], backgroundColor: color["surface-3"], padding: px(map, "--s-1") }}>
          {items.map((i) => (
            <P.Item key={i.label} onPress={i.onPress} style={{ minHeight: px(map, "--control-sm"), justifyContent: "center", borderRadius: px(map, "--r-row"), paddingHorizontal: px(map, "--s-3") }}>
              <Text tone={i.danger ? "err" : "default"}>{i.label}</Text>
            </P.Item>
          ))}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
