// Currency: "100 usd in eur", "€50 to gbp", "50 eur" answered from rates the app already holds.
//
// Calc stays offline and says no to currency, so this file takes the rates as a value (base,
// table, when they were fetched) and never touches the network; fetching and caching them is the
// app's job, on its own light schedule. Old rates are still useful, but the answer says how old
// they are once they pass a day, so nobody pays an invoice off last month's rate unaware.
//
// The same rule as calc: a false positive is worse than a miss. So:
//   - A code must be one the rate table knows. Codes that are also English words ("all", "top",
//     "cup", "try") and names that mean several currencies ("pounds", "rupees", "francs") need a
//     clear currency on the other side, and never answer alone.
//   - "50 eur" with no target converts to the home currency the app passes in, and only for the
//     common currencies; "50 xyz" alone says nothing.
//   - "10 pounds in kg" is not money: the target is not a currency, so this returns nil and calc
//     answers it.

import Foundation

/// Exchange rates: 1 `base` buys `table[code]` of each code. The base itself may be absent.
public struct CurrencyRates: Sendable, Equatable, Codable {
    public var base: String
    public var table: [String: Double]
    public var fetchedAt: Date
    public init(base: String, table: [String: Double], fetchedAt: Date) {
        self.base = base.uppercased(); self.fetchedAt = fetchedAt
        self.table = Dictionary(uniqueKeysWithValues: table.map { ($0.key.uppercased(), $0.value) })
    }
    /// How many of `code` one unit of the base buys, or nil when the table does not know it.
    func perUnit(_ code: String) -> Double? {
        if code == base { return 1 }
        guard let r = table[code], r > 0, r.isFinite else { return nil }
        return r
    }
    public func knows(_ code: String) -> Bool { perUnit(code) != nil }
}

public struct CurrencyAnswer: Sendable, Equatable {
    public var id: String
    public var label: String
    public var sub: String
    public var value: Double
    public var copy: String
    public var from: String
    public var to: String
}

public enum Currency {
    /// A way of naming a currency. `firm` names mean one currency and may stand alone.
    struct Named { let code: String; let firm: Bool }

    static let symbols: [Character: String] = [
        "$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR", "₩": "KRW", "₽": "RUB", "₺": "TRY",
        "₪": "ILS", "฿": "THB", "₱": "PHP", "₫": "VND", "₦": "NGN", "₴": "UAH", "₨": "PKR",
    ]
    static let names: [String: Named] = [
        "euro": .init(code: "EUR", firm: true), "euros": .init(code: "EUR", firm: true),
        "dollar": .init(code: "USD", firm: true), "dollars": .init(code: "USD", firm: true), "bucks": .init(code: "USD", firm: true),
        "yen": .init(code: "JPY", firm: true), "sterling": .init(code: "GBP", firm: true), "quid": .init(code: "GBP", firm: true),
        "pound": .init(code: "GBP", firm: false), "pounds": .init(code: "GBP", firm: false),
        "rupee": .init(code: "INR", firm: false), "rupees": .init(code: "INR", firm: false),
        "franc": .init(code: "CHF", firm: false), "francs": .init(code: "CHF", firm: false),
        "yuan": .init(code: "CNY", firm: true), "rmb": .init(code: "CNY", firm: true), "renminbi": .init(code: "CNY", firm: true),
        "baht": .init(code: "THB", firm: true), "ringgit": .init(code: "MYR", firm: true), "won": .init(code: "KRW", firm: false),
        "rupiah": .init(code: "IDR", firm: true), "dirham": .init(code: "AED", firm: false), "dirhams": .init(code: "AED", firm: false),
    ]
    /// ISO codes that are also English words: they never stand alone.
    static let wordCodes: Set<String> = ["ALL", "TOP", "CUP", "TRY", "MOP", "BOB", "GEL", "BAM", "LAK", "MAD", "PEN", "SOS"]
    /// The currencies "50 eur" (no target) answers for.
    static let common: Set<String> = ["USD", "EUR", "GBP", "JPY", "CNY", "INR", "PKR", "CAD", "AUD", "NZD", "CHF", "MYR", "THB",
                                      "SGD", "HKD", "AED", "SAR", "KRW", "BRL", "MXN", "ZAR", "SEK", "NOK", "DKK", "PLN", "IDR", "PHP"]
    /// Currencies written without minor units.
    static let noCents: Set<String> = ["JPY", "KRW", "VND", "IDR", "CLP", "ISK", "HUF", "PYG", "UGX"]
    static let connectors: Set<String> = ["in", "to", "as", "into", "="]

    static func currency(_ w: String, _ rates: CurrencyRates) -> Named? {
        if w.count == 1, let c = w.first, let code = symbols[c] { return rates.knows(code) ? Named(code: code, firm: true) : nil }
        if let n = names[w] { return rates.knows(n.code) ? n : nil }
        let up = w.uppercased()
        if up.count == 3, up.allSatisfy({ $0 >= "A" && $0 <= "Z" }), rates.knows(up) {
            return Named(code: up, firm: !wordCodes.contains(up))
        }
        return nil
    }

    static func amount(_ w: String) -> Double? {
        let c = Array(w)
        guard !c.isEmpty, let end = Calc.scanNumber(c, 0, exponent: false), end == c.count else { return nil }
        return Double(w.replacingOccurrences(of: ",", with: ""))
    }

