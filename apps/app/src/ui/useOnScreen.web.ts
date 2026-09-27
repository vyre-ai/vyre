// On the web a View is a DOM element: an IntersectionObserver says when it enters or leaves the
// viewport, on the browser's own schedule, with nothing run per scroll.
import { useEffect, useState, type RefObject } from "react";
import type { View } from "react-native";

export function useOnScreen(ref: RefObject<View | null>): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current as unknown as Element | null;
    if (!el || typeof IntersectionObserver === "undefined") {
      setOn(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) setOn(e.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return on;
}
