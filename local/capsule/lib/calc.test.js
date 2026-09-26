// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "./calc.js";

/** @param {string} q */
function must(q) {
  const r = evaluate(q);
  assert.ok(r, `expected an answer for ${JSON.stringify(q)}`);
  return r;
}
/** @param {string} q @param {number} v */
function near(q, v) {
  const r = must(q);
  assert.ok(Math.abs(r.value - v) <= Math.abs(v) * 1e-9 + 1e-12, `${q}: ${r.value} is not ${v}`);
  return r;
}

test("calc: the result shape", () => {
  const r = must("12 * 3.5");
  assert.deepEqual(r, { kind: "calc", id: "calc:12 * 3.5", label: "42", sub: "12 × 3.5", value: 42, copy: "42" });
  assert.equal(must("  12   *  3.5 ").id, "calc:12 * 3.5", "id is stable across spacing");
  assert.equal(must("12×3.5").sub, "12 × 3.5");
});

test("calc: arithmetic operators and precedence", () => {
  near("2 + 3 * 4", 14);
  near("(2 + 3) * 4", 20);
  near("10 - 4 - 3", 3);
  near("100 / 10 / 2", 5);
  near("12 × 3.5", 42);
  near("84 ÷ 2", 42);
  near("2 ^ 10", 1024);
  near("2 ** 10", 1024);
  near("2 ^ 3 ^ 2", 512);
  near("-2 ^ 2", -4);
  near("2 ^ -1", 0.5);
  near("-(2 + 3) * 2", -10);
  near("3 − 1", 2);
  near("10 x 4", 40);
  near(".5 + .25", 0.75);
  near("1.5e3 * 2", 3000);
  near("2 + 2 =", 4);
});

test("calc: mod is the JS remainder", () => {
  near("10 mod 3", 1);
  near("-7 mod 3", -1);
  assert.equal(evaluate("10 mod 0"), null);
});

test("calc: percent is a share of the left side after + and -, else x/100", () => {
  near("200 + 10%", 220);
  near("50 - 20%", 40);
  near("15% of 80", 12);
  near("10% * 50", 5);
  near("200 * 10%", 20);
  assert.equal(evaluate("50%"), null, "a bare percent is a lone number");
  assert.equal(evaluate("80 of 15"), null, "of needs a percent on its left");
});

test("calc: thousands separators in, grouped label out, plain copy", () => {
  const r = must("1,000 * 3");
  assert.equal(r.label, "3,000");
  assert.equal(r.copy, "3000");
  assert.equal(r.sub, "1,000 × 3");
  near("1,234,567 + 1", 1234568);
  assert.equal(evaluate("1,2 + 3"), null, "a comma that is not a thousands separator");
  assert.equal(evaluate("1,0000 + 1"), null);
});

test("calc: constants and functions", () => {
  near("pi * 2", Math.PI * 2);
  assert.equal(must("pi * 2").sub, "π × 2");
  near("π * 1", Math.PI);
  near("e * 1", Math.E);
  near("sqrt(16)", 4);
  near("sqrt 16 + 1", 5);
  near("sin(pi / 2)", 1);
  near("cos(0)", 1);
  near("tan(pi / 4)", 1);
  near("log(1000)", 3);
  near("ln(e)", 1);
  near("abs(-5)", 5);
  near("round(2.5)", 3);
  near("floor(2.7)", 2);
  near("ceil(2.1)", 3);
  near("sqrt(2)^2", 2);
  assert.equal(must("sin(pi)").label, "0", "trig noise snaps to zero");
  assert.equal(must("sqrt(16)").sub, "sqrt(16)");
});

test("calc: division by zero, overflow and NaN are null, never Infinity", () => {
  assert.equal(evaluate("1 / 0"), null);
  assert.equal(evaluate("0 / 0"), null);
  assert.equal(evaluate("1 / (2 - 2)"), null);
  assert.equal(evaluate("2 ^ 1024"), null);
  assert.equal(evaluate("1e308 * 10"), null);
  assert.equal(evaluate("sqrt(-1)"), null);
  assert.equal(evaluate("log(0)"), null);
});

test("calc: formatting", () => {
  assert.equal(must("1 / 3").label, "0.3333333333");
  assert.equal(must("0.1 + 0.2").label, "0.3");
  assert.equal(must("1000000 / 3").label, "333,333.3333");
  assert.equal(must("1000000 / 3").copy, "333333.3333");
  assert.equal(must("1e20 * 1e5").label, "1e25");
  assert.equal(must("1 / 3e9").label, "3.333333333e-10");
  assert.equal(must("-5 * 0").label, "0");
  assert.equal(must("2.50 * 1").label, "2.5");
});

