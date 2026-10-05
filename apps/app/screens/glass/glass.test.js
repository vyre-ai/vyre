// @ts-check
// Glass against a fake box: tool names and inputs, the shapes picked, and the rules of the stream and the take-over.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    if (o.error?.[tool]) return { error: o.error[tool] };
    switch (tool) {
      case "glass.targets": return { data: [{ target: "computer:kit", state: "working", viewers: ["a", "b"], takeover: { surface: "web:ab12", since: 5, private: true }, width: 1440, height: 900 }, { target: "box", screen: false, viewers: 1 }, { nope: 1 }] };
      case "glass.open": return { data: o.open ?? { session: "s1", link: { path: "relay", latencyMs: 41.6 }, screen: { path: "/v1/streams/computers/glass?t=abc", width: 1280, height: 800 } } };
      case "glass.take": return { data: { since: 99, private: input.private === true } };
      case "glass.release": return { data: o.release ?? { held_ms: 125000, noted: true } };
      case "glass.files.list": return { data: { path: input.path ?? "", entries: [{ name: "b.txt", kind: "file", size: 10, mtime: 1 }, { name: "z", kind: "dir" }, { name: "a", kind: "dir" }, { kind: "file" }] } };
      case "glass.files.preview": return { data: o.preview ?? { kind: "text", text: "hello", truncated: true } };
      case "glass.files.download": return { data: { path: "/v1/glass/raw?t=1", name: "b.txt" } };
      case "glass.files.upload": return { data: { path: "/v1/glass/put?t=2" } };
      default: return { data: {} };
    }
  };
  return { call, seen };
}

test("targets: only rows with a target; viewers counted; the box has no screen; the holder is read", { skip: !strip }, async () => {
  const { glassSource } = await import("./source.ts");
  const t = await glassSource(box().call).targets();
  assert.deepEqual(t.map((x) => [x.target, x.screen, x.viewers]), [["computer:kit", true, 2], ["box", false, 1]]);
  assert.deepEqual(t[0].holder, { surface: "web:ab12", since: 5, private: true });
  assert.equal(t[1].holder, null);
});

test("open: the session, the link and the stream path; a path off the box is dropped", { skip: !strip }, async () => {
  const { glassSource } = await import("./source.ts");
  const b = box();
  const r = await glassSource(b.call).open("computer:kit", "web:ab12");
  assert.deepEqual(b.seen[0], { tool: "glass.open", input: { target: "computer:kit", surface: "web:ab12" } });
  assert.deepEqual(r, { session: "s1", link: { path: "relay", latencyMs: 41.6 }, screen: { path: "/v1/streams/computers/glass?t=abc", width: 1280, height: 800 } });
  const off = await glassSource(box({ open: { session: "s", screen: { path: "wss://evil.example/x" } } }).call).open("computer:kit", "x");
  assert.equal(off.screen, null);
  assert.equal((await glassSource(box({ open: { session: "s" } }).call).open("computer:kit", "x")).screen, null);
});

test("take and release: inputs, the held time, a note only when typed", { skip: !strip }, async () => {
  const { glassSource } = await import("./source.ts");
  const b = box();
  const s = glassSource(b.call);
  assert.deepEqual(await s.take("computer:kit", "web:1", false), { surface: "web:1", since: 99, private: false });
  assert.deepEqual(await s.take("computer:kit", "web:1", true), { surface: "web:1", since: 99, private: true });
  assert.deepEqual(await s.release("computer:kit", "web:1", "  all done "), { heldMs: 125000, noted: true });
  await s.release("computer:kit", "web:1", " ");
  await s.close("s1");
  assert.deepEqual(b.seen.map((x) => [x.tool, x.input]), [["glass.take", { target: "computer:kit", surface: "web:1" }], ["glass.take", { target: "computer:kit", surface: "web:1", private: true }],
    ["glass.release", { target: "computer:kit", surface: "web:1", note: "all done" }], ["glass.release", { target: "computer:kit", surface: "web:1" }], ["glass.close", { session: "s1" }]]);
});

