// @ts-check
// A page as the answer of a learned operation: the forgiving reader, the selectors, reading rows by a recipe, and finding the recipe from one example row. Pages are server markup as courts and
// registries really send it: unclosed cells, a header row, odd/even classes, script and comments in the way.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHtml, textOf, select, selectOne, parseSelector } from "./htmlparse.js";
import { readHtml, suggestRecipe, emptyResults } from "./htmlread.js";

const docket = (/** @type {[string, string, string, string][]} */ rows, extra = "") => `<!DOCTYPE html>
<html><head><title>Case search</title><script>var rows = "<tr><td>not a row</td></tr>";</script><style>.x{}</style></head>
<body><div id="nav"><ul><li><a href="/">Home</a><li><a href="/search">Search</a></ul></div>
<!-- the results -->
<table class="grid results" id="ctl00_Grid">
<tr class="head"><th>Case</th><th>Caption</th><th>Filed</th><th>Status</th></tr>
${rows.map(([no, cap, filed, status], i) => `<tr class="${i % 2 ? "odd" : "even"} row"><td class="no">${no}<td class="cap"><a href="/case/${no}">${cap}</a><td>${filed}<td><span class="st">${status}</span>`).join("\n")}
</table>${extra}
<p>Page 1 of 1 &amp; footer &copy; 2026<br>Powered by Docket&nbsp;Co</body></html>`;

const PAGE1 = docket([["24-CV-1001", "Harlow v. Northwind &amp; Sons", "2024-02-01", "Open"], ["24-CV-1002", "Estate of Reyes", "2024-02-09", "Closed"], ["24-CV-1003", "Doe v. Roe", "2024-03-14", "Open"], ["24-CV-1004", "Matter of Lee", "2024-04-02", "Stayed"]]);
const PAGE2 = docket([["25-CV-2001", "Kim v. Atlas", "2025-01-05", "Open"], ["25-CV-2002", "Patel v. Ng", "2025-01-19", "Closed"]]);

test("the reader builds a tree from forgiving markup: unclosed cells and items end where the next begins, script and comments are skipped, entities are decoded", () => {
  const root = parseHtml(PAGE1);
  const rows = select(root, "table.results tr");
  assert.equal(rows.length, 5, "the header row and four rows, though no cell was closed");
  assert.equal(select(rows[1], "td").length, 4);
  assert.equal(textOf(rows[1]), "24-CV-1001 Harlow v. Northwind & Sons 2024-02-01 Open");
  assert.equal(select(root, "td").length, 16, "the table in a script string is not a table");
  assert.equal(select(root, "#nav li").length, 2, "the list items close each other");
  assert.match(textOf(root), /Docket Co$/, "&nbsp; is a space");
  assert.equal(textOf(selectOne(root, "title")), "Case search");
  assert.deepEqual(parseHtml("not a page").children.length, 1);
  assert.deepEqual(parseHtml("").children, []);
});

test("selectors: tag, class, id, attributes, first-child, nth-child, nth-of-type, descendant, child and lists; an unsupported one says so", () => {
  const root = parseHtml(PAGE1);
  const n = (/** @type {string} */ s) => select(root, s).length;
  assert.equal(n("tr.row"), 4);
  assert.equal(n("tr.odd"), 2);
  assert.equal(n("#ctl00_Grid tr"), 5);
  assert.equal(n("table > tr"), 5);
  assert.equal(n("table tr td.cap a"), 4);
  assert.equal(n('a[href^="/case/"]'), 4);
  assert.equal(n('a[href$="1003"]'), 1);
  assert.equal(n('a[href*="CV-100"]'), 4);
  assert.equal(n("a[href]"), 6);
  assert.equal(n("tr.row:first-child"), 0);
  assert.equal(n("tr:first-child"), 1);
  assert.equal(n("tr.row td:nth-of-type(3)"), 4);
  assert.equal(n("tr.row td:nth-child(2) a"), 4);
  assert.equal(n("th, td.no"), 8);
  assert.equal(n("ul > li > a"), 2);
  assert.throws(() => parseSelector("a:hover"), /not supported/);
  assert.throws(() => parseSelector("  "), /empty/);
});

test("a recipe reads the rows of a page: fields by selector, a link by its href, a header row and a row with nothing dropped, a missing cell left out", () => {
  const recipe = { items: "table.results tr", fields: { number: "td.no", caption: "td.cap a", url: { sel: "td.cap a", attr: "href" }, status: "span.st" } };
  const rows = readHtml(PAGE1, recipe);
  assert.deepEqual(rows[0], { number: "24-CV-1001", caption: "Harlow v. Northwind & Sons", url: "/case/24-CV-1001", status: "Open" });
  assert.equal(rows.length, 4, "the header row has none of the fields");
  assert.equal(readHtml(PAGE1, { ...recipe, limit: 2 }).length, 2);
  assert.deepEqual(readHtml(PAGE1, { items: "tr.row", fields: { nope: "td.zzz" } }), []);
  assert.deepEqual(readHtml(PAGE1, { items: "tr.row", fields: { whole: "" } })[1], { whole: "24-CV-1002 Estate of Reyes 2024-02-09 Closed" });
});

