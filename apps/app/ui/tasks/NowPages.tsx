import { View } from "react-native";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/States";
import { Card } from "../components/Card";
import { DoingList, NeedsList } from "./NowView";
import { useNowScope } from "./scope";
import { nowModel, type World } from "./model";
import type { SwipeSet } from "../motion/SwipeActions";

type Props = { world: World; onAction: (task: any, id: string, input?: string) => void; onOpen: (task: any) => void; onBack: () => void };

/** The page "5 more waiting" pushes on a phone: every Needs you card past the two hero cards, as standard cards. */
export function NeedsPage({ world, onAction, onOpen, onBack }: Props) {
  const { scope } = useNowScope();
  const m = nowModel(world, scope);
  const rest = m.needs.slice(2);
  return (
    <View className="gap-s4">
      <PageHeader title="Needs you" context={`${rest.length} more waiting`} onBack={onBack} />
      <View className="px-s4">
        {rest.length ? <NeedsList world={world} list={rest} showSpace={scope === "all"} onAction={onAction} onOpen={onOpen} /> : <Card><EmptyState title="Nothing more waits on you" /></Card>}
      </View>
    </View>
  );
}

/** The page "9 running" pushes on a phone: every running task as a row. */
export function DoingPage({ world, onOpen, onBack }: Omit<Props, "onAction">) {
  const { scope } = useNowScope();
  const m = nowModel(world, scope);
  const swipe = (t: any): SwipeSet => ({ trailing: [{ id: "open", label: "Open", icon: "chev-r", tone: "plain", haptic: "selection", onPress: () => onOpen(t) }] });
  return (
    <View className="gap-s4">
      <PageHeader title="Doing now" context={`${m.working.length} running`} onBack={onBack} />
      <View className="px-s4">
        {m.working.length ? <DoingList world={world} list={m.working} onOpen={onOpen} swipe={swipe} /> : <Card><EmptyState title="Nothing is running" /></Card>}
      </View>
    </View>
  );
}
