// @ts-check
// precache.mjs's pure pieces: which exported files the service worker caches, and the build id.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildId, precacheList } from "./precache.mjs";

test("precache: index.html and every hashed file, as sorted /app/ paths", () => {
  const files = [
    "index.html",
    "metadata.json",
    "_expo/static/js/web/entry-a30036c18ca6b5659184affcae1b4f11.js",
    "_expo/static/css/app-0123456789abcdef0123456789abcdef.css",
    "assets/node_modules/expo-router/assets/forward.d8b800c443b8972542883e0b9de2bdc6.png",
    "assets/node_modules/@react-navigation/elements/lib/module/assets/close-icon.808e1b1b9b53114ec2838071a7e6daa7@2x.png",
    "favicon.ico",
    "manifest.json",
    "fonts/InstrumentSans.woff2",
    "precache.json",
  ];
  assert.deepEqual(precacheList(files), [
    "/app/_expo/static/css/app-0123456789abcdef0123456789abcdef.css",
    "/app/_expo/static/js/web/entry-a30036c18ca6b5659184affcae1b4f11.js",
    "/app/assets/node_modules/@react-navigation/elements/lib/module/assets/close-icon.808e1b1b9b53114ec2838071a7e6daa7@2x.png",
    "/app/assets/node_modules/expo-router/assets/forward.d8b800c443b8972542883e0b9de2bdc6.png",
    "/app/index.html",
  ]);
});

test("precache: another prefix, Windows separators and a leading ./ are taken as they come", () => {
  assert.deepEqual(precacheList([".\\index.html", "./_expo\\static\\js\\web\\entry-a30036c18ca6b565.js"], "/deck"), [
    "/deck/_expo/static/js/web/entry-a30036c18ca6b565.js",
    "/deck/index.html",
  ]);
  assert.deepEqual(precacheList(["about.html", "entry-abc.js"]), [], "short hex is not a content hash");
});

test("precache: the build id follows the content, not the order", () => {
  const a = [{ path: "/app/index.html", sha256: "1" }, { path: "/app/x.0123456789abcdef.js", sha256: "2" }];
  const id = buildId(a);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(buildId([...a].reverse()), id);
  assert.notEqual(buildId([a[0], { ...a[1], sha256: "3" }]), id);
});
