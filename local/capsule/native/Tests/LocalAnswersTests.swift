// capsule-suite: localAnswersSuite
// LocalAnswers: the answers and your own lists, wired to rows with actions. No network (rates come
// from a fake), no real app or link is opened, the pasteboard is a private one.

import AppKit
import Foundation

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    var count: Int { lock.withLock { n } }
    func bump() { lock.withLock { n += 1 } }
}

private let RATES_JSON = #"""
{"result":"success","base_code":"USD","time_last_update_unix":1790000000,
 "rates":{"USD":1,"EUR":0.92,"GBP":0.8,"JPY":150,"INR":83,"PKR":280,"CAD":1.36,"AUD":1.5,"CHF":0.9,"MYR":4.4,"THB":35,"SGD":1.3}}
"""#

private let NOW = Date(timeIntervalSince1970: 1_790_000_100)

private func home(_ name: String) -> String {
    let h = vyScratch("local-\(name)")
    try? FileManager.default.removeItem(atPath: h + "/capsule")
    return h
}

private func write(_ home: String, _ json: String) {
    let dir = home + "/capsule"
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    try? Data(json.utf8).write(to: URL(fileURLWithPath: dir + "/snippets.json"))
}

/// Spin the main loop until cond holds (up to 3 s).
private func spin(_ cond: () -> Bool) -> Bool { MainActor.assumeIsolated { until(3, cond) } }

private func rows(_ p: LocalAnswersProvider, _ text: String) -> [ResultItem] { p.resultsNow(for: Query(text)) }

private let USER_FILE = #"""
{ "snippets": [ { "keyword": ";sig", "title": "Signature", "text": "alex\nHarlow Legal\n{date}" },
                { "keyword": ";re", "text": "Re: {clipboard}" }, { "keyword": "", "text": "bad" } ],
  "quicklinks": [ { "name": "Northwind wiki", "keyword": "wiki", "url": "https://wiki.example.com/search?q={query}" },
                  { "name": "Board", "keyword": "board", "url": "https://example.com/board" } ],
  "commands": [ { "title": "Deploy kit", "keywords": ["ship"], "run": { "shell": "make deploy", "confirm": true } },
                { "title": "Open the bakery site", "keywords": ["bakery"], "run": { "open": "https://example.com/northwind" } } ] }
