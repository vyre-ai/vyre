import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { enterAction, focusFirst, formFields, selectField, wireFormKeys } from "./form-keys.js";

// A form the size of a screen, with no browser: inputs that take focus and a form element that takes one keydown listener.
function page(specs, { button } = {}) {
  const doc = { active: null };
  const inputs = specs.map((s) => ({ tagName: "INPUT", type: "text", value: "", disabled: false, readOnly: false, tabIndex: 0, selected: false, ...s, focus() { doc.active = this; }, select() { this.selected = true; } }));
  const listeners = new Set();
  const form = {
    querySelectorAll: (sel) => (sel === "input" ? inputs : []),
    addEventListener: (type, fn) => { if (type === "keydown") listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === "keydown") listeners.delete(fn); },
  };
  const primary = button ? { focus() { doc.active = this; }, getAttribute: (n) => (n === "aria-disabled" ? (button.disabled ? "true" : null) : null) } : null;
  const press = (target, key = "Enter", more = {}) => {
    const e = { key, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...more };
    for (const fn of listeners) fn(e);
    return e;
  };
  return { doc, inputs, form, primary, press, listeners };
}
const byLabel = (p, label) => p.inputs.find((i) => i.label === label);
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("Enter in the unlock password field calls unlock, once", () => {
  const p = page([{ label: "Password", type: "password", value: "correct horse battery" }]);
  let unlocks = 0;
  wireFormKeys(p.form, () => unlocks++);
  const e = p.press(byLabel(p, "Password"));
  assert.equal(unlocks, 1);
  // the key is marked as taken, so the TextInput's own onSubmitEditing (react-native-web checks isDefaultPrevented) does not unlock a second time
  assert.equal(e.defaultPrevented, true);
});

test("the unlock password field is focused when the cover appears, and Enter on the cover is wired", () => {
  const p = page([{ label: "Password", type: "password" }]);
  assert.equal(focusFirst(p.form), byLabel(p, "Password"));
  assert.equal(p.doc.active, byLabel(p, "Password"));
  const screen = src("../../screens/unlock/UnlockScreen.tsx");
  assert.match(screen, /autoFocus: true/, "the field asks for focus when it mounts");
  assert.match(screen, /useEffect\(\(\) => \{ if \(web\) focusFirst\(form\.current\); \}, \[web, mode\]\)/, "and the cover puts the caret there itself, for each mode");
  assert.match(screen, /wireFormKeys\(el, \(\) => go\.current\(\)\)/, "Enter on the cover runs the current unlock");
  assert.match(screen, /<View ref=\{form\} id=\{CONTENT_ID\}/, "the listener sits on the cover's column, around the field");
  assert.match(screen, /window\.addEventListener\("focus", back\)/, "the window coming back puts the caret back");
});

test("a refused password keeps the focus and is selected, ready to be typed again", () => {
  const p = page([{ label: "Password", type: "password", value: "wrong" }]);
  selectField(p.form);
  assert.equal(p.doc.active, byLabel(p, "Password"));
  assert.equal(byLabel(p, "Password").selected, true);
  assert.match(src("../../screens/unlock/UnlockScreen.tsx"), /if \(web && failure && !busy\) selectField\(form\.current\)/);
});

test("Enter goes field to field on the sign-in step and signs in from the last one", () => {
  const p = page([{ label: "Space address", value: "juniper.vyre.run" }, { label: "Username" }, { label: "Password", type: "password" }, { label: "Show", type: "checkbox" }]);
  let signIns = 0;
  wireFormKeys(p.form, () => signIns++);
  // the first empty field has the caret: the address came from the welcome
  assert.equal(focusFirst(p.form), byLabel(p, "Username"));
  p.press(byLabel(p, "Space address"));
  assert.equal(p.doc.active, byLabel(p, "Username"));
  p.press(byLabel(p, "Username"));
  assert.equal(p.doc.active, byLabel(p, "Password"));
  assert.equal(signIns, 0);
  p.press(byLabel(p, "Password"));
  assert.equal(signIns, 1);
});

