// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { joinPageHtml, JOIN_CSP, JOIN_FILE } from "./join.js";
import { caddyfile, edgeCompose, isolationProblems } from "./edge.js";
import { SPACE } from "./test-kit.js";

test("the join page: self-contained, sends the token nowhere, hands the link to the app", () => {
  const h = joinPageHtml();
  assert.ok(h.startsWith("<!doctype html>") && h.includes('<meta name="referrer" content="no-referrer">') && h.includes("noindex"));
  assert.ok(!/<script[^>]+src=|<link[^>]+href=|@import|url\(|<img|<iframe|<form|fetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|document\.cookie/.test(h), "no outside request, no storage");
  assert.ok(h.includes('"vyre://join?link=" + encodeURIComponent(link)'), "the app gets the whole link");
  assert.ok(h.includes("location.hostname"), "the space is the host, never something the link claims");
  for (const w of ["—", "§"]) assert.ok(!h.includes(w), "no em dash or section sign in copy");
});

test("the Caddyfile serves the join page on the space's own name, 404 for the rest of that host, and the compose carries the page as a read-only config", () => {
  const cf = caddyfile([], [], { spaceName: "harlow.vyre.run" });
  const block = cf.slice(cf.indexOf("harlow.vyre.run {"));
  assert.ok(block);
  assert.ok(block.includes("@join path_regexp ^/join/[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$") && block.includes("root * /srv/join") && block.includes("rewrite * /index.html") && block.includes("respond 404"));
  assert.ok(block.includes(`Content-Security-Policy "${JOIN_CSP}"`) && block.includes('header Referrer-Policy "no-referrer"') && block.includes('header Cache-Control "no-store"'));
  assert.ok(!/reverse_proxy/.test(block), "nothing is proxied from the join host");
  const c = edgeCompose(SPACE, []);
  assert.deepEqual(c.services.caddy.configs, [{ source: "caddyfile", target: "/etc/caddy/Caddyfile" }, { source: "joinpage", target: JOIN_FILE }]);
  assert.deepEqual(c.configs, { caddyfile: { file: "./Caddyfile" }, joinpage: { file: "./join.html" } });
  assert.deepEqual(isolationProblems(c), []);
  c.configs.evil = { file: "/etc/passwd" };
  assert.ok(isolationProblems(c).some(p => /config evil/.test(p)));
});
