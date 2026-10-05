import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { MY_CLOUD, QUESTION, SERVER_SETUP_ROUTE } from "./first-run.js";
import { backOf, startStep } from "./flow.js";

const here = (p) => new URL(p, import.meta.url);

test("setup asks one question, in the user's words, and never says Pro or Basic", () => {
  assert.equal(QUESTION.title, "Do you have your own server, or are you joining a team?");
  assert.equal(QUESTION.own.line, "Set up My Cloud on it.");
  const all = JSON.stringify([QUESTION, MY_CLOUD]);
  assert.doesNotMatch(all, /\b(Pro|Basic)\b/);
  assert.ok(!/—/.test(all), "no dash");
});

test("the server path has a route the app can link to, and the flow knows it", () => {
  assert.equal(SERVER_SETUP_ROUTE, "/u/setup/server");
  assert.ok(existsSync(here("../../app/u/setup/server.tsx")), "the route file");
  assert.match(readFileSync(here("../../app/u/setup/server.tsx"), "utf8"), /<InstallScreen start="server" \/>/);
  assert.equal(startStep("server"), "mycloud");
});

test("Back walks welcome, the question, then name or My Cloud, and nothing skips the question", () => {
  assert.equal(backOf("question", { welcome: true }), "welcome");
  assert.equal(backOf("name", { welcome: true }), "question");
  assert.equal(backOf("have", { welcome: true }), "welcome");
  assert.equal(backOf("mycloud", { welcome: true }), "question");
});

test("the screen: Get started goes to the question; both answers go through afterQuestion; My Cloud never shows a phone an install line", () => {
  const src = readFileSync(here("./InstallScreen.tsx"), "utf8");
  assert.match(src, /label=\{WELCOME\.start\} onPress=\{\(\) => setStep\("question"\)\}/);
  assert.match(src, /title=\{QUESTION\.join\.title\}[^\n]*setStep\(afterQuestion\("join", false\)\)/);
  assert.match(src, /title=\{QUESTION\.own\.title\}[^\n]*afterQuestion\("own"/);
  const mc = src.slice(src.indexOf('} else if (step === "mycloud")'), src.indexOf('} else if (step === "browser" ||'));
  assert.match(mc, /isPhone\(dk\) \? \(/);
  assert.match(mc, /Share\.share\(\{ message: MY_CLOUD\.share \}\)/);
  assert.ok(mc.indexOf("Share.share") < mc.indexOf("installLine"), "the phone branch comes first and has no line");
  assert.match(mc, /isWindowsShell\(\) \? <Banner tone="warn">\{MY_CLOUD\.windows\}<\/Banner>/, "a Windows shell says a home cannot run there");
});
