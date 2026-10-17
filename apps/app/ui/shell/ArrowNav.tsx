// Wraps a list so Up, Down, Home and End move the focus between its rows (web). Typing in a field inside it is left alone.
import { useRef } from "react";
import { Platform, View } from "react-native";
import { arrowTarget } from "./arrow-nav.js";

export function ArrowNav({ children }: { children: React.ReactNode }) {
  const box = useRef<View>(null);
  if (Platform.OS !== "web") return <>{children}</>;
  const key = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return;
    const root = box.current as unknown as HTMLElement | null;
    const rows = Array.from(root?.querySelectorAll<HTMLElement>('[role="button"]:not([aria-disabled="true"]),[role="link"]') ?? []);
    const to = arrowTarget(e.key, rows.indexOf(el), rows.length);
    if (to === null) return;
    e.preventDefault();
    rows[to]?.focus();
  };
  return <View ref={box} style={{ flex: 1, minHeight: 0 }} {...({ onKeyDown: key } as object)}>{children}</View>;
}
