import * as P from "@rn-primitives/dropdown-menu";
import { cn } from "../lib/cn";
import { Text } from "./Text";
import { elevation } from "../lib/elevation";
import { useUiTheme } from "../theme";

export type MenuItem = { label: string; onPress: () => void; danger?: boolean };

/** Anchored choices. `trigger` is any pressable element, passed as the anchor. */
export function Menu({ trigger, items }: { trigger: React.ReactNode; items: MenuItem[] }) {
  const { resolved } = useUiTheme();
  return (
    <P.Root>
      <P.Trigger asChild>{trigger as any}</P.Trigger>
      <P.Portal>
        <P.Overlay className="absolute inset-0" />
        <P.Content style={elevation(resolved.scheme, 2)} className="min-w-menu rounded-card border border-edge-strong bg-surface-3 p-s1">
          {items.map((i) => (
            <P.Item key={i.label} onPress={i.onPress} className={cn("min-h-control-sm justify-center rounded-row px-s3")}>
              <Text tone={i.danger ? "err" : "default"}>{i.label}</Text>
            </P.Item>
          ))}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
