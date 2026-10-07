import { useEffect, useState } from "react";
import { View } from "react-native";
import { Card, Divider, EmptyState, ErrorState, LoadingState, Text } from "@vyre/ui";
import { byProject, plural, projectTitle } from "./model";
import { TeammateRow } from "./TeamTab";
import { teammates } from "./teammates";
import { useTeam } from "./useTeam";

/** Assistants, Teammates: every teammate in one list, grouped by the project it works in, with what each is doing. Add and retire happen on the project's Team tab. */
export function TeammatesPage() {
  const { rows, error, reload } = useTeam(null);
  const [open, setOpen] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  const ids = (rows ?? []).map((t) => t.project).join(",");
  useEffect(() => { let live = true; if (ids) void teammates.names(ids.split(",")).then((n) => { if (live) setNames(n); }); return () => { live = false; }; }, [ids]);
  if (rows === null) return <LoadingState rows={3} />;
  if (error) return <Card flush><ErrorState title="Teammates could not be read" reason={error} retry={reload} /></Card>;
  if (!rows.length) return <Card><EmptyState title="No teammates yet" body="Add one from a project's Team tab. A teammate is a role in a project, like design or backend." /></Card>;
  return (
    <View className="gap-s4">
      {byProject(rows).map((g) => (
        <Card key={g.project || "-"} flush title={projectTitle(g.project, names)} actions={<Text size="caption" tone="label">{plural(g.rows.length, "teammate")}</Text>}>
          {g.rows.map((t, i) => <View key={t.agent}>{i ? <Divider /> : null}<TeammateRow t={t} project={t.project} open={open === t.agent} onToggle={() => setOpen(open === t.agent ? "" : t.agent)} reload={reload} /></View>)}
        </Card>
      ))}
    </View>
  );
}
