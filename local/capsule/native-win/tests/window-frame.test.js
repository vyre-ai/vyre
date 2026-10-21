import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rs = readFileSync(new URL("../app/src/main.rs", import.meta.url), "utf8");
const frame = readFileSync(new URL("../app/src/window_frame.rs", import.meta.url), "utf8");

test("the window is titled Vyre, remembers its frame, uses Segoe UI, and hides the web view scrollbar", () => {
  assert.match(rs, /const APP_NAME: &str = "Vyre"/);
  assert.match(rs, /\.title\(APP_NAME\)/);
  assert.match(rs, /inner_size\(window_frame::DEFAULT_W, window_frame::DEFAULT_H\)/);
  assert.match(rs, /min_inner_size\(window_frame::MIN_W, window_frame::MIN_H\)/);
  assert.match(rs, /window_frame::load\(app\)/);
  assert.match(rs, /window_frame::save\(&app_for_frame, &w2\)/);
  assert.match(rs, /Segoe UI/);
  assert.match(rs, /::-webkit-scrollbar\{width:0;height:0;display:none\}/);
  assert.match(frame, /window\.json/);
  assert.match(frame, /pub const DEFAULT_W: f64 = 1180\.0/);
  assert.match(frame, /pub const DEFAULT_H: f64 = 780\.0/);
  assert.match(frame, /pub const MIN_W: f64 = 380\.0/);
  assert.match(frame, /pub const MIN_H: f64 = 560\.0/);
});

test("the window itself does not ask for Windows Hello", () => {
  const show = /fn show_app\([\s\S]*?\n}\n/.exec(rs)[0];
  const panel = /fn show_panel\([\s\S]*?\n}\n/.exec(rs)[0];
  assert.doesNotMatch(show, /Windows Hello|ncrypt::/);
  assert.doesNotMatch(panel, /Windows Hello|ncrypt::/);
});
