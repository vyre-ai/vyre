// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkVerdict, streamless } from "./term-link.js";

const failedBeforeOpen = { opened: false, data: false, code: 1006 };
const emptyDrop = { opened: true, data: false, code: 1006 };
const liveDrop = { opened: true, data: true, code: 1006 };

test("term-link: a socket that never opened, or closed 1006 with nothing, carried no stream", () => {
  assert.equal(streamless(failedBeforeOpen), true);
  assert.equal(streamless(emptyDrop), true);
  assert.equal(streamless(liveDrop), false);
  assert.equal(streamless({ opened: true, data: false, code: 1000 }), false);
});

test("term-link: one failure is worth a retry; two in a row mean the path carries no streams", () => {
  assert.equal(linkVerdict([]), "retry");
  assert.equal(linkVerdict([failedBeforeOpen]), "retry");
  assert.equal(linkVerdict([failedBeforeOpen, emptyDrop]), "blocked");
  assert.equal(linkVerdict([failedBeforeOpen, failedBeforeOpen]), "blocked");
});

test("term-link: a stream that was live in between is an ordinary drop", () => {
  assert.equal(linkVerdict([failedBeforeOpen, liveDrop]), "retry");
  assert.equal(linkVerdict([liveDrop, liveDrop]), "retry");
  assert.equal(linkVerdict([failedBeforeOpen, liveDrop, failedBeforeOpen]), "retry");
  assert.equal(linkVerdict([liveDrop, failedBeforeOpen, emptyDrop]), "blocked");
});
