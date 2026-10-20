// A popover drawn as a plain view closes on a press outside it and on Esc, like Menu does. The rule is lib/dismiss.js; this wires it to the document on the web (a View's ref is its element
// there) and to the back button on a phone.
import { useEffect, useRef } from "react";
import { BackHandler, Platform } from "react-native";
import { attachDismiss } from "./dismiss.js";

type Node = { contains?: (n: unknown) => boolean } | null | undefined;

/** While `open`, a press outside every ref in `inside` (the popover and the control that opened it) calls `onClose`, and so does Esc unless `esc` is false. */
export function usePopoverDismiss(open: boolean, inside: readonly { current: unknown }[], onClose: () => void, o?: { esc?: boolean }) {
  const close = useRef(onClose);
  close.current = onClose;
  const refs = useRef(inside);
  refs.current = inside;
  const esc = o?.esc !== false;
  useEffect(() => {
    if (!open) return;
    if (Platform.OS !== "web") {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => { close.current(); return true; });
      return () => sub.remove();
    }
    return attachDismiss(typeof document === "undefined" ? null : document, () => refs.current.map((r) => r.current as Node), () => close.current(), { esc });
  }, [open, esc]);
}
