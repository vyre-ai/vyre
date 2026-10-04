// HD-6 (reviewer-2, group D): the click guard is an allow-list. A control is observable only when it is passive or named for moving, showing or selecting; everything else, an unreadable name
// included, is consequential, so an agent cannot approve an OAuth screen by clicking "Authorize".
import { test } from "node:test";
import assert from "node:assert/strict";
import * as hc from "./consequence.js";
import * as hd from "../hands-desktop/consequence.js";

for (const [label, c] of [["hands-chrome", hc], ["hands-desktop", hd]]) {
  test(`${label}: names that grant, accept or save are consequential`, () => {
    for (const name of ["Authorize", "Allow", "Accept", "Save", "Continue", "Grant access", "Enable", "Apply", "Order", "Log in", "Sign in", "OK", "Yes", "Done", "Install", "Connect"]) {
      assert.equal(c.of({ role: "button", name }).consequential, true, name);
    }
  });
  test(`${label}: moving, showing and selecting stay observable`, () => {
    for (const name of ["Back", "Next", "Close", "Cancel", "Show more", "Menu", "Search", "Page 2", "3", "Expand all"]) assert.equal(c.of({ role: "button", name }).consequential, false, name);
    assert.equal(c.of({ role: "entry", name: "Filename" }).consequential, false);
    assert.equal(c.of({ role: "textbox", name: "Search the web" }).consequential, false);
  });
  test(`${label}: an unreadable name stays consequential, and the old list still vetoes`, () => {
    assert.equal(c.of({ role: "button", name: " " }).consequential, true);
    assert.equal(c.of({ role: "button", nameless: true }).consequential, true);
    assert.equal(c.of({ role: "button", name: "Go back and send" }).consequential, true);
    assert.equal(c.of({ role: "entry", name: "Send to" }).consequential, true);
  });
}