test("a refused take keeps its code and says it in words", { skip: !strip }, async () => {
  const { glassSource } = await import("./source.ts");
  const { errText } = await import("./model.ts");
  await assert.rejects(glassSource(box({ error: { "glass.take": { code: "held", message: "x" } } }).call).take("computer:kit", "w", false), (e) => {
    assert.equal(/** @type {any} */ (e).code, "held");
    assert.equal(errText(/** @type {any} */ (e)), "Someone else has the keyboard right now.");
    return true;
  });
  assert.equal(errText({ code: "no_such_tool" }), "The glass module is not running on this machine.");
  assert.equal(errText({ code: "weird", message: "Boom" }), "Boom");
  assert.equal(errText(null), "");
});

test("stream rules: relay and slow links get fewer frames, the backoff doubles to 30 s, each close code means its own thing", { skip: !strip }, async () => {
  const { relayed, latencyLabel, levels, nextBackoff, closeMeaning } = await import("./model.ts");
  assert.equal(relayed({ path: "peer-relay", latencyMs: null }), true);
  assert.equal(relayed({ path: "direct", latencyMs: 3 }), false);
  assert.equal(relayed(null), false);
  assert.equal(latencyLabel({ path: "relay", latencyMs: 41.6 }), "42 ms");
  assert.equal(latencyLabel({ path: "relay", latencyMs: null }), "");
  assert.deepEqual(levels(null), [6, 2]);
  assert.deepEqual(levels({ path: "relay", latencyMs: 1 }), [2, 6]);
  assert.deepEqual(levels(null, true), [2, 6]);
  assert.deepEqual([1, 2, 4, 8, 16, 32].map(nextBackoff), [2, 4, 8, 16, 30, 30]);
  assert.deepEqual(closeMeaning(4003, "", false), { conn: "refused", why: "" });
  assert.deepEqual(closeMeaning(4001, "no kernel", false), { conn: "failed", why: "no kernel" });
  assert.deepEqual(closeMeaning(1000, "", true), { conn: "ended", why: "Your server closed the stream." });
  assert.deepEqual(closeMeaning(4001, "", false), { retry: "The computer is not running yet." });
  assert.deepEqual(closeMeaning(4008, "", false), { retry: "The stream hit a protocol error." });
  assert.deepEqual(closeMeaning(1006, "", false), { retry: "The connection dropped." });
});

test("overlay words and the badge", { skip: !strip }, async () => {
  const { overText, badgeWord } = await import("./model.ts");
  assert.deepEqual(overText("connecting", "kit", ""), ["Connecting to kit's screen", "Asking your server for a one-time ticket."]);
  assert.equal(overText("hidden", "kit", "")[0], "Paused while this tab was hidden");
  assert.match(overText("failed", "kit", "no disk")[1], /^no disk\. Restart the computer/);
  assert.deepEqual(overText("live", "kit", ""), ["", ""]);
  assert.deepEqual(["live", "hidden", "ended", "waiting", "noscreen"].map((c) => badgeWord(/** @type {any} */ (c))), ["Live", "Paused", "Offline", "Connecting", "Connecting"]);
});

test("take-over: who has it, why it is blocked, what the side panel says", { skip: !strip }, async () => {
  const { mine, other, whyBlocked, holdingRows, holdingTitle } = await import("./model.ts");
  const h = { surface: "web:1", since: 1, private: false };
  assert.equal(mine(h, "web:1"), true);
  assert.equal(other(h, "web:2"), true);
  assert.equal(mine(null, "web:1"), false);
  assert.equal(whyBlocked(h, "web:2", true), "Your laptop has control.");
  assert.equal(whyBlocked({ ...h, surface: "phone:9" }, "web:2", true), "Your phone has control.");
  assert.equal(whyBlocked(null, "web:2", false), "The screen is not connected.");
  assert.equal(whyBlocked(null, "web:2", true), "");
  assert.equal(holdingRows("kit", false).length, 4);
  assert.equal(holdingRows("kit", true).length, 5);
  assert.deepEqual(holdingRows("kit", true)[2], ["kit's thread", "never", false]);
  assert.equal(holdingTitle("kit", true), "What you type goes to the page. Nowhere else.");
  assert.equal(holdingTitle("kit", false), "kit is paused while you drive.");
});

