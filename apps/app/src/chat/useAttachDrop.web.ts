import { useEffect } from "react";
import { readFiles } from "./attach-pick.web";
import type { Picked } from "./attach-pick";

/** In a browser: files pasted (a screenshot from the clipboard) or dropped anywhere on the chat are added to the next message. Text pastes and drags are left alone. */
export function useAttachDrop(add: (files: Picked[]) => void | Promise<void>): void {
  useEffect(() => {
    const hasFiles = (dt: DataTransfer | null) => Boolean(dt && Array.from(dt.types || []).includes("Files"));
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      void readFiles(files).then(add);
    };
    const onOver = (e: DragEvent) => { if (hasFiles(e.dataTransfer)) e.preventDefault(); };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      void readFiles(Array.from(e.dataTransfer?.files ?? [])).then(add);
    };
    document.addEventListener("paste", onPaste);
    document.addEventListener("dragover", onOver);
    document.addEventListener("drop", onDrop);
    return () => { document.removeEventListener("paste", onPaste); document.removeEventListener("dragover", onOver); document.removeEventListener("drop", onDrop); };
  }, [add]);
}