"""#

let localAnswersSuite = Suite("local answers") { t in
    t.test("a colour, a time and an emoji each give a row: the first two copy, the emoji pastes") {
        let p = LocalAnswersProvider(home: home("basic"), fetch: RatesFetch { nil }, now: { NOW })
        p.use24h = false
        let c = rows(p, "#ff6347")
        t.eq(c.first?.kind, "colour"); t.eq(c.first?.actions.first?.id, "copy")
        let tm = rows(p, "time in tokyo")
        t.eq(tm.first?.kind, "time"); t.eq(tm.first?.actions.first?.id, "copy")
        let e = rows(p, ":tada")
        t.ok(e.contains { $0.kind == "emoji" && $0.actions.first?.id == "paste" && $0.actions.count == 2 }, "emoji rows paste, copy is second")
        t.eq(rows(p, "").count, 0)
        t.eq(rows(p, "zzqq nothing here").count, 0)
    }

    t.test("copy puts the text on the pasteboard and closes") {
        let board = NSPasteboard(name: .init("vyre-test-local-\(getpid())"))
        let done: ActionOutcome? = t.wait { @MainActor () -> ActionOutcome in
            CapsuleModel.replyBoard = board
            let a = LocalAnswersProvider.copyAction("hello")
            return await a.run(ResultItem(id: "x", kind: "x", title: "x"), ActionContext(query: Query("x")))
        }
        t.eq(done, .close(nil))
        t.eq(board.string(forType: .string), "hello")
        board.releaseGlobally()
    }

    t.test("your file: snippets, quicklinks and commands become rows; a bad entry is named, the rest work") {
        let h = home("user"); write(h, USER_FILE)
        let p = LocalAnswersProvider(home: h, fetch: RatesFetch { nil }, now: { NOW })
        p.warm()
        t.eq(p.problems, ["snippet 3: keyword is empty"])
        let sig = rows(p, ";sig")
        t.eq(sig.first?.kind, "snippet"); t.eq(sig.first?.title, "Signature")
        t.eq(rows(p, "signature").first?.kind, "snippet", "by title")
        // Keyword alone asks for the words; keyword and words opens the search.
        let ask = rows(p, "wiki").first { $0.kind == "quicklink" }
        t.eq(ask?.subtitle, "Type what to look for after \u{201C}wiki\u{201D}")
        let go = rows(p, "wiki pastry & rye").first { $0.kind == "quicklink" }
        t.eq(go?.title, "Northwind wiki: pastry & rye")
        t.eq(go?.subtitle, "https://wiki.example.com/search?q=pastry%20%26%20rye")
        t.eq(rows(p, "board").first { $0.kind == "quicklink" }?.subtitle, "https://example.com/board")
        // A shell command asks first; an open command does not.
        let sh = rows(p, "deploy").first { $0.kind == "user-command" }
        t.eq(sh?.actions.first?.confirm, "Run \u{201C}make deploy\u{201D}?")
        let op = rows(p, "bakery").first { $0.kind == "user-command" }
        t.ok(op?.actions.first?.confirm == nil)
    }

    t.test("the fill row for a quicklink puts the keyword and a space in the box") {
        let h = home("fill"); write(h, USER_FILE)
        let p = LocalAnswersProvider(home: h, fetch: RatesFetch { nil }, now: { NOW })
        p.warm()
        let out: ActionOutcome? = t.wait { @MainActor () -> ActionOutcome in
            let r = rows(p, "wiki").first { $0.kind == "quicklink" }!
            return await r.actions[0].run(r, ActionContext(query: Query("wiki")))
        }
        t.eq(out, .replaceQuery("wiki "))
    }

    t.test("a snippet copies its text with the date and the clipboard filled in") {
        let h = home("expand"); write(h, USER_FILE)
        let p = LocalAnswersProvider(home: h, fetch: RatesFetch { nil }, now: { NOW })
        p.warm()
        let board = NSPasteboard(name: .init("vyre-test-local-snip-\(getpid())"))
        let got: String? = t.wait { @MainActor () -> String in
            CapsuleModel.replyBoard = board
            let r = rows(p, ";sig").first!
            _ = await r.actions[0].run(r, ActionContext(query: Query(";sig")))
            return board.string(forType: .string) ?? ""
        }
        t.ok(got?.hasPrefix("alex\nHarlow Legal\n2026-") == true, got ?? "nil")
        board.releaseGlobally()
    }

    t.test("the file is read again only when it changed") {
        let h = home("reload"); write(h, USER_FILE)
        let clock = Counter()
        let p = LocalAnswersProvider(home: h, fetch: RatesFetch { nil }, now: { NOW.addingTimeInterval(Double(clock.count)) })
        p.warm()
        t.eq(rows(p, "zzunique").count, 0)
        write(h, #"{ "snippets": [ { "keyword": "zzunique", "text": "new" } ] }"#)
        try? FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(5)], ofItemAtPath: h + "/capsule/snippets.json")
        t.eq(rows(p, "zzunique").count, 0, "looked at most twice a second: not yet")
        clock.bump()
        t.eq(rows(p, "zzunique").first?.kind, "snippet")
    }

    t.test("money: no rates yet is no row and one fetch; when they land the row appears and is kept on disk") {
        let h = home("money"), asked = Counter()
        let p = LocalAnswersProvider(home: h, fetch: RatesFetch { asked.bump(); return Data(RATES_JSON.utf8) }, now: { NOW })
        let landed = Counter(); p.onChange = { landed.bump() }
        t.eq(rows(p, "100 usd in eur").count, 0, "nothing to answer with yet")
        t.ok(spin {  landed.count == 1  }, "rates landed")
        t.eq(asked.count, 1)
        t.eq(rows(p, "100 usd in eur").first?.title, "92.00 EUR")
        t.ok(FileManager.default.fileExists(atPath: h + "/capsule/rates.json"))
        // A second Capsule reads the file and asks no one.
        let asked2 = Counter()
        let p2 = LocalAnswersProvider(home: h, fetch: RatesFetch { asked2.bump(); return nil }, now: { NOW })
        p2.warm()
        t.eq(rows(p2, "100 usd in eur").first?.title, "92.00 EUR")
        t.eq(asked2.count, 0)
    }

    t.test("money: only words that read as money fetch; rates older than 12 hours are refreshed, at most every 10 minutes") {
        let h = home("gate"), asked = Counter()
        let clock = Counter()   // seconds added to NOW
        let p = LocalAnswersProvider(home: h, fetch: RatesFetch { asked.bump(); return nil }, now: { NOW.addingTimeInterval(Double(clock.count)) })
        _ = rows(p, "2 apples"); _ = rows(p, "call me at 5"); _ = rows(p, "what is 12 * 3")
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        t.eq(asked.count, 0, "nothing that is not money fetches")
        _ = rows(p, "50 eur")
        t.ok(spin {  asked.count == 1  })
        _ = rows(p, "60 eur")
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        t.eq(asked.count, 1, "a failed fetch is not retried within 10 minutes")
        for _ in 0..<601 { clock.bump() }
        _ = rows(p, "70 eur")
        t.ok(spin {  asked.count == 2  }, "after 10 minutes it may try again")
    }

    t.test("rates: a bad answer is refused") {
        t.ok(RatesFetch.parse(Data("nope".utf8), now: NOW) == nil)
        t.ok(RatesFetch.parse(Data(#"{"result":"error"}"#.utf8), now: NOW) == nil)
        t.ok(RatesFetch.parse(Data(#"{"result":"success","base_code":"USD","rates":{"EUR":0.9}}"#.utf8), now: NOW) == nil, "too few rates to trust")
        t.eq(RatesFetch.parse(Data(RATES_JSON.utf8), now: NOW)?.table["EUR"], 0.92)
    }
}
