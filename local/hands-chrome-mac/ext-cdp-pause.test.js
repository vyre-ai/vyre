// @ts-check
// cdp: children that start paused while a guard is up, and the fallback that resumes one nobody resumed.
import test from "node:test";
import assert from "node:assert/strict";
import { createCdp } from "./extension/lib/cdp.js";
import { createFakeChrome } from "./test-support/fake-chrome.js";

test("setPause re-asks auto-attach with waitForDebuggerOnStart on the tab and on every child session, and new children inherit it", async () => {
  const chrome = createFakeChrome([{ url: "https://a.example/", active: true }]);
  const cdp = createCdp({ chrome });
  await cdp.attach(1);
  /** @type {any[]} */ const asked = [];
  const real = chrome.debugger.sendCommand.bind(chrome.debugger);
  chrome.debugger.sendCommand = async (/** @type {any} */ target, /** @type {string} */ method, /** @type {any} */ params) => { if (method === "Target.setAutoAttach") asked.push([target.sessionId || "top", params.waitForDebuggerOnStart]); return real(target, method, params); };
  // a child exists
  chrome._.onEvent.fire({ tabId: 1 }, "Target.attachedToTarget", { sessionId: "S-A", targetInfo: { targetId: "A", type: "iframe", url: "https://b.example/" } });
  await new Promise(r => setTimeout(r, 5));
  asked.length = 0;
  assert.equal(await cdp.setPause(1, true), true);
  assert.ok(asked.some(a => a[0] === "top" && a[1] === true), "the tab's session");
  assert.ok(asked.some(a => a[0] === "S-A" && a[1] === true), "the child session");
  asked.length = 0;
  chrome._.onEvent.fire({ tabId: 1 }, "Target.attachedToTarget", { sessionId: "S-B", targetInfo: { targetId: "B", type: "iframe", url: "https://c.example/" } });
  await new Promise(r => setTimeout(r, 5));
  assert.ok(asked.some(a => a[0] === "S-B" && a[1] === true), "a child that attaches while pausing is on asks ITS children to pause too");
  asked.length = 0;
  await cdp.setPause(1, false);
  assert.ok(asked.every(a => a[1] === false));
});

test("a waiting child is never released by the fallback while pausing is on; turning pausing off releases the tab's waiting children at once, and a failing ask is retried once", async () => {
  const chrome = createFakeChrome([{ url: "https://a.example/", active: true }, { url: "https://b.example/" }]);
  const cdp = createCdp({ chrome });
  await cdp.attach(1);
  /** @type {any[]} */ const resumes = [];
  let failAsks = 0;
  const real = chrome.debugger.sendCommand.bind(chrome.debugger);
  chrome.debugger.sendCommand = async (/** @type {any} */ target, /** @type {string} */ method, /** @type {any} */ params) => {
    if (method === "Runtime.runIfWaitingForDebugger") resumes.push(target.sessionId);
    if (method === "Target.setAutoAttach" && params.waitForDebuggerOnStart === false && failAsks > 0) { failAsks--; throw new Error("Timed out"); }
    return real(target, method, params);
  };
  await cdp.setPause(1, true);
  chrome._.onEvent.fire({ tabId: 1 }, "Target.attachedToTarget", { sessionId: "S-W", waitingForDebugger: true, targetInfo: { targetId: "W", type: "iframe", url: "https://c.example/" } });
  chrome._.onEvent.fire({ tabId: 2 }, "Target.attachedToTarget", { sessionId: "S-OTHER", waitingForDebugger: true, targetInfo: { targetId: "O", type: "iframe", url: "https://d.example/" } });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(resumes, ["S-OTHER"], "the tab with pausing on keeps its child waiting; a child on a tab we are not pausing is resumed at once");
  failAsks = 1; // the first turn-off ask fails: it is asked again
  assert.equal(await cdp.setPause(1, false), true);
  assert.ok(resumes.includes("S-W"), "released at once when pausing goes off");
  assert.equal(resumes.filter(x => x === "S-OTHER").length, 1, "another tab's child is not touched again by this tab's turn-off");
});