test("every first-run and sign-in step is a FlowStep, which wires Enter to its primary and focuses each new step", () => {
  const step = src("../components/FlowStep.tsx");
  assert.match(step, /wireFormKeys\(form\.current, /);
  assert.match(step, /if \(on && p && !p\.disabled && !p\.loading\) p\.onPress\(\)/, "a disabled or busy primary is not pressed by Enter");
  assert.match(step, /\}, \[web, title\]\);/, "a new title is a new step, so the caret moves there");
  const first = src("../../screens/first-run/FirstRun.tsx");
  for (const screen of ["id.name", "id.signin", "id.signin.spaces", "id.create", "id.password", "join.link", "create.kind"]) {
    const at = first.indexOf(`if (screen === "${screen}")`);
    assert.ok(at > 0, screen);
    // the two sign-in steps are the views in SignInSteps.tsx (the gallery draws them too), which are FlowSteps with a primary
    const sign = screen === "id.signin" || screen === "id.signin.spaces";
    assert.match(first.slice(at, at + 1100), sign ? /<(SignInStep|SpacesStep) [^]*onSubmit=\{/ : /<FlowStep [^]*primary=\{\{/, `${screen} draws a FlowStep with a primary`);
  }
  const steps = src("../../screens/first-run/SignInSteps.tsx");
  assert.equal((steps.match(/<FlowStep [^]*?primary=\{\{/g) || []).length, 2, "both sign-in views are a FlowStep with a primary");
  // the welcome's Space field has the caret on the web, and its round arrow goes on with Enter
  const welcome = src("../../screens/first-run/Welcome.tsx");
  assert.match(welcome, /accessibilityLabel: "Space name", autoFocus: Platform\.OS === "web"/);
  assert.match(welcome, /onSubmitEditing=\{\(\) => \{ if \(!disabled\) onGo\(\); \}\}/);
});

test("a step with no field puts the caret on its primary, unless the primary is waiting", () => {
  const p = page([], { button: { disabled: false } });
  assert.equal(focusFirst(p.form, p.primary), p.primary);
  const q = page([], { button: { disabled: true } });
  assert.equal(focusFirst(q.form, q.primary), null);
  assert.equal(q.doc.active, null);
});

test("Enter is left alone with Shift or a modifier, while a word is composed, when already taken, and outside a field", () => {
  assert.equal(enterAction({ key: "Enter" }, 0, 2), "next");
  assert.equal(enterAction({ key: "Enter" }, 1, 2), "submit");
  assert.equal(enterAction({ key: "Enter", shiftKey: true }, 1, 2), null);
  assert.equal(enterAction({ key: "Enter", metaKey: true }, 1, 2), null);
  assert.equal(enterAction({ key: "Enter", isComposing: true }, 1, 2), null);
  assert.equal(enterAction({ key: "Enter", keyCode: 229 }, 1, 2), null);
  assert.equal(enterAction({ key: "Enter", defaultPrevented: true }, 1, 2), null);
  assert.equal(enterAction({ key: "Tab" }, 0, 2), null);
  assert.equal(enterAction({ key: "Enter" }, -1, 2), null);
  const p = page([{ label: "Password", type: "password" }]);
  let n = 0;
  wireFormKeys(p.form, () => n++);
  assert.equal(p.press({ tagName: "DIV" }).defaultPrevented, false, "Enter on a button is the button's own");
  assert.equal(n, 0);
});

test("only fields a person can type in count, and unwiring takes the listener off", () => {
  const p = page([{ label: "a" }, { label: "b", disabled: true }, { label: "c", readOnly: true }, { label: "d", type: "checkbox" }, { label: "e", tabIndex: -1 }, { label: "f", type: "email" }]);
  assert.deepEqual(formFields(p.form).map((i) => i.label), ["a", "f"]);
  assert.deepEqual(formFields(null), []);
  const off = wireFormKeys(p.form, () => {});
  assert.equal(p.listeners.size, 1);
  off();
  assert.equal(p.listeners.size, 0);
  assert.doesNotThrow(() => wireFormKeys(null, () => {})());
});
