// The file viewer in a sheet: what a chat's file card opens on a phone (and on a wide screen when the chat panel is closed), so a file a model made can be read and reviewed without leaving the chat.
// The file is the Space Drive's (screens/drive/file-source.ts). The viewer scrolls itself, so the sheet does not (one scrollbar). The folder is a line under the name: two files called date.ts can be told apart.
import { useMemo } from "react";
import { View, useWindowDimensions } from "react-native";
import { FileViewer, Sheet, Text } from "@vyre/ui";
import { driveSource } from "./file-source";

/** "Projects / northwind / files" for a path; empty for a file at the root. */
export const folderLine = (path: string): string => path.split("/").slice(0, -1).join(" / ");

export function FileViewerSheet({ path, onClose, onOpenInFiles }: { path: string | null; onClose: () => void; onOpenInFiles?: (path: string) => void }) {
  const { height } = useWindowDimensions();
  const source = useMemo(() => (path ? driveSource(path) : null), [path]);
  const folder = path ? folderLine(path) : "";
  return (
    <Sheet open={!!path} onClose={onClose} title={path ? path.split("/").pop() : ""} scroll={false}>
      {folder ? <Text size="caption" tone="label" numberOfLines={1}>{folder}</Text> : null}
      {path && source ? (
        <View style={{ height: Math.max(360, Math.min(height * 0.72, 720)) }}>
          <FileViewer name={path} source={source} onOpenInFiles={onOpenInFiles ? () => onOpenInFiles(path) : undefined} />
        </View>
      ) : null}
    </Sheet>
  );
}
