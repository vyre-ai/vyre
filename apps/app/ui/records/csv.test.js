// CSV in, record values out: parse a CSV, turn a row into the values of a type's fields, and say what would not fit.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, importableFields, coerceRow, runImport } from "./csv.js";
import { importIssues } from "./logic.js";

test("a CSV with quotes, commas, doubled quotes, line breaks inside quotes and CRLF", () => {
  const t = 'Name,Notes,Value\r\n"Doe, Jane","said ""hi""\nthen left",1200\r\nRoe,,\r\n';
  const r = parseCsv(t);
  assert.deepEqual(r.headers, ["Name", "Notes", "Value"]);
  assert.deepEqual(r.rows, [{ Name: "Doe, Jane", Notes: 'said "hi"\nthen left', Value: "1200" }, { Name: "Roe", Notes: "", Value: "" }]);
});

test("a byte order mark, blank lines and a header only are read plainly", () => {
  assert.deepEqual(parseCsv("﻿A,B\n\n1,2\n").rows, [{ A: "1", B: "2" }]);
  assert.deepEqual(parseCsv("A,B").rows, []);
  assert.deepEqual(parseCsv("").headers, []);
});

test("the fields an import can fill: plain kinds, not stage, link, file, sealed, computed or hidden", () => {
  const f = [{ name: "a", kind: "text" }, { name: "s", kind: "stage" }, { name: "l", kind: "link" }, { name: "x", kind: "sealed" }, { name: "c", kind: "number", computed: { expr: "1" } }, { name: "h", kind: "text", hidden: true }, { name: "d", kind: "date" }, { name: "k", kind: "choice", options: ["A"] }];
  assert.deepEqual(importableFields(f).map((x) => x.name), ["a", "d", "k"]);
});

test("a row becomes the type's values: numbers, money, yes or no, dates, and nothing for what is empty", () => {
  const fields = [{ name: "name", kind: "text" }, { name: "n", kind: "number" }, { name: "fee", kind: "money" }, { name: "ok", kind: "boolean" }, { name: "on", kind: "date" }, { name: "k", kind: "choice", options: ["Home", "Account"] }, { name: "e", kind: "text" }];
  const map = { Name: "name", N: "n", Fee: "fee", OK: "ok", On: "on", K: "k", E: "e", Skip: "" };
  const r = coerceRow(fields, map, { Name: " Doe ", N: "1,200", Fee: "$3,500.50", OK: "yes", On: "10/28/2026", K: "home", E: "", Skip: "x" });
  assert.deepEqual(r.data, { name: "Doe", n: 1200, fee: { amount: 3500.5, currency: "USD" }, ok: true, on: "2026-10-28", k: "Home" });
  assert.deepEqual(r.problems, []);
});

test("what does not fit is named, and the value is left out", () => {
  const fields = [{ name: "n", kind: "number" }, { name: "on", kind: "date" }, { name: "k", kind: "choice", options: ["Home"] }];
  const r = coerceRow(fields, { N: "n", On: "on", K: "k" }, { N: "lots", On: "soon", K: "Boat" });
  assert.deepEqual(r.data, {});
  assert.deepEqual(r.problems.map((p) => [p.field, p.problem]), [["n", "not a number"], ["on", "not a date"], ["k", "not one of the options"]]);
});

test("the preview check also refuses a choice that is not one of the options", () => {
  const issues = importIssues([{ K: "Boat" }], { K: "k" }, [{ name: "k", label: "Kind", kind: "choice", options: ["Home"] }]);
  assert.deepEqual(issues.map((i) => i.problem), ["not one of the options"]);
});

