import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { attachDismiss } from "./dismiss.js";

// The owner hit it live: the New menu and the composer's + menu stayed open after a click elsewhere. Every popover closes on a press outside and on Esc, and the rule lives in @vyre/ui.

const fakeDoc = () => {
  /** @type {Map<string, Set<(e: any) => void>>} */
  const on = new Map();
  return {
    on,
    addEventListener: (t, f) => { if (!on.has(t)) on.set(t, new Set()); on.get(t).add(f); },
    removeEventListener: (t, f) => { on.get(t)?.delete(f); },
    fire: (t, e) => { for (const f of [...(on.get(t) ?? [])]) f(e); },
  };
};
const node = (/** @type {Set<any>} */ kids) => ({ contains: (n) => kids.has(n) });

test("a press outside the popover closes it; a press inside it or on its opener does not", () => {
  const doc = fakeDoc();
  const inPop = {}, onPlus = {}, elsewhere = {};
  let closed = 0;
  const off = attachDismiss(doc, () => [node(new Set([inPop])), node(new Set([onPlus])), null], () => closed++);
  doc.fire("pointerdown", { target: inPop });
  doc.fire("pointerdown", { target: onPlus });
  assert.equal(closed, 0, "inside presses keep it open");
  doc.fire("pointerdown", { target: elsewhere });
  assert.equal(closed, 1, "a press elsewhere closes it");
  off();
  doc.fire("pointerdown", { target: elsewhere });
  assert.equal(closed, 1, "once closed it stops listening");
  assert.equal(doc.on.get("pointerdown")?.size, 0);
  assert.equal(doc.on.get("keydown")?.size, 0);
});

test("Esc closes it, other keys do not, and a popover that reads Esc itself can opt out", () => {
  const doc = fakeDoc();
  let closed = 0;
  attachDismiss(doc, () => [], () => closed++);
  doc.fire("keydown", { key: "a" });
  doc.fire("keydown", { key: "Escape" });
  assert.equal(closed, 1);
  const doc2 = fakeDoc();
  attachDismiss(doc2, () => [], () => closed++, { esc: false });
  assert.equal(doc2.on.get("keydown"), undefined, "no Esc listener when the popover owns Esc");
});

test("no document (a phone) is a no-op that still returns a stop function", () => {
  const off = attachDismiss(null, () => [], () => { throw new Error("never"); });
  assert.equal(typeof off, "function");
  off();
});

test("the shared popovers use the one rule: the New menu, the composer's menus; Menu keeps its primitive's dismiss", () => {
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
  assert.match(read("../chat/NewPopover.tsx"), /usePopoverDismiss\(open, /, "the New menu closes on an outside press and Esc");
  assert.match(read("../../src/chat/ChatComposer.tsx"), /usePopoverDismiss\(!!pop, \[rootRef\]/, "the composer's + menu closes on an outside press");
  assert.match(read("../../screens/chats/ChatsSidebar.tsx"), /anchor=\{plusAnchor\}/, "the + that opens the New menu toggles it rather than counting as outside");
  const menu = read("../components/Menu.tsx");
  assert.match(menu, /@rn-primitives\/dropdown-menu/, "Menu dismisses through its primitive (outside press and Esc on the web)");
  assert.match(menu, /<P\.Overlay/, "and through an overlay on a phone");
  assert.match(read("../index.ts"), /export \{ usePopoverDismiss \} from "\.\/lib\/useDismiss"/, "screens reach it from @vyre/ui");
});