test("a recipe is found from the first row's text, names each field by where it sits, and reads another page of the same site", () => {
  const found = suggestRecipe(PAGE1, { number: "24-CV-1001", caption: "Harlow v. Northwind & Sons", status: "Open" });
  assert.ok(found.recipe, JSON.stringify(found));
  assert.equal(found.count, 4);
  assert.deepEqual(found.missing, []);
  assert.equal(found.rows[1].number, "24-CV-1002");
  // the stable class and the table's id anchor the items, not odd/even
  assert.ok(!/odd|even/.test(found.recipe.items), found.recipe.items);
  const other = readHtml(PAGE2, found.recipe);
  assert.deepEqual(other.map(r => r.number), ["25-CV-2001", "25-CV-2002"]);
  assert.deepEqual(other.map(r => r.status), ["Open", "Closed"]);
  // a link
  const link = suggestRecipe(PAGE1, { number: "24-CV-1002", url: "/case/24-CV-1002" });
  assert.ok(link.recipe && link.recipe.fields.url.attr === "href", JSON.stringify(link));
  assert.deepEqual(readHtml(PAGE2, link.recipe).map(r => r.url), ["/case/25-CV-2001", "/case/25-CV-2002"]);
});

test("one example is enough to find the list, and a row of three cells is not mistaken for the cells", () => {
  const small = docket([["1", "A v. B", "d", "Open"], ["2", "C v. D", "d", "Open"]]);
  const one = suggestRecipe(small, { caption: "A v. B" });
  assert.ok(one.recipe, JSON.stringify(one));
  assert.equal(one.count, 2, "two rows, though a row has four cells");
  assert.deepEqual(readHtml(small, one.recipe).map(r => r.caption), ["A v. B", "C v. D"]);
});

test("a list of cards is found too, and a field the page does not hold is named, not guessed", () => {
  const cards = `<main><section class="hits"><article class="hit"><h3 class="name">Ada Lovelace</h3><p class="role">Counsel</p></article><article class="hit"><h3 class="name">Grace Hopper</h3><p class="role">Partner</p></article><article class="hit"><h3 class="name">Alan Turing</h3><p class="role">Associate</p></article></section></main>`;
  const r = suggestRecipe(cards, { name: "Ada Lovelace", role: "Counsel", bar: "Bar No. 4411" });
  assert.ok(r.recipe, JSON.stringify(r));
  assert.deepEqual(r.missing, ["bar"]);
  assert.deepEqual(readHtml(cards, r.recipe).map(x => `${x.name}/${x.role}`), ["Ada Lovelace/Counsel", "Grace Hopper/Partner", "Alan Turing/Associate"]);
  const none = suggestRecipe(cards, { name: "Not Here" });
  assert.equal(none.recipe, null);
  assert.match(String(none.reason), /none of the example text/);
});

test("the page that says nothing was found is told apart from a page whose markup changed", () => {
  const empty = docket([], '<p class="msg">Your search returned no results.</p>');
  assert.equal(emptyResults(empty, "tr.row"), true);
  assert.equal(emptyResults(PAGE1, "tr.row"), false, "items are there");
  assert.equal(emptyResults(PAGE1, "tr.gone"), false, "items missing and no such words: the site changed");
  assert.equal(emptyResults("", "tr.row"), false);
});

test("an operation whose answer is a page: learned with the text of the first row, run on another page, empty when the site says so, drift when the markup changed", async () => {
  const { learnOperation } = await import("./learn.js");
  const { runOperation } = await import("./run.js");
  const ex = { id: 1, resourceType: "document", request: { method: "GET", url: "https://courts.example.gov/search?name=Harlow", headers: { accept: "text/html" } },
    response: { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, contentType: "text/html; charset=utf-8", body: PAGE1 } };
  const learned = learnOperation({ name: "searchCases", exchanges: [ex], examples: [{ name: "Harlow" }], cookies: [], trigger: { url: "https://courts.example.gov/search?name={name}" },
    page: { number: "24-CV-1001", caption: "Harlow v. Northwind & Sons", status: "Open" } });
  const op = learned.operation;
  assert.equal(op.response.format, "html");
  assert.ok(op.response.html && op.response.html.items && op.response.html.fields.caption, JSON.stringify(op.response));
  assert.deepEqual(learned.warnings.filter(w => /page|recipe/.test(w)), []);
  const send = (/** @type {string} */ body, status = 200) => async () => ({ status, headers: { "content-type": "text/html" }, body });
  const ok = await runOperation(op, { name: "Kim" }, { send: send(PAGE2) });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(/** @type {any[]} */ (ok.data).map(r => r.number), ["25-CV-2001", "25-CV-2002"]);
  const none = await runOperation(op, { name: "Zed" }, { send: send(docket([], "<p>Your search returned no results.</p>")) });
  assert.equal(none.ok, true, JSON.stringify(none));
  assert.deepEqual(none.data, []);
  const moved = await runOperation(op, { name: "Kim" }, { send: send(`<html><body><div class="cards"><div class="card">Kim v. Atlas</div></div></body></html>`) });
  assert.equal(moved.ok, false);
  assert.equal(moved.class, "drift", JSON.stringify(moved));
  assert.match(String(moved.reason), /matched nothing/);
  // a page given without fields still learns, and says what it needs
  const bare = learnOperation({ name: "searchCases", exchanges: [ex], examples: [{ name: "Harlow" }], cookies: [], trigger: { url: "https://courts.example.gov/search?name={name}" } });
  assert.ok(bare.warnings.some(w => /page.*fields/.test(w)), bare.warnings.join(" | "));
  // a recipe the operation is kept with must be a recipe
  const { parseOperation } = await import("./spec.js");
  const broken = parseOperation({ ...op, response: { ...op.response, html: { items: "tr:hover", fields: { a: "td" } } } });
  assert.equal(broken.ok, false);
});
