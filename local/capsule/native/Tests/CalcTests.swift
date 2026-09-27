// Calc tests: calc.test.js ported case for case, plus the ResultItem builder and a timing loop.

import Foundation

// capsule-suite: calcSuite
let calcSuite = Suite("calc") { t in
    func must(_ q: String, file: StaticString = #fileID, line: UInt = #line) -> CalcAnswer {
        guard let r = Calc.evaluate(q) else {
            t.ok(false, "expected an answer for \(q)", file: file, line: line)
            return CalcAnswer(id: "", label: "", sub: "", value: .nan, copy: "")
        }
        return r
    }
    @discardableResult
    func near(_ q: String, _ v: Double, file: StaticString = #fileID, line: UInt = #line) -> CalcAnswer {
        let r = must(q, file: file, line: line)
        t.ok(abs(r.value - v) <= abs(v) * 1e-9 + 1e-12, "\(q): \(r.value) is not \(v)", file: file, line: line)
        return r
    }
    func none(_ q: String, _ note: String = "", file: StaticString = #fileID, line: UInt = #line) {
        let r = Calc.evaluate(q)
        t.ok(r == nil, "\(q.prefix(40)) should be nil, got \(String(describing: r?.label)) \(note)", file: file, line: line)
    }

    t.test("the result shape") {
        t.eq(must("12 * 3.5"), CalcAnswer(id: "calc:12 * 3.5", label: "42", sub: "12 × 3.5", value: 42, copy: "42"))
        t.eq(must("  12   *  3.5 ").id, "calc:12 * 3.5", "id is stable across spacing")
        t.eq(must("12×3.5").sub, "12 × 3.5")
    }

    t.test("arithmetic operators and precedence") {
        near("2 + 3 * 4", 14)
        near("(2 + 3) * 4", 20)
        near("10 - 4 - 3", 3)
        near("100 / 10 / 2", 5)
        near("12 × 3.5", 42)
        near("84 ÷ 2", 42)
        near("2 ^ 10", 1024)
        near("2 ** 10", 1024)
        near("2 ^ 3 ^ 2", 512)
        near("-2 ^ 2", -4)
        near("2 ^ -1", 0.5)
        near("-(2 + 3) * 2", -10)
        near("3 − 1", 2)
        near("10 x 4", 40)
        near(".5 + .25", 0.75)
        near("1.5e3 * 2", 3000)
        near("2 + 2 =", 4)
    }

    t.test("mod is the JS remainder") {
        near("10 mod 3", 1)
        near("-7 mod 3", -1)
        none("10 mod 0")
    }

    t.test("percent is a share of the left side after + and -, else x/100") {
        near("200 + 10%", 220)
        near("50 - 20%", 40)
        near("15% of 80", 12)
        near("10% * 50", 5)
        near("200 * 10%", 20)
        none("50%", "a bare percent is a lone number")
        none("80 of 15", "of needs a percent on its left")
    }

    t.test("thousands separators in, grouped label out, plain copy") {
        let r = must("1,000 * 3")
        t.eq(r.label, "3,000")
        t.eq(r.copy, "3000")
        t.eq(r.sub, "1,000 × 3")
        near("1,234,567 + 1", 1234568)
        none("1,2 + 3", "a comma that is not a thousands separator")
        none("1,0000 + 1")
    }

    t.test("constants and functions") {
        near("pi * 2", Double.pi * 2)
        t.eq(must("pi * 2").sub, "π × 2")
        near("π * 1", Double.pi)
        near("e * 1", M_E)
        near("sqrt(16)", 4)
        near("sqrt 16 + 1", 5)
        near("sin(pi / 2)", 1)
        near("cos(0)", 1)
        near("tan(pi / 4)", 1)
        near("log(1000)", 3)
        near("ln(e)", 1)
        near("abs(-5)", 5)
        near("round(2.5)", 3)
        near("round(-2.5)", -2)
        near("floor(2.7)", 2)
        near("ceil(2.1)", 3)
        near("sqrt(2)^2", 2)
        t.eq(must("sin(pi)").label, "0", "trig noise snaps to zero")
        t.eq(must("sqrt(16)").sub, "sqrt(16)")
    }

    t.test("division by zero, overflow and NaN are nil, never Infinity") {
        for q in ["1 / 0", "0 / 0", "1 / (2 - 2)", "2 ^ 1024", "1e308 * 10", "sqrt(-1)", "log(0)"] { none(q) }
    }

    t.test("formatting") {
        t.eq(must("1 / 3").label, "0.3333333333")
        t.eq(must("0.1 + 0.2").label, "0.3")
        t.eq(must("1000000 / 3").label, "333,333.3333")
        t.eq(must("1000000 / 3").copy, "333333.3333")
        t.eq(must("1e20 * 1e5").label, "1e25")
        t.eq(must("1 / 3e9").label, "3.333333333e-10")
        t.eq(must("-5 * 0").label, "0")
        t.eq(must("2.50 * 1").label, "2.5")
        t.eq(must("0.00001 * 1").label, "0.00001", "JS keeps positional down to 1e-6")
        t.eq(must("10 ^ 14").label, "100,000,000,000,000")
    }

    t.test("not math is nil") {
        for q in [
            "", " ", "hello", "hello world", "what is 2 + 2", "@juno", "@juno 2 + 2",
            "42", "-42", "(42)", "1,000", "3.14", "1e5", "pi", "e", "x",
            "1.2.3", "v1.2", "10.0.0.1",
            "2026-09-26", "9/26/2026", "26.09.2026", "10:30",
            "555-1234", "555-123-4567", "(555) 123-4567", "+1 555 123 4567", "+44 20 7946 0958", "1-800-555-0199",
            "2 + ", "* 3", "(2 + 3", "2 + 3)", "2 3", "sqrt", "0x1f", "2 + two", "eval(1)", "2 + alert(1)",
            String(repeating: "x", count: 300), String(repeating: "1+", count: 150) + "1",
        ] { none(q) }
    }

    t.test("length, mass, volume conversions") {
        let r = near("5 km in miles", 3.106855961)
        t.eq(r.label, "3.107 mi")
        t.eq(r.sub, "5 km in miles")
        t.eq(r.copy, "3.106855961")
        near("5km to mi", 3.106855961)
        near("5 kilometres as miles", 3.106855961)
        near("5 km = mi", 3.106855961)
        near("5km=mi", 3.106855961)
        near("10 feet in meters", 3.048)
        near("1 foot to cm", 30.48)
        near("3 in in cm", 7.62)
        near("1 mile in yards", 1760)
        near("10 kg in lb", 22.04622622)
        near("1 pound in grams", 453.59237)
        near("16 oz in lb", 1)
        near("1 gal in l", 3.785411784)
        near("1 cup in ml", 236.5882365)
        near("1 tbsp to tsp", 3)
        near("1 fl oz in ml", 29.57352956)
        near("2 cups to fluid ounces", 16)
        t.eq(must("2 cups in ml").sub, "2 cups in milliliters")
    }

    t.test("temperature conversions use offsets") {
        let r = near("72f to c", 22.22222222)
        t.eq(r.label, "22.22 °C")
        t.eq(r.sub, "72 °F in Celsius")
        near("72 °F in C", 22.22222222)
        near("72°F in °C", 22.22222222)
        near("100 celsius in fahrenheit", 212)
        near("0 c to k", 273.15)
        near("-40 f to c", -40)
        near("300 kelvin in c", 26.85)
        near("100 degrees f in c", 37.77777778)
        none("-500 c to k", "below absolute zero")
    }

    t.test("time, data, speed, area conversions") {
        t.eq(must("3 hours in minutes").label, "180 min")
        near("1 day in hours", 24)
        near("90 min to h", 1.5)
        near("1 week in days", 7)
        let gb = must("2 GB in MB")
        t.eq(gb.label, "2,000 MB")
        t.eq(gb.copy, "2000")
        near("2 GiB in MiB", 2048)
        near("1 GiB in MB", 1073.741824)
        near("8 bits in bytes", 1)
        near("1 tb to gb", 1000)
        near("100 mph in km/h", 160.9344)
        near("100 km/h to mph", 62.13711922)
        near("10 knots in km/h", 18.52)
        near("100 sq ft in m2", 9.290304)
        near("100 square feet in square meters", 9.290304)
        near("1 acre to hectares", 0.4046856422)
        near("1 ha in m²", 10000)
        near("1 sq mi in acres", 640)
        t.eq(must("1 sq mi in acres").label, "640 acres")
    }

    t.test("conversions that do not line up are nil") {
        none("5 km", "no target: nil, it may be a file name")
        none("5 km in kg", "different dimensions")
        none("5 km in parsecs", "unknown unit")
        none("km in miles", "no quantity")
        none("5 usd in eur", "no currency here")
        none("put this in the box")
        none("5 things to do")
    }

    t.test("calcResult builds an answer row") {
        guard let row = calcResult(Query("12 * 3.5")) else { t.ok(false, "no row"); return }
        t.eq(row.id, "calc:12 * 3.5")
        t.eq(row.kind, "calc")
        t.eq(row.title, "42")
        t.eq(row.subtitle, "12 × 3.5")
        t.eq(row.section, .answer)
        t.eq(row.icon, .symbol("equal.circle", .signal))
        t.eq(row.copyText, "42")
        t.ok(calcResult(Query("safari")) == nil)
    }

    t.test("runs well under a millisecond") {
        let qs = ["12 * 3.5", "5 km in miles", "hello world", "sqrt(2) + sin(pi / 4) * 3 ^ 2", "72 °F in C", "555-123-4567"]
        let n = 500
        let start = DispatchTime.now().uptimeNanoseconds
        for _ in 0..<n { for q in qs { _ = Calc.evaluate(q) } }
        let perCall = Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6 / Double(n * qs.count)
        print("calc: \(String(format: "%.4f", perCall)) ms per call (unoptimized test build, \(n * qs.count) calls)")
        t.ok(perCall < 0.5, "\(perCall) ms per call")
    }
}