test("the import adds row by row, reports progress, counts a refused row without stopping, and skips rows the preview flagged", async () => {
  const rows = [{ N: "A" }, { N: "B" }, { N: "C" }, { N: "D" }];
  const seen = [];
  const create = async (type, data) => { if (data.n === "B") throw Object.assign(new Error("already there"), { code: "unique_violation" }); seen.push(data.n); };
  const prog = [];
  const out = await runImport({ rows, mapping: { N: "n" }, fields: [{ name: "n", kind: "text" }], skip: new Set([4]), type: "t", create, onProgress: (d, t) => prog.push([d, t]) });
  assert.deepEqual(seen, ["A", "C"]);
  assert.deepEqual([out.created, out.refused, out.skipped], [2, 1, 1]);
  assert.deepEqual(out.failures, [{ row: 2, why: "already there" }]);
  assert.deepEqual(prog.at(-1), [3, 3]);
});

test("a repeat of a unique value is skipped, not refused, when the person chose to skip repeats", async () => {
  const create = async () => { throw Object.assign(new Error("already there"), { code: "unique_violation" }); };
  const base = { rows: [{ N: "A" }], mapping: { N: "n" }, fields: [{ name: "n", kind: "text" }], skip: new Set(), type: "t", create };
  assert.deepEqual(await runImport({ ...base, skipRepeats: true }), { created: 0, refused: 0, skipped: 1, failures: [] });
  assert.equal((await runImport(base)).refused, 1);
});

test("a sheet from read-excel-file becomes the rows a CSV would: dates are ISO days, numbers plain, blank headers and rows handled", async () => {
  const { parseGrid } = await import("./csv.js");
  const grid = [["Name", "Joined", "Value", ""], ["Jane Doe", new Date(Date.UTC(2026, 2, 5)), 1200.5, "x"], [null, null, null, null], ["Roe", "2026-01-02", true, ""]];
  const r = parseGrid(grid);
  assert.deepEqual(r.headers, ["Name", "Joined", "Value", "Column 4"]);
  assert.deepEqual(r.rows, [{ Name: "Jane Doe", Joined: "2026-03-05", Value: "1200.5", "Column 4": "x" }, { Name: "Roe", Joined: "2026-01-02", Value: "true", "Column 4": "" }]);
  assert.deepEqual(parseGrid([]).headers, []);
});

test("a CSV writer quotes commas, quotes and line breaks and reads back through parseCsv", async () => {
  const { toCsv } = await import("./csv.js");
  const out = toCsv([["Name", "Notes"], ["Doe, Jane", 'said "hi"\nthen left'], ["Roe", ""]]);
  assert.equal(out, 'Name,Notes\r\n"Doe, Jane","said ""hi""\nthen left"\r\nRoe,');
  assert.deepEqual(parseCsv(out).rows, [{ Name: "Doe, Jane", Notes: 'said "hi"\nthen left' }, { Name: "Roe", Notes: "" }]);
});

test("exporting a list writes the shown columns by label and the shown rows, with a sealed value as its placeholder and never the secret", async () => {
  const { tableToCsv } = await import("./csv.js");
  const content = {
    columns: [
      { id: "_title", title: "Contact", role: "title" }, { id: "since", title: "Client since", role: "col" }, { id: "worth", title: "Worth", role: "end" },
      { id: "ssn", title: "SSN", role: "col" }, { id: "owner", title: "Owner", role: "line" }, { id: "hidden", title: "Carried", role: "sortOnly" }, { id: "when", title: "Phone date", role: "endDate" },
    ],
    rows: [
      { cells: { _title: { k: "title", v: "Doe, Jane" }, since: { k: "date", v: "2026-03-05" }, worth: { k: "money", v: { amount: 1250, currency: "USD" } }, ssn: { k: "sealed", on: true }, owner: { k: "actor", v: "a1", who: { name: "Sam" } }, hidden: { k: "text", v: "zzz" }, when: { k: "date", v: "2020-01-01" } } },
      { cells: { _title: { k: "title", v: "Roe" }, ssn: { k: "sealed", on: false } } },
    ],
  };
  const out = tableToCsv(content);
  assert.equal(out, 'Contact,Client since,Worth,SSN,Owner\r\n"Doe, Jane",2026-03-05,1250 USD,"SSN on file, sealed",Sam\r\nRoe,,,,');
});
