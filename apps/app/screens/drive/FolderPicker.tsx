// The folder picker of "Move to...": the folders of one place (the Space, or one linked folder), one level at a time, with the way back in a breadcrumb and the chosen folder named under it. It only
// chooses; the move is the caller's (MoveDelete on the web, the file sheet on a phone). The folders being moved are not offered, so a folder cannot be picked from inside itself.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Card, Divider, EmptyState, IconTile, LoadingState, Row, Text } from "@vyre/ui";
import { Breadcrumb } from "./Breadcrumb";
import { loader, linkedNames } from "./files-real";
import { placeId, rootLabel, type Root } from "./files-model.ts";
import { pickable, pickerCrumbs } from "./move-model.js";

type Moving = { path: string; dir: boolean; name: string; root: string; link?: string };
type Level = { name: string; path: string };

export function FolderPicker({ root, link, moving, value, onChange }: { root: "space" | "linked"; link?: string; moving: readonly Moving[]; value: string; onChange: (path: string) => void }) {
  const [stack, setStack] = useState<Level[]>([]);
  const [dirs, setDirs] = useState<{ name: string; path: string; dir: boolean }[] | null>(null);
  const [err, setErr] = useState("");
  const here = stack.length ? stack[stack.length - 1].path : "";
  const rootName = root === "linked" ? (link && linkedNames[link]) || rootLabel("linked" as Root) : rootLabel("space" as Root);
  useEffect(() => { onChange(here); }, [here]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let live = true;
    setDirs(null); setErr("");
    loader.rows(placeId({ root, path: here, ...(link ? { link } : {}) } as never)).then((r) => { if (live) setDirs(pickable(r.map((x) => ({ name: x.name, path: x.path, dir: x.dir })), moving)); }).catch(() => { if (live) { setErr("This folder did not open."); setDirs([]); } });
    return () => { live = false; };
  }, [root, link, here]); // eslint-disable-line react-hooks/exhaustive-deps
  const crumbs = pickerCrumbs(rootName, stack);
  const back = (key: string) => setStack((s) => (key === "" ? [] : s.slice(0, s.findIndex((x) => x.path === key) + 1)));
  return (
    <View className="gap-s2">
      <Breadcrumb crumbs={crumbs} onPress={back} />
      <Card flush>
        {dirs === null ? <LoadingState rows={3} />
          : dirs.length ? dirs.map((d, k) => (
            <View key={d.path}>{k ? <Divider inset={60} /> : null}
              <Row dense chevron lead={<IconTile name="folder" />} title={d.name} onPress={() => setStack((s) => [...s, { name: d.name, path: d.path }])} />
            </View>
          ))
          : <EmptyState title={err || "No folders here"} body={err ? "Go back and try again." : "Move it here, or go back and pick another folder."} />}
      </Card>
      <Text size="caption" tone="label">{value ? `It will go into ${stack[stack.length - 1]?.name ?? value}.` : `It will go to the top of ${rootName}.`}</Text>
    </View>
  );
}
