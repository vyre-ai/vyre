import { View } from "react-native";
import { Divider, Icon, Row, SectionLabel } from "../index";

export type PanelCapabilityRowsProps = {
  onMemory?: () => void;
  onExport?: () => void;
  onRoll?: () => void;
  onContext?: () => void;
  onTranscript?: () => void;
  onTasks?: () => void;
  runningCount?: number | null;
  first?: boolean;
};

/** Shared rows for the chat panel and tools sheet: memory, export, roll, context, tasks. */
export function PanelCapabilityRows(p: PanelCapabilityRowsProps) {
  const { first = false } = p;
  return (
    <View>
      <SectionLabel first={first}>Chat capabilities</SectionLabel>
      {p.onMemory ? <Row dense lead={<Icon name="memory" size={20} />} title="Memory" sub="What Vyre remembers for you" chevron onPress={p.onMemory} /> : null}
      {p.onMemory && p.onExport ? <Divider /> : null}
      {p.onExport ? <Row dense lead={<Icon name="download" size={20} />} title="Export conversation" sub="Download or copy this chat" chevron onPress={p.onExport} /> : null}
      {p.onExport && p.onRoll ? <Divider /> : null}
      {p.onRoll ? <Row dense lead={<Icon name="refresh" size={20} />} title="Roll context" sub="Fresh window, same thread" chevron onPress={p.onRoll} /> : null}
      {p.onRoll && p.onContext ? <Divider /> : null}
      {p.onContext ? <Row dense lead={<Icon name="info" size={20} />} title="Context used" chevron onPress={p.onContext} /> : null}
      {p.onContext && p.onTasks ? <Divider /> : null}
      {p.onTasks ? <Row dense lead={<Icon name="bolt" size={20} />} title="Running here" state={p.runningCount == null ? undefined : p.runningCount ? `${p.runningCount} running` : "Nothing"} chevron onPress={p.onTasks} /> : null}
      {p.onTasks && p.onTranscript ? <Divider /> : null}
      {p.onTranscript ? <Row dense lead={<Icon name="history" size={20} />} title="Transcript and recall" chevron onPress={p.onTranscript} /> : null}
    </View>
  );
}