test("calc: not math is null", () => {
  for (const q of [
    "", " ", "hello", "hello world", "what is 2 + 2", "@juno", "@juno 2 + 2",
    "42", "-42", "(42)", "1,000", "3.14", "1e5", "pi", "e", "x",
    "1.2.3", "v1.2", "10.0.0.1",
    "2026-09-26", "9/26/2026", "26.09.2026", "10:30",
    "555-1234", "555-123-4567", "(555) 123-4567", "+1 555 123 4567", "+44 20 7946 0958", "1-800-555-0199",
    "2 + ", "* 3", "(2 + 3", "2 + 3)", "2 3", "sqrt", "0x1f", "2 + two", "eval(1)", "2 + alert(1)",
    "x".repeat(300), "1+".repeat(150) + "1",
  ]) assert.equal(evaluate(q), null, JSON.stringify(q));
  assert.equal(evaluate(/** @type {any} */ (null)), null);
});

test("calc: length, mass, volume conversions", () => {
  const r = near("5 km in miles", 3.106855961);
  assert.equal(r.label, "3.107 mi");
  assert.equal(r.sub, "5 km in miles");
  assert.equal(r.copy, "3.106855961");
  near("5km to mi", 3.106855961);
  near("5 kilometres as miles", 3.106855961);
  near("5 km = mi", 3.106855961);
  near("5km=mi", 3.106855961);
  near("10 feet in meters", 3.048);
  near("1 foot to cm", 30.48);
  near("3 in in cm", 7.62);
  near("1 mile in yards", 1760);
  near("10 kg in lb", 22.04622622);
  near("1 pound in grams", 453.59237);
  near("16 oz in lb", 1);
  near("1 gal in l", 3.785411784);
  near("1 cup in ml", 236.5882365);
  near("1 tbsp to tsp", 3);
  near("1 fl oz in ml", 29.57352956);
  near("2 cups to fluid ounces", 16);
  assert.equal(must("2 cups in ml").sub, "2 cups in milliliters");
});

test("calc: temperature conversions use offsets", () => {
  const r = near("72f to c", 22.22222222);
  assert.equal(r.label, "22.22 °C");
  assert.equal(r.sub, "72 °F in Celsius");
  near("72 °F in C", 22.22222222);
  near("72°F in °C", 22.22222222);
  near("100 celsius in fahrenheit", 212);
  near("0 c to k", 273.15);
  near("-40 f to c", -40);
  near("300 kelvin in c", 26.85);
  assert.equal(evaluate("-500 c to k"), null, "below absolute zero");
});

test("calc: time, data, speed, area conversions", () => {
  assert.equal(must("3 hours in minutes").label, "180 min");
  near("1 day in hours", 24);
  near("90 min to h", 1.5);
  near("1 week in days", 7);
  const gb = must("2 GB in MB");
  assert.equal(gb.label, "2,000 MB");
  assert.equal(gb.copy, "2000");
  near("2 GiB in MiB", 2048);
  near("1 GiB in MB", 1073.741824);
  near("8 bits in bytes", 1);
  near("1 tb to gb", 1000);
  near("100 mph in km/h", 160.9344);
  near("100 km/h to mph", 62.13711922);
  near("10 knots in km/h", 18.52);
  near("100 sq ft in m2", 9.290304);
  near("100 square feet in square meters", 9.290304);
  near("1 acre to hectares", 0.4046856422);
  near("1 ha in m²", 10000);
  near("1 sq mi in acres", 640);
});

test("calc: conversions that do not line up are null", () => {
  assert.equal(evaluate("5 km"), null, "no target: null, it may be a file name");
  assert.equal(evaluate("5 km in kg"), null, "different dimensions");
  assert.equal(evaluate("5 km in parsecs"), null, "unknown unit");
  assert.equal(evaluate("km in miles"), null, "no quantity");
  assert.equal(evaluate("5 usd in eur"), null, "no currency");
  assert.equal(evaluate("put this in the box"), null);
  assert.equal(evaluate("5 things to do"), null);
});

test("calc: runs well under a millisecond", () => {
  const qs = ["12 * 3.5", "5 km in miles", "hello world", "sqrt(2) + sin(pi / 4) * 3 ^ 2", "72 °F in C", "555-123-4567"];
  const n = 2000;
  const t = process.hrtime.bigint();
  for (let i = 0; i < n; i++) for (const q of qs) evaluate(q);
  const perCall = Number(process.hrtime.bigint() - t) / 1e6 / (n * qs.length);
  assert.ok(perCall < 0.2, `${perCall} ms per call`);
});
