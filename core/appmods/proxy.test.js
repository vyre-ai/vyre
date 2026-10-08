import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { rewriteLink, split, pre, rewriteHtml, rewriteCss, rewriteLocation, shimSource, keepCookies, cookieHeader, SHIM_PATH } from "./proxy.js";

const P = "/m/docuseal";

test("an address under /m/<module>/ splits into the module and the app's own path and query", () => {
  assert.deepEqual(split(new URL("http://x/m/docuseal/templates/1?a=2")), { name: "docuseal", rest: "/templates/1?a=2" });
  assert.deepEqual(split(new URL("http://x/m/docuseal")), { name: "docuseal", rest: "/" });
  assert.equal(split(new URL("http://x/m/D/x")), null);
  assert.equal(split(new URL("http://x/other/docuseal/")), null);
});

test("only a root-absolute path gets the prefix, once", () => {
  assert.equal(pre("/a/b", P), "/m/docuseal/a/b");
  assert.equal(pre("/m/docuseal/a", P), "/m/docuseal/a");
  for (const u of ["a/b", "//cdn.example/x", "https://x/y", "#frag", "mailto:a@b", "\\\\x", "", "data:image/png;base64,AAAA"]) assert.equal(pre(u, P), u, u);
});

test("HTML: links, scripts, forms and images go under the prefix, the app's own origin becomes the prefix, and the shim is the first script", () => {
  const html = `<html><head><meta property="og:url" content="http://localhost:3000/"><link rel="stylesheet" href="/packs/app.css"><script src='/packs/app.js' defer></script></head><body>
    <a href="/templates/1">t</a> <a href="templates/2">rel</a> <a href="https://example.com/x">out</a> <form action="/sign_in" method="post"></form> <img src="/img/a.png" srcset="/img/a.png 1x, /img/b.png 2x">
    <a href="http://localhost:3000/file/x.pdf">abs</a> <a href="//cdn.example/x">cdn</a></body></html>`;
  const out = rewriteHtml(html, P, { origins: ["http://localhost:3000", "http://127.0.0.1:4000"] });
  assert.match(out, /<head><script src="\/m\/docuseal\/__vyre\/shim\.js"><\/script>/);
  assert.match(out, /href="\/m\/docuseal\/packs\/app\.css"/);
  assert.match(out, /src='\/m\/docuseal\/packs\/app\.js'/);
  assert.match(out, /href="\/m\/docuseal\/templates\/1"/);
  assert.match(out, /href="templates\/2"/);
  assert.match(out, /href="https:\/\/example\.com\/x"/);
  assert.match(out, /action="\/m\/docuseal\/sign_in"/);
  assert.match(out, /srcset="\/m\/docuseal\/img\/a\.png 1x, \/m\/docuseal\/img\/b\.png 2x"/);
  assert.match(out, /href="\/m\/docuseal\/file\/x\.pdf"/);
  assert.match(out, /content="\/m\/docuseal\/"/);
  assert.match(out, /href="\/\/cdn\.example\/x"/);
  assert.ok(!out.includes("localhost:3000"));
});

test("CSS: url() and @import with a root-absolute path get the prefix", () => {
  const css = `@import "/a.css"; body{background:url(/img/x.png)} .b{background:url("/img/y.png")} .c{background:url(img/z.png)} .d{background:url(https://x/y.png)}`;
  const out = rewriteCss(css, P);
  assert.match(out, /@import "\/m\/docuseal\/a\.css"/);
  assert.match(out, /url\(\/m\/docuseal\/img\/x\.png\)/);
  assert.match(out, /url\("\/m\/docuseal\/img\/y\.png"\)/);
  assert.match(out, /url\(img\/z\.png\)/);
  assert.match(out, /url\(https:\/\/x\/y\.png\)/);
});

test("a redirect to the app's own address stays under the prefix; one to another host is left alone", () => {
  const o = ["http://localhost:3000", "http://127.0.0.1:4000"];
  assert.equal(rewriteLocation("/dashboard", P, o), "/m/docuseal/dashboard");
  assert.equal(rewriteLocation("http://localhost:3000/dashboard?a=1", P, o), "/m/docuseal/dashboard?a=1");
  assert.equal(rewriteLocation("http://127.0.0.1:4000", P, o), "/m/docuseal");
  assert.equal(rewriteLocation("https://elsewhere.example/x", P, o), "https://elsewhere.example/x");
  assert.equal(rewriteLocation("http://localhost:30001/x", P, o), "http://localhost:30001/x", "a different port is a different origin");
});

test("the app's cookies are kept in a jar and removed when it expires them", () => {
  const jar = new Map();
  keepCookies(jar, ["_s=abc; path=/; HttpOnly", "other=1; Max-Age=3600"]);
  assert.equal(cookieHeader(jar), "_s=abc; other=1");
  keepCookies(jar, ["other=; Max-Age=0; path=/"]);
  keepCookies(jar, ["_s=zzz; Expires=Wed, 21 Oct 2015 07:28:00 GMT"]);
  assert.equal(cookieHeader(jar), "");
});

test("the shim is a plain script that knows the prefix and patches the ways an app builds addresses", () => {
  const s = shimSource(P);
  assert.ok(s.includes('"/m/docuseal"'));
  for (const w of ["window.fetch", "XMLHttpRequest.prototype.open", "EventSource", "WebSocket", "pushState", "window.open", "setAttribute", "HTMLScriptElement"]) assert.ok(s.includes(w), w);
  assert.doesNotThrow(() => new Function(s));
  assert.equal(SHIM_PATH, "/__vyre/shim.js");
});

test("a Link header's preload hints go under the prefix", () => {
  assert.equal(rewriteLink('</packs/css/a.css>; rel=preload; as=style; nopush, <https://cdn.example/x.js>; rel=preload', P, ["http://localhost:3000"]), '</m/docuseal/packs/css/a.css>; rel=preload; as=style; nopush, <https://cdn.example/x.js>; rel=preload');
});
