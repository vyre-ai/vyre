import { Pressable, View } from "react-native";
import { Button, IconButton } from "../components/Button";
import { Chip } from "../components/Chip";
import { Icon } from "../components/Icon";
import type { IconName } from "../components/Icon";
import { IconTile } from "../components/IconTile";
import { Menu } from "../components/Menu";
import { Text } from "../components/Text";
import { cn } from "../lib/cn";

/**
 * One step of a Flow, drawn as a card: a lead word ("When", "Then", "Step 2"), the kind of step, and what it does in one plain sentence. Closed it is one row; open it shows its settings
 * (children) and Move up, Move down and Remove. `problem` says in words what the step still needs. Used by the Flow builder for the trigger and every step.
 */
export function StepCard({ lead, icon, title, summary, open, onToggle, problem, children, onUp, onDown, onRemove, onDuplicate, off, onToggleOff, last, docked }: {
  lead: string; icon: IconName; title: string; summary: string; open: boolean; onToggle: () => void; problem?: string | null;
  children?: React.ReactNode; onUp?: () => void; onDown?: () => void; onRemove?: () => void; /** A copy right after this step. */ onDuplicate?: () => void; /** The step is turned off: the run skips it and says so. */ off?: boolean; /** Turn the step off or on (the "..." menu). */ onToggleOff?: () => void; /** The settings are shown in a panel beside the steps, so the card only marks itself selected. */ docked?: boolean;
  /** The last card in the column draws no line below it. */ last?: boolean;
}) {
  const menu = [
    ...(onUp ? [{ label: "Move up", onPress: onUp }] : []), ...(onDown ? [{ label: "Move down", onPress: onDown }] : []), ...(onDuplicate ? [{ label: "Duplicate", onPress: onDuplicate }] : []),
    ...(onToggleOff ? [{ label: off ? "Turn on" : "Turn off", onPress: onToggleOff }] : []), ...(onRemove ? [{ label: "Delete", onPress: onRemove, danger: true }] : []),
  ];
  return (
    <View className="flex-row gap-s3">
      <View className="items-center">
        <IconTile size={40} name={icon} tone={problem ? "warn" : "text-2"} />
        {last ? null : <View className="mt-s1 w-px flex-1 bg-edge" />}
      </View>
      <View className={cn("min-w-0 flex-1 rounded-card border bg-surface-2", open ? "border-edge-strong" : "border-edge", off ? "opacity-60" : "", last ? "" : "mb-s3")}>
        <View className="flex-row items-center">
        <Pressable {...({ onKeyDown: (e: { altKey?: boolean; key?: string; preventDefault?: () => void }) => { if (!e.altKey) return; if (e.key === "ArrowUp" && onUp) { e.preventDefault?.(); onUp(); } else if (e.key === "ArrowDown" && onDown) { e.preventDefault?.(); onDown(); } } } as object)} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${lead}, ${title}. ${summary}`} onPress={onToggle} className="min-h-control min-w-0 flex-1 flex-row items-center gap-s3 px-s4 py-s3">
          <View className="min-w-0 flex-1 gap-s1">
            <View className="flex-row items-center gap-s2"><Text size="caption" tone="label" strong>{lead}</Text><Text strong numberOfLines={1} className="min-w-0 flex-shrink">{title}</Text>{off ? <Chip>Off</Chip> : null}</View>
            <Text tone="muted" numberOfLines={open ? undefined : 2}>{summary}</Text>
            {problem && !open ? <Chip tone="warn" icon="warning">{problem}</Chip> : null}
          </View>
          <Icon name={open ? "chevron-up" : "chevron-down"} size={16} tone="label" />
        </Pressable>
        {menu.length ? <View className="pr-s3"><Menu align="end" trigger={<IconButton icon="more" label={`${title}, more`} />} items={menu} /></View> : null}
        </View>
        {open && !docked ? (
          <View className="gap-s3 border-t border-edge px-s4 pb-s4 pt-s3">
            {children}
            {problem ? <Text size="caption" tone="warn">{problem}</Text> : null}
            {onUp || onDown || onRemove || onDuplicate ? (
              <View className="flex-row flex-wrap items-center gap-s2 pt-s1">
                {onUp ? <Button kind="ghost" size="sm" icon="chevron-up" label="Move up" onPress={onUp} /> : null}
                {onDown ? <Button kind="ghost" size="sm" icon="chevron-down" label="Move down" onPress={onDown} /> : null}
                {onDuplicate ? <Button kind="ghost" size="sm" icon="copy" label="Duplicate" onPress={onDuplicate} /> : null}
                {onRemove ? <Button kind="ghost" size="sm" icon="trash" label="Remove step" onPress={onRemove} /> : null}
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}
