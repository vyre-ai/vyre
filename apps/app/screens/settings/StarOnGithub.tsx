import { useEffect, useState } from "react";
import { Linking } from "react-native";
import { Button, Text, showToast } from "@vyre/ui";
import { MOCK, tool } from "../../src/real/box";
import { REPO_URL, starNote, starPlan } from "./about-model.js";

type Status = { connected?: boolean; starred?: boolean | null } | null;

/** Whether the person has a connected GitHub account and has starred the repo. Not asked in a mock build; null when it cannot be asked. */
export function useStarStatus() {
  const [status, setStatus] = useState<Status>(null);
  useEffect(() => { if (!MOCK) tool<Status>("github.star.status").then(setStatus).catch(() => setStatus(null)); }, []);
  return { status, setStatus };
}

/** The press: stars through the github module as the person, or opens the repo. It never runs without a press. */
function usePress() {
  const { status, setStatus } = useStarStatus();
  const plan = starPlan(status);
  const press = async () => {
    if (plan.action === "star") {
      try { await tool("github.star"); setStatus({ connected: true, starred: true }); showToast("Starred. Thank you."); return; }
      catch (e) { showToast(`${e instanceof Error ? e.message : "GitHub did not star it"} Opening the project instead.`); }
    }
    if (plan.action !== "none") void Linking.openURL(REPO_URL);
  };
  return { plan, press };
}

/** About's button, with a line saying what a press does. */
export function StarButton() {
  const { plan, press } = usePress();
  return (
    <>
      <Button icon="star" label={plan.label} disabled={plan.action === "none"} onPress={() => { void press(); }} />
      <Text size="caption" tone="label">{starNote(plan)}</Text>
    </>
  );
}

/** The small link in the top corner of Settings. */
export function StarLink() {
  const { plan, press } = usePress();
  return <Button kind="ghost" size="sm" icon="star" label={plan.action === "none" ? "Starred" : "Star"} disabled={plan.action === "none"} onPress={() => { void press(); }} />;
}
