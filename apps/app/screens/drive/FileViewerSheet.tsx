// The file viewer in a sheet: what a chat's file card opens, so a file a model made can be read and reviewed without leaving the chat. The file is the Space Drive's (screens/drive/file-source.ts).
import { useMemo } from "react";
import { View, useWindowDimensions } from "react-native";
import { FileViewer, Sheet } from "@vyre/ui";
import { driveSource } from "./file-source";

export function FileViewerSheet({ path, onClose, onOpenInFiles }: { path: string | null; onClose: () => void; onOpenInFiles?: (path: string) => void }) {
  const { height } = useWindowDimensions();
  const source = useMemo(() => (path ? driveSource(path) : null), [path]);
  return (
    <Sheet open={!!path} onClose={onClose} title={path ? path.split("/").pop() : ""}>
      {path && source ? (
        <View style={{ height: Math.max(360, Math.min(height * 0.78, 760)) }}>
          <FileViewer name={path} source={source} onOpenInFiles={onOpenInFiles ? () => onOpenInFiles(path) : undefined} />
        </View>
      ) : null}
    </Sheet>
  );
}
