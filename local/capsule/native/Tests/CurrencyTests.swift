// Currency tests: injected rates only, no network.

import Foundation

// capsule-suite: currencySuite
let currencySuite = Suite("currency") { t in
    let now = Date(timeIntervalSince1970: 1_790_000_000)
    let fresh = CurrencyRates(base: "USD", table: ["EUR": 0.92, "GBP": 0.8, "JPY": 150, "INR": 83, "PKR": 280, "TRY": 32, "CAD": 1.36],
                              fetchedAt: now.addingTimeInterval(-3600))
    let old = CurrencyRates(base: "usd", table: ["eur": 0.92, "gbp": 0.8], fetchedAt: now.addingTimeInterval(-3 * 86_400 - 60))
    func ev(_ s: String, _ r: CurrencyRates? = nil, home: String = "USD") -> CurrencyAnswer? {
        Currency.evaluate(s, rates: r ?? fresh, home: home, now: now)
    }

    t.test("code to code") {
        let a = ev("100 usd in eur")
        t.eq(a?.label, "92.00 EUR")
        t.eq(a?.copy, "92.00")
        t.eq(a?.sub, "100 USD in EUR · 1 USD = 0.92 EUR")
        t.eq(a?.id, "currency:100 USD EUR")
        t.eq(ev("100USD to EUR")?.label, "92.00 EUR")
        t.eq(ev("100 usd = eur")?.label, "92.00 EUR")
        t.eq(ev("usd 100 in eur")?.label, "92.00 EUR")
        t.eq(ev("1,000 eur to gbp")?.label, "869.57 GBP")
        t.eq(ev("1,000,000 usd in jpy")?.label, "150,000,000 JPY", "yen has no cents")
        t.eq(ev("1,000,000 usd in jpy")?.copy, "150000000")
    }

    t.test("symbols") {
        t.eq(ev("€50 to gbp")?.label, "43.48 GBP")
        t.eq(ev("$20 in eur")?.label, "18.40 EUR")
        t.eq(ev("20$ in eur")?.label, "18.40 EUR")
        t.eq(ev("£10 in €")?.label, "11.50 EUR")
    }

    t.test("no target converts to home, for common currencies only") {
        t.eq(ev("50 eur")?.label, "54.35 USD")
        t.eq(ev("50 euros")?.label, "54.35 USD")
        t.eq(ev("€50", home: "GBP")?.label, "43.48 GBP")
        t.ok(ev("50 usd") == nil, "already home")
        t.ok(ev("50 try") == nil, "a word-code never stands alone")
        t.ok(ev("50 pounds") == nil, "pounds may be weight")
    }

    t.test("ambiguous names need a firm other side") {
        t.eq(ev("10 pounds in eur")?.label, "11.50 EUR")
        t.eq(ev("100 usd to try")?.label, "3,200.00 TRY")
        t.ok(ev("10 pounds in rupees") == nil)
        t.ok(ev("10 pounds in kg") == nil, "weight is calc's")
        t.ok(Calc.evaluate("10 pounds in kg") != nil)
    }

    t.test("old rates say their age in the label") {
        t.eq(ev("100 usd in eur", old)?.label, "92.00 EUR · rates from 3 days ago")
        let y = CurrencyRates(base: "USD", table: ["EUR": 0.92], fetchedAt: now.addingTimeInterval(-86_400 - 1))
        t.eq(ev("100 usd in eur", y)?.label, "92.00 EUR · rates from yesterday")
    }

    t.test("not money is nil") {
        for q in ["", "usd", "eur to gbp", "100", "100 xyz in eur", "100 usd in xyz", "100 usd in usd", "-5 usd in eur",
                  "5 km in miles", "100 usd in eur please", "hello 100 usd", "100 usd in eur and gbp", "all 5 in top",
                  "1.2.3 usd in eur", "100 usd in gbp"] {
            let r = ev(q, q == "100 usd in gbp" ? CurrencyRates(base: "USD", table: ["EUR": 0.9], fetchedAt: now) : nil)
            t.ok(r == nil, "\(q) gave \(String(describing: r?.label))")
        }
    }

    t.test("tiny amounts keep four decimals") {
        t.eq(ev("1 jpy in usd")?.label, "0.0067 USD")
    }

    t.test("currencyResult row") {
        guard let row = currencyResult(Query("100 usd in eur"), rates: fresh, now: now) else { t.ok(false, "no row"); return }
        t.eq(row.kind, "currency")
        t.eq(row.section, .answer)
        t.eq(row.icon, .symbol("eurosign.circle", .signal))
        t.eq(row.copyText, "92.00")
        t.eq(row.payload["to"], "EUR")
    }
}
