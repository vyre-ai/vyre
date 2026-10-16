import { View } from "react-native";
import { AskCard } from "./AskCard";
import { Text } from "./Text";

const SECRET = /password|secret|recovery|passphrase/i;

/** Facts safe to put on the card. A master password is never one of them. */
export function publicFacts(lines: string[]) {
  return lines.filter((l) => l && !SECRET.test(l) && !/input sha256/i.test(l));
}

/**
 * The one-tap Needs-you card for an agent's first-run act: AskCard, one primary Approve, Deny as ghost.
 * Approving signs the card. Nothing changes until the person does.
 */
export function NeedsYouCard({ title, why, note, facts = [], busy, canSign = true, onApprove, onDeny }: {
  title: string; why?: string; note?: string; facts?: string[]; busy?: boolean; canSign?: boolean; onApprove: () => void; onDeny: () => void;
}) {
  const shown = publicFacts(facts);
  return (
    <AskCard
      hero
      title={title}
      why={why}
      actions={canSign ? [
        { label: busy ? "Waiting" : "Approve", icon: "faceid", disabled: !!busy, onPress: onApprove },
        { label: "Deny", kind: "ghost", disabled: !!busy, onPress: onDeny },
      ] : [{ label: "Deny", kind: "ghost", disabled: !!busy, onPress: onDeny }]}
    >
      {note ? <Text size="caption" tone="label">{note}</Text> : null}
      {!canSign ? <Text size="caption" tone="label">This phone cannot approve yet. Update Vyre.</Text> : null}
      {shown.length ? <View className="gap-s1">{shown.map((l) => <Text key={l} size="caption" tone="label" mono>{l}</Text>)}</View> : null}
    </AskCard>
  );
}