test("event lines: who did what; a take-over seen twice is one line", { skip: !strip }, async () => {
  const { eventLine, handedBackLine, isRepeat, agentOf, stateLine, watchersLine } = await import("./model.ts");
  assert.equal(eventLine("glass.taken", { surface: "web:1" }, "kit", "web:1"), "You took the keyboard.");
  assert.equal(eventLine("computer.taken-over", { surface: "phone:1", private: true }, "kit", "web:1"), "Your phone took the keyboard to sign in privately.");
  assert.equal(eventLine("computer.shielded", { reason: "fill" }, "kit", "web:1"), "The Vault is signing kit in; kit cannot see the page until it is done.");
  assert.equal(eventLine("computer.unshielded", { origin: "https://x.com" }, "kit", "web:1"), "kit can see the page again (https://x.com).");
  assert.equal(eventLine("glass.opened", { surface: "phone:1" }, "kit", "web:1"), "Someone started watching from a phone.");
  assert.equal(eventLine("glass.opened", { surface: "web:1" }, "kit", "web:1"), "");
  assert.equal(eventLine("glass.closed", {}, "kit", "web:1"), "");
  assert.equal(handedBackLine({ reason: "idle", idle_ms: 300000 }, "kit", "web:1"), "Handed back to kit after 5 min idle.");
  assert.equal(handedBackLine({ reason: "expired", device: "Mac" }, "kit", "web:1"), "Your take-over lapsed after 90 s without a signal (from Mac).");
  assert.equal(handedBackLine({ surface: "web:1" }, "kit", "web:1"), "You handed back to kit.");
  assert.equal(handedBackLine({ surface: "phone:2" }, "kit", "web:1"), "The keyboard went back to kit.");
  assert.equal(isRepeat({ text: "a", at: 1000 }, "a", 3000), true);
  assert.equal(isRepeat({ text: "a", at: 1000 }, "a", 4500), false);
  assert.equal(isRepeat({ text: "a", at: 1000 }, "b", 1500), false);
  assert.equal(agentOf({ agent: "kit" }), "kit");
  assert.equal(agentOf({ target: "computer:juno" }), "juno");
  assert.equal(agentOf({ target: "box" }), null);
  assert.match(stateLine("kit", "working"), /^kit is working/);
  assert.match(stateLine("kit", "frozen"), /computer is frozen/);
  assert.equal(watchersLine(1), "Only you are watching");
  assert.equal(watchersLine(3), "You and 2 others are watching");
  assert.equal(watchersLine(2), "You and 1 other are watching");
});

test("files: list sorted folders first, preview shapes, download and upload tickets, mkdir, move, trash", { skip: !strip }, async () => {
  const { glassSource } = await import("./source.ts");
  const b = box();
  const s = glassSource(b.call);
  const l = await s.list("computer:kit", "docs");
  assert.deepEqual(l.entries.map((e) => e.name), ["a", "z", "b.txt"]);
  assert.equal(l.path, "docs");
  const p = await s.preview("computer:kit", "docs/b.txt");
  assert.deepEqual(p.preview, { kind: "text", text: "hello", truncated: true });
  assert.deepEqual(await s.download("computer:kit", "docs/b.txt"), { path: "/v1/glass/raw?t=1", name: "b.txt" });
  assert.equal(await s.uploadTicket("computer:kit", "docs", "c.txt", 5, true), "/v1/glass/put?t=2");
  await s.mkdir("computer:kit", "docs/new"); await s.move("computer:kit", "docs/a", "docs/b"); await s.trash("computer:kit", "docs/z");
  await s.list("box", "");
  assert.deepEqual(b.seen.map((x) => [x.tool, x.input]), [["glass.files.list", { target: "computer:kit", path: "docs" }], ["glass.files.preview", { target: "computer:kit", path: "docs/b.txt" }],
    ["glass.files.download", { target: "computer:kit", path: "docs/b.txt" }], ["glass.files.upload", { target: "computer:kit", dir: "docs", name: "c.txt", size: 5, overwrite: true }],
    ["glass.files.mkdir", { target: "computer:kit", path: "docs/new" }], ["glass.files.move", { target: "computer:kit", from: "docs/a", to: "docs/b" }], ["glass.files.trash", { target: "computer:kit", path: "docs/z" }], ["glass.files.list", { target: "box" }]]);
});

