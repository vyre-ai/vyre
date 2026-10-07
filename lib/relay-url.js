// @ts-check
// lib/relay-url: the address a box PUBLISHES for its relay (in a pairing ticket's record, a pairing link, a hand-over to a server) must be wss://. A page served over https cannot open a plain ws://
// socket (Chromium blocks it as mixed content), so a record naming one is a dead end for every browser and a plain-text hop for every other device. A development build may name ws:// (the tests and the
// walks run a relay on 127.0.0.1); a release build refuses, saying why. A pure function over the build kind, so core/relay and core/wink share it without importing each other.
import { BUILD_KIND } from "./build-kind.js";

/** The reason a relay address may not be published, or null when it may. @param {string} url @param {{ release?: boolean }} [o] release: override the build kind (tests) */
export function relayUrlProblem(url, o = {}) {
  const u = String(url || "");
  if (!/^wss?:\/\/[^\s/]+/.test(u)) return "a relay address is ws:// or wss://";
  if (/^wss:\/\//.test(u)) return null;
  const release = o.release !== undefined ? o.release : BUILD_KIND !== "development";
  return release ? "this box's relay address is plain ws://, which a browser page on https cannot open and which sends everything in the clear; use a wss:// relay (the default is wss://relay.vyre.run)" : null;
}

/** The address, or a thrown error with code `unavailable` that says why it may not be published. @param {string} url @param {{ release?: boolean }} [o] */
export function publishableRelay(url, o = {}) {
  const why = relayUrlProblem(url, o);
  if (why) throw Object.assign(new Error(why), { code: "unavailable" });
  return String(url);
}
