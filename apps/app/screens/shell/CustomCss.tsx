// The custom CSS the owner approved (core/design, design.css): drawn on the web app only, as one <style> element. It styles the design language's own hooks ([data-screen], [data-block]) with
// design tokens; the box checked it (a linter, then a yes), and turns it off itself if an update would break it, so this only draws what is on. Phones and Lumen keep the tokens.
import { useEffect } from "react";
import { Platform } from "react-native";
import { allowsMock } from "@vyre/ui";
import { tool } from "../../src/real/box";

const ID = "vyre-custom-css";

export function CustomCss() {
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined" || allowsMock()) return;
    let live = true;
    tool<{ css: { scope: string; css: string }[] }>("design.css", {})
      .then((d) => {
        if (!live) return;
        const text = (d.css ?? []).map((c) => c.css).join("\n");
        let el = document.getElementById(ID) as HTMLStyleElement | null;
        if (!text) { el?.remove(); return; }
        if (!el) { el = document.createElement("style"); el.id = ID; document.head.appendChild(el); }
        el.textContent = text;
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return null;
}