test("preview kinds: an image only from a path on the box; anything else is no preview", { skip: !strip }, async () => {
  const { pickPreview, rawUrl } = await import("./model.ts");
  assert.deepEqual(pickPreview({ kind: "image", path: "/v1/glass/raw?t=1" }), { kind: "image", path: "/v1/glass/raw?t=1" });
  assert.deepEqual(pickPreview({ kind: "image", path: "https://evil.example/x.png" }), { kind: "none" });
  assert.deepEqual(pickPreview({ kind: "pdf" }), { kind: "pdf" });
  assert.deepEqual(pickPreview({ kind: "binary" }), { kind: "none" });
  assert.deepEqual(pickPreview(null), { kind: "none" });
  assert.equal(rawUrl("https://box.example", "/v1/glass/raw?t=1"), "https://box.example/v1/glass/raw?t=1");
  assert.equal(rawUrl("https://box.example", "//evil.example/x"), null);
  assert.equal(rawUrl("https://box.example", "https://evil.example/x"), null);
});

test("paths, folders to make before an upload, words", { skip: !strip }, async () => {
  const { join, parent, leaf, crumbs, foldersFor, uploadedLine, rootLabel, size, stamp, clock } = await import("./model.ts");
  assert.equal(join("a", "", "b//c"), "a/b/c");
  assert.equal(parent("a/b/c"), "a/b");
  assert.equal(parent("a"), "");
  assert.equal(leaf("a/b/c.txt"), "c.txt");
  assert.deepEqual(crumbs("a/b"), [{ label: "a", to: "a" }, { label: "b", to: "a/b" }]);
  assert.deepEqual(crumbs(""), []);
  assert.deepEqual(foldersFor("docs", ["x.txt", "p/q/y.txt", "p/z.txt"]), ["docs/p", "docs/p/q"]);
  assert.deepEqual(foldersFor("", ["p/y.txt"]), ["p"]);
  assert.equal(uploadedLine(["a.txt"], 2048, "docs", "kit's home"), "Uploaded a.txt (2.0 KB) to docs.");
  assert.equal(uploadedLine(["a", "b"], 10, "", "kit's home"), "Uploaded 2 files (10 B) to kit's home.");
  assert.equal(rootLabel("box", "box"), "Your server");
  assert.equal(rootLabel("computer:kit", "kit"), "kit's home");
  assert.deepEqual([size(10), size(2048), size(5 * 1024 * 1024), size(null)], ["10 B", "2.0 KB", "5.0 MB", ""]);
  const now = new Date("2026-10-05T12:00:00");
  assert.equal(stamp(new Date("2025-09-24T10:00:00").getTime(), now).includes("2025"), true);
  assert.equal(stamp(new Date("2026-09-24T10:00:00").getTime(), now).includes("2026"), false);
  assert.equal(stamp(0), "");
  assert.deepEqual([clock(134_000), clock(3_734_000)], ["2:14", "1:02:14"]);
});

test("the hand-back banner claims the note is in the thread only when the box says it was told", { skip: !strip }, async () => {
  const { glassSource } = await import("./source.ts");
  const { handedBackBanner } = await import("./model.ts");
  assert.deepEqual(await glassSource(box({ release: { held_ms: 1000 } }).call).release("computer:kit", "web:1", "hi"), { heldMs: 1000, noted: false }, "a box that does not say is read as not told");
  assert.deepEqual(await glassSource(box({ release: { held_ms: 1000, noted: false } }).call).release("computer:kit", "web:1", "hi"), { heldMs: 1000, noted: false });
  assert.equal(handedBackBanner("kit", 125000, "all done", true), "You handed the keyboard back to kit after 2:05. Your note is in its thread.");
  assert.equal(handedBackBanner("kit", 125000, "all done", false), "You handed the keyboard back to kit after 2:05. kit has no thread open, so your note did not go anywhere.");
  assert.equal(handedBackBanner("kit", null, "  ", false), "You handed the keyboard back to kit.");
});
