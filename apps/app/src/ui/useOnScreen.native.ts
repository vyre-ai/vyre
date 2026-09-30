// Native has no IntersectionObserver: the view measures itself in the window when it is laid out
// and each time the scroller around it moves (ScrollSignal, at most every 100 ms), and compares that
// with the window's height.
import { useContext, useEffect, useState, type RefObject } from "react";
import { Dimensions, type View } from "react-native";
import { overlaps } from "./onscreen.js";
import { ScrollSignal } from "./scroll-signal";

export function useOnScreen(ref: RefObject<View | null>): boolean {
  const signal = useContext(ScrollSignal);
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    const check = () =>
      ref.current?.measureInWindow((_x, y, _w, h) => {
        if (live) setOn(overlaps(y, h, 0, Dimensions.get("window").height));
      });
    const first = setTimeout(check, 0);
    const off = signal ? signal.on(check) : () => {};
    return () => {
      live = false;
      clearTimeout(first);
      off();
    };
  }, [ref, signal]);
  return on;
}

