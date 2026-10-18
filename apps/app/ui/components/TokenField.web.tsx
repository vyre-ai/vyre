import { createElement, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Text } from "./Text";
import { cn } from "../lib/cn";
import { facesFor } from "../../src/theme/fonts";
import { useUiTheme } from "../theme";
import { insertToken, pillLabel, segmentsOf } from "./token-field-model.js";
import type { TokenFieldProps } from "./TokenField";

/** The text of the box: words as typed, each pill as its `{token}`, a line break as a newline. */
function read(el: any): string {
  let out = "";
  el.childNodes.forEach((n: any) => {
    if (n.nodeType === 3) out += n.nodeValue;
    else if (n.dataset && n.dataset.token !== undefined) out += `{${n.dataset.token}}`;
    else if (n.nodeName === "BR") out += "\n";
    else if (n.nodeName === "DIV") out += `\n${read(n)}`;
    else out += n.textContent ?? "";
  });
  return out;
}

/** The web build: a box you type in, where each value is a pill (remove it with its x; type / or { to pick one). The stored text is the same `{token}` text every other build holds. */
export function TokenField({ label, name, value, onChange, options, placeholder, help, multiline, lines = 3, disabled }: TokenFieldProps) {
  const { color, resolved } = useUiTheme();
  const faces = facesFor(resolved.font);
  const box = useRef<any>(null);
  const range = useRef<any>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const draw = (el: any, text: string) => {
    el.textContent = "";
    for (const s of segmentsOf(text)) {
      if ("text" in s) { s.text.split("\n").forEach((line, i) => { if (i) el.appendChild(document.createElement("br")); if (line) el.appendChild(document.createTextNode(line)); }); continue; }
      el.appendChild(pill(s.token));
    }
  };
  const pill = (token: string) => {
    const p = document.createElement("span");
    p.dataset.token = token;
    p.contentEditable = "false";
    p.textContent = pillLabel(token, options);
    Object.assign(p.style, { display: "inline-flex", alignItems: "center", gap: "4px", padding: "0 3px 0 8px", margin: "0 1px", borderRadius: "999px", background: color["surface-3"], border: `1px solid ${color.edge}`, fontSize: "12px", lineHeight: "20px", userSelect: "none", whiteSpace: "nowrap" });
    const x = document.createElement("b");
    x.dataset.x = "1";
    x.title = "Remove";
    x.textContent = "×";
    Object.assign(x.style, { cursor: "pointer", opacity: "0.6", fontWeight: "400", padding: "0 3px" });
    p.appendChild(x);
    return p;
  };
  useEffect(() => { const el = box.current; if (el && read(el) !== value) draw(el, value); }, [value, options]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = () => onChange(read(box.current));
  const put = (token: string) => {
    const el = box.current;
    if (!el) return;
    const r = range.current && el.contains(range.current.startContainer) ? range.current : null;
    if (!r) { onChange(insertToken(read(el), token)); setMenu(null); return; }
    const p = pill(token);
    r.deleteContents(); r.insertNode(p); r.setStartAfter(p); r.collapse(true);
    const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(r);
    setMenu(null); changed();
  };
  return (
    <View className="min-w-0 gap-s1">
      {label ? <Text size="caption" strong tone="label">{label}</Text> : null}
      {createElement("div", {
        ref: box, contentEditable: !disabled, role: "textbox", "aria-multiline": !!multiline, "aria-label": name ?? label, "data-placeholder": placeholder ?? "",
        className: cn("min-w-0 rounded-field border bg-surface-3 px-s3 py-s2 text-body text-text", disabled && "opacity-60", "border-edge"),
        style: { ...(faces.regular as object), color: color.text, outlineStyle: "none", minHeight: multiline ? lines * 24 + 16 : 40, whiteSpace: multiline ? "pre-wrap" : "nowrap", overflow: multiline ? "visible" : "hidden", lineHeight: "24px" },
        onInput: changed,
        onClick: (e: any) => { const t = e.target; if (t && t.dataset && t.dataset.x) { t.parentNode.remove(); changed(); } },
        onKeyDown: (e: any) => {
          if (!multiline && e.key === "Enter") { e.preventDefault(); return; }
          if (e.key === "/" || e.key === "{") {
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount || !options.length) return;
            e.preventDefault();
            range.current = sel.getRangeAt(0).cloneRange();
            const b = range.current.getBoundingClientRect();
            setMenu({ x: b.left, y: b.bottom + 6 });
          } else if (e.key === "Escape") setMenu(null);
        },
        onBlur: () => setTimeout(() => setMenu(null), 150),
      })}
      {menu ? createElement("div", { style: { position: "fixed", left: Math.min(menu.x, window.innerWidth - 260), top: menu.y, zIndex: 60, minWidth: 220, maxHeight: 260, overflow: "auto", padding: 4, borderRadius: 12, background: color["surface-2"], border: `1px solid ${color.edge}` } },
        options.map((o) => createElement("button", { key: o.token, type: "button", onMouseDown: (e: any) => { e.preventDefault(); put(o.token.replace(/^\{|\}$/g, "")); }, style: { display: "block", width: "100%", textAlign: "left", padding: "6px 10px", borderRadius: 8, fontSize: 13, color: color.text, opacity: o.maybe ? 0.55 : 1, background: "none", border: "none", cursor: "pointer" } }, o.label))) : null}
      {help ? <Text size="caption" tone="label">{help}</Text> : null}
    </View>
  );
}
