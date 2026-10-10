// Chat's markdown, drawn with the design system's own components from the closed tree markdown/parse.js makes: paragraphs, headings, bold, italic, lists, links, inline code, quotes, tables, rules and code blocks.
// Nothing is ever drawn from the model's markup: there is no HTML node, and a link opens only if it is http, https or mailto (and opens outside the app).
import { Fragment, useMemo } from "react";
import { Linking, Platform, ScrollView, View } from "react-native";
import { CodeBlock } from "./CodeBlock";
import { Text } from "./Text";
import { useUiTheme } from "../theme";
import { parse, plainOf, safeHref } from "../markdown/parse.js";

type Node = { t: string; [k: string]: any };

/** A link opens outside: a new tab on the web (no opener), the system's handler on a device. Only a safe address gets here. */
export function openOutside(href: string) {
  if (!safeHref(href)) return;
  if (Platform.OS === "web") window.open(href, "_blank", "noopener,noreferrer");
  else void Linking.openURL(href);
}

type Ctx = { onCopy?: (code: string) => void; onLink: (href: string) => void; textNode?: (v: string) => React.ReactNode; color: Record<string, string>; phone: boolean };

function Inline({ nodes, ctx, base }: { nodes: Node[]; ctx: Ctx; base?: { bold?: boolean; italic?: boolean } }) {
  return (
    <>
      {nodes.map((n, i) => {
        if (n.t === "text") return <Fragment key={i}>{ctx.textNode ? ctx.textNode(n.v) : n.v}</Fragment>;
        if (n.t === "br") return <Fragment key={i}>{"\n"}</Fragment>;
        if (n.t === "code") return <Text key={i} mono size="read" style={{ fontSize: 14, backgroundColor: ctx.color["surface-3"] }}>{`\u00A0${n.v}\u00A0`}</Text>;
        if (n.t === "b") return <Text key={i} size="read" strong style={base?.italic ? { fontStyle: "italic" } : undefined}><Inline nodes={n.c} ctx={ctx} base={{ ...base, bold: true }} /></Text>;
        if (n.t === "i") return <Text key={i} size="read" strong={base?.bold} style={{ fontStyle: "italic" }}><Inline nodes={n.c} ctx={ctx} base={{ ...base, italic: true }} /></Text>;
        if (n.t === "a") return <Text key={i} size="read" tone="accent" accessibilityRole="link" onPress={() => ctx.onLink(n.href)} style={{ textDecorationLine: "underline" }}><Inline nodes={n.c} ctx={ctx} base={base} /></Text>;
        return null;
      })}
    </>
  );
}

function Para({ nodes, ctx, size = "read", strong, tail }: { nodes: Node[]; ctx: Ctx; size?: "read" | "title" | "headline"; strong?: boolean; tail?: React.ReactNode }) {
  return <Text size={size} strong={strong} selectable><Inline nodes={nodes} ctx={ctx} base={{ bold: strong }} />{tail}</Text>;
}

function Block({ b, ctx, depth, tail }: { b: Node; ctx: Ctx; depth: number; tail?: React.ReactNode }) {
  switch (b.t) {
    case "p": return <Para nodes={b.c} ctx={ctx} tail={tail} />;
    case "h": return <View style={{ paddingTop: b.level <= 2 ? 6 : 2 }}><Para nodes={b.c} ctx={ctx} size={b.level === 1 ? "title" : b.level === 2 ? "headline" : "read"} strong tail={tail} /></View>;
    case "code": return <CodeBlock code={b.text} lang={b.lang} onCopy={ctx.onCopy} />;
    case "rule": return <View accessibilityRole="none" style={{ height: 1, backgroundColor: ctx.color.edge, marginVertical: 4 }} />;
    case "quote": return (
      <View style={{ borderLeftWidth: 3, borderLeftColor: ctx.color["edge-strong"], paddingLeft: 12, gap: 8 }}>
        {b.c.map((x: Node, i: number) => <Block key={i} b={x} ctx={ctx} depth={depth + 1} />)}
      </View>
    );
    case "list": return (
      <View style={{ gap: 6, paddingLeft: depth ? 4 : 0 }}>
        {b.items.map((it: Node[], i: number) => (
          <View key={i} style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
            <Text size="read" tone="label" style={{ minWidth: b.ordered ? 22 : 12, textAlign: b.ordered ? "right" : "left" }}>{b.ordered ? `${b.start + i}.` : "•"}</Text>
            <View style={{ flex: 1, minWidth: 0, gap: 6 }}>{it.map((x, k) => <Block key={k} b={x} ctx={ctx} depth={depth + 1} />)}</View>
          </View>
        ))}
      </View>
    );
    case "table": {
      // one width per column, from its longest cell, so the columns line up down the table
      const widths: number[] = b.head.map((_: unknown, c: number) => Math.max(96, Math.min(280, 20 + 8 * Math.max(...[b.head, ...b.rows].map((row: Node[][]) => (row[c] ? plainOf(row[c]).length : 0))))));
      return (
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
        <View accessibilityRole="none" style={{ borderWidth: 1, borderColor: ctx.color.edge, borderRadius: 10, overflow: "hidden" }}>
          {[b.head, ...b.rows].map((row: Node[][], r: number) => (
            <View key={r} style={{ flexDirection: "row", backgroundColor: r === 0 ? ctx.color["surface-3"] : undefined, borderTopWidth: r ? 1 : 0, borderTopColor: ctx.color.edge }}>
              {b.head.map((_: unknown, c: number) => (
                <View key={c} style={{ width: widths[c], paddingHorizontal: 10, paddingVertical: 7, borderLeftWidth: c ? 1 : 0, borderLeftColor: ctx.color.edge }}>
                  <Text size="secondary" strong={r === 0} style={{ textAlign: b.align[c] ?? "left" }} selectable>{row[c] ? <Inline nodes={row[c]} ctx={ctx} base={{ bold: r === 0 }} /> : ""}</Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
      );
    }
    default: return null;
  }
}

/**
 * Markdown as the design system draws it. `onCopy` is how a code block's Copy reaches the clipboard (the web's own when none is given); `textNode` draws a run of plain words (chat uses it to turn a Vault reference
 * into its chip); `onLink` replaces the default of opening outside. A tree is made once per text.
 */
export function Markdown({ text, onCopy, onLink, textNode, tail }: { text: string; onCopy?: (code: string) => void; onLink?: (href: string) => void; textNode?: (v: string) => React.ReactNode; tail?: React.ReactNode }) {
  const { color, phone } = useUiTheme();
  const tree = useMemo(() => parse(text), [text]);
  const ctx: Ctx = { onCopy, onLink: onLink ?? openOutside, textNode, color: color as unknown as Record<string, string>, phone };
  if (!tree.length) return tail ? <Text size="read">{tail}</Text> : null;
  const last = tree.length - 1, inLast = tree[last].t === "p" || tree[last].t === "h";
  // `tail` (the soft caret of a reply still arriving) ends the last line of words; after a code block or a table it sits on a line of its own
  return <View style={{ gap: 10, minWidth: 0 }}>{tree.map((b, i) => <Block key={i} b={b} ctx={ctx} depth={0} tail={i === last && inLast ? tail : undefined} />)}{tail && !inLast ? <Text size="read">{tail}</Text> : null}</View>;
}

export { plainOf };