    /// Splits "€50", "50eur" and "100$" into words: symbols and letter/digit runs stand apart.
    static func words(_ s: String) -> [String] {
        var out: [String] = [], cur = ""
        var kind = 0 // 1 digits, 2 letters
        func push() { if !cur.isEmpty { out.append(cur) }; cur = ""; kind = 0 }
        for ch in s {
            if ch == " " { push(); continue }
            if symbols[ch] != nil || ch == "=" { push(); out.append(String(ch)); continue }
            let k = (ch >= "0" && ch <= "9") || ch == "." || ch == "," ? 1 : 2
            if kind != 0 && k != kind { push() }
            kind = k; cur.append(ch)
        }
        push()
        return out
    }

    /// The answer for this text, or nil when it is not clearly a currency conversion.
    public static func evaluate(_ text: String, rates: CurrencyRates, home: String = "USD", now: Date = Date()) -> CurrencyAnswer? {
        let q = Query(text).normalized
        if q.isEmpty || q.count > 60 { return nil }
        let w = words(q)
        var amt: Double?, from: Named?, rest: ArraySlice<String>
        if w.count >= 2, let a = amount(w[0]), let f = currency(w[1], rates) { amt = a; from = f; rest = w[2...] }
        else if w.count >= 2, let f = currency(w[0], rates), let a = amount(w[1]) { amt = a; from = f; rest = w[2...] }
        else { return nil }
        guard let n = amt, let src = from, n >= 0, n.isFinite else { return nil }
        var dst: Named
        if rest.isEmpty {
            let h = home.uppercased()
            guard src.firm, common.contains(src.code), h != src.code, rates.knows(h) else { return nil }
            dst = Named(code: h, firm: true)
        } else {
            guard rest.count == 2, connectors.contains(rest.first!), let d = currency(rest.last!, rates) else { return nil }
            if !src.firm && !d.firm { return nil }
            if d.code == src.code { return nil }
            dst = d
        }
        guard let pf = rates.perUnit(src.code), let pt = rates.perUnit(dst.code) else { return nil }
        let rate = pt / pf
        let v = n * rate
        guard v.isFinite else { return nil }
        let money = figure(v, dst.code, grouped: true)
        let copy = figure(v, dst.code, grouped: false)
        var label = "\(money) \(dst.code)"
        if let age = age(rates.fetchedAt, now) { label += " · rates from \(age)" }
        let sub = "\(figure(n, src.code, grouped: true, trim: true)) \(src.code) in \(dst.code) · 1 \(src.code) = \(rateText(rate)) \(dst.code)"
        return CurrencyAnswer(id: "currency:\(Calc.format(n, 10, false) ?? "") \(src.code) \(dst.code)", label: label, sub: sub,
                              value: Double(copy) ?? v, copy: copy, from: src.code, to: dst.code)
    }

    /// Money as written: two decimals (none for yen and the like), grouped for the label.
    static func figure(_ v: Double, _ code: String, grouped: Bool, trim: Bool = false) -> String {
        var decimals = noCents.contains(code) ? 0 : 2
        if v != 0 && abs(v) < 0.01 { decimals = 4 }
        var s = String(format: "%.\(decimals)f", v)
        if trim, s.contains(".") { while s.last == "0" { s.removeLast() }; if s.last == "." { s.removeLast() } }
        guard grouped else { return s }
        let parts = s.split(separator: ".", maxSplits: 1)
        let neg = parts[0].hasPrefix("-")
        let int = Calc.group(String(neg ? parts[0].dropFirst() : parts[0]))
        return (neg ? "-" : "") + int + (parts.count > 1 ? "." + parts[1] : "")
    }

    static func rateText(_ r: Double) -> String { Calc.format(r, 4, false) ?? String(r) }

    /// "yesterday", "3 days ago"; nil while the rates are under a day old.
    static func age(_ fetched: Date, _ now: Date) -> String? {
        let days = Int(now.timeIntervalSince(fetched) / 86_400)
        if days < 1 { return nil }
        return days == 1 ? "yesterday" : "\(days) days ago"
    }

    static let signs: [String: String] = [
        "USD": "dollarsign.circle", "EUR": "eurosign.circle", "GBP": "sterlingsign.circle", "JPY": "yensign.circle",
        "INR": "indianrupeesign.circle", "KRW": "wonsign.circle", "RUB": "rublesign.circle", "TRY": "turkishlirasign.circle",
        "THB": "bahtsign.circle", "CHF": "francsign.circle", "PHP": "pesosign.circle", "ILS": "shekelsign.circle",
        "CNY": "yensign.circle", "BRL": "brazilianrealsign.circle", "VND": "dongsign.circle", "NGN": "nairasign.circle",
    ]
}

/// A currency row: Enter copies the converted figure (the app wires the action from copyText).
public func currencyResult(_ q: Query, rates: CurrencyRates, home: String = "USD", now: Date = Date()) -> ResultItem? {
    guard let a = Currency.evaluate(q.text, rates: rates, home: home, now: now) else { return nil }
    return ResultItem(id: a.id, kind: "currency", title: a.label, subtitle: a.sub,
                      icon: .symbol(Currency.signs[a.to] ?? "banknote", .signal), section: .answer, score: 1,
                      copyText: a.copy, payload: ["copy": a.copy, "from": a.from, "to": a.to])
}
