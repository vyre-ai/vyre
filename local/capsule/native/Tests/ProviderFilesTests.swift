// capsule-suite: providerFilesSuite
// Files, recent files, documents and mail: FileTaste ported from local.test.js, predicates and
// result mapping pure (Spotlight does not index the scratch folder, so live hits cannot be
// asserted), and the long-lived query started, re-aimed and stopped against a fixture scope.

import AppKit
import Foundation

/// A folder of the test's own under the scratch dir (VYRE_CAPSULE_SCRATCH), removed by the caller.
func providerFixture(_ name: String) -> String {
    let base = ProcessInfo.processInfo.environment["VYRE_CAPSULE_SCRATCH"] ?? NSTemporaryDirectory()
    let dir = (base as NSString).appendingPathComponent("cp-local-\(name)-\(getpid())-\(UInt32.random(in: 0...UInt32.max))")
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    return (dir as NSString).resolvingSymlinksInPath
}

let testBoardName = NSPasteboard.Name("vyre-test-\(getpid())")

let providerFilesSuite = Suite("provider files") { t in
    let DAY = 86_400_000.0

    t.test("hostile input stays inside the quotes") {
        t.eq(FileTaste.mdQuery("a\"b"), #"kMDItemDisplayName == "*a\"b*"cd"#)
        t.eq(FileTaste.mdQuery("a*b"), #"kMDItemDisplayName == "*a\*b*"cd"#)
        t.eq(FileTaste.mdQuery("a\\b"), #"kMDItemDisplayName == "*a\\b*"cd"#)
        t.eq(FileTaste.mdQuery("x\"cd || kMDItemFSName == \"*"), #"kMDItemDisplayName == "*x\"cd || kMDItemFSName == \"\**"cd"#)
        t.eq(FileTaste.mdQuery("two\nlines\r\t"), #"kMDItemDisplayName == "*two lines*"cd"#)
        for q in ["\"", "\\\"", "\"\\", "*\"cd", "\\\\\"", "\"\n\"", "$time.now\""] {
            let s = FileTaste.mdQuery(q)
            var body = String(s.dropFirst("kMDItemDisplayName == \"".count).dropLast("\"cd".count))
            body = body.replacingOccurrences(of: #"\\."#, with: "", options: .regularExpression)
            t.ok(!body.contains("\"") && !body.contains("\n"), "unescaped quote from \(q)")
            t.ok(NSPredicate(fromMetadataQueryString: s) != nil, "parses: \(q)")
        }
    }

    t.test("noise filter") {
        t.ok(FileTaste.noise("/Users/a/Library/Mail/x"))
        t.ok(FileTaste.noise("/Users/a/p/node_modules/x"))
        t.ok(FileTaste.noise("/Users/a/Foo.app/Contents/Info.plist"))
        t.ok(FileTaste.noise("/Users/a/.ssh/config"))
        t.ok(!FileTaste.noise("/Users/a/Documents/Library notes.txt"))
        t.ok(!FileTaste.noise("/Users/a/Documents/app plan.md"))
        for p in ["/Users/a/google-cloud-sdk/lib/zoneinfo/Asia/Calcutta", "/Users/a/p/vendor/x", "/Users/a/p/build/out.pdf", "/Users/a/p/dist",
                  "/Users/a/p/target/debug/x", "/Users/a/p/.next/x", "/Users/a/py/lib/python3/site-packages/x", "/Users/a/p/third_party/x",
                  "/Users/a/p/third-party/x", "/Users/a/ios/Pods/x", "/Users/a/p/venv/x", "/Users/a/p/.venv/x", "/Users/a/p/coverage/x",
                  "/Users/a/tmp/x", "/Users/a/p/out/x", "/Users/a/Library/Caches/x", "/Users/a/x/Foo.xcodeproj/y"] { t.ok(FileTaste.noise(p), p) }
        for p in ["/Users/a/Documents/Build notes.pdf", "/Users/a/Documents/outline.md", "/Users/a/Desktop/Target receipts",
                  "/Users/a/Documents/sdk.pdf", "/Users/a/Downloads/distances.xlsx"] { t.ok(!FileTaste.noise(p), p) }
    }

    t.test("taste: name start before substring, documents before code, recent use rises, apps win a tie") {
        let home = "/Users/a", now = 1_790_000_000_000.0
        func ts(_ label: String, _ dir: String, q: String = "invoice", used: Double = 0, repo: Bool = false) -> Double {
            FileTaste.taste(FileCandidate(path: "\(dir)/\(label)", used: used, repo: repo), q, now: now, home: home)
        }
        let doc = ts("Invoice March.pdf", "\(home)/Documents")
        let word = ts("March invoice.pdf", "\(home)/Documents")
        let sub = ts("Reinvoiced.pdf", "\(home)/Documents")
        let code = ts("invoice.ts", "\(home)/code/app/src", repo: true)
        let recent = ts("March invoice.pdf", "\(home)/Documents", used: now - 3_600_000)
        t.ok(doc > word && word > sub, "prefix, then word start, then substring")
        t.ok(sub <= 0.3, "a substring alone is low")
        t.ok(code < word && code < doc - 0.2, "a repo file sits below documents")
        t.ok(recent > word, "opened an hour ago rises")
        t.eq(ts("Calcutta", "\(home)/x", q: "zz"), 0, "no match, no row")
        let folder = FileTaste.taste(FileCandidate(path: "\(home)/Documents/Invoices", isFolder: true), "invoice", now: now, home: home)
        let deep = FileTaste.taste(FileCandidate(path: "\(home)/p/q/Invoices", isFolder: true), "invoice", now: now, home: home)
        t.ok(folder > deep, "a folder in Documents before one deep in a tree")
        t.ok(ts("Calculations.xlsx", "\(home)/Documents", q: "calcu", used: now) < 0.9, "a prefix-matched file stays under a prefix-matched app")
        t.ok(ts("Q3 invoice.pdf", "\(home)/Documents", q: "invoice pdf") > 0, "the last word can name the type")
        t.ok(ts("old.pdf", "\(home)/Documents", q: "old", used: now - 400 * DAY) < ts("old.pdf", "\(home)/Documents", q: "old", used: now - 2 * DAY))
    }

    t.test("filenameLike: an extension, a slash, or a known extension as the last word") {
        for q in ["report.pdf", "q3.xl", "notes.md", "invoice pdf", "Desktop/", "budget xlsx"] { t.ok(FileTaste.filenameLike(q), q) }
        for q in ["invoice", "calcu", "mr. smith", "notes on it", "v1.2"] { t.ok(!FileTaste.filenameLike(q), q) }
        t.eq(FileTaste.extOf("A.PDF"), "pdf")
        t.eq(FileTaste.extOf("Makefile"), "")
    }

    t.test("mapping: noise and gone files dropped, folders typed, repos found, tilde, ranked") {
        let home = "/Users/alex"
        let rows = [
            SpotlightRow(path: "\(home)/Library/Caches/report.txt"),
            SpotlightRow(path: "\(home)/code/site/docs/report.md", contentType: "net.daringfireball.markdown"),
            SpotlightRow(path: "\(home)/Documents/report.pdf", contentType: "com.adobe.pdf", dates: [lastUsedKey: 1_790_000_000_000 - 3_600_000]),
            SpotlightRow(path: "\(home)/Documents/Reports"),
            SpotlightRow(path: "\(home)/Documents/report.pdf"),
            SpotlightRow(path: "\(home)/Documents/gone report.pdf"),
        ]
        let present: Set<String> = ["\(home)/code/site/docs/report.md", "\(home)/Documents/report.pdf", "\(home)/Documents/Reports", "\(home)/code/site/.git"]
        let out = mapFileRows(rows, query: "report", home: home, now: 1_790_000_000_000, limit: 10,
                              exists: { p in (present.contains(p), p.hasSuffix("Reports")) }, openWith: false,
                              board: { NSPasteboard(name: testBoardName) })
        t.eq(out.map(\.title), ["report.pdf", "Reports", "report.md"])
        t.eq(out.map(\.kind), ["file", "folder", "file"])
        t.eq(out.first?.subtitle, "~/Documents")
        t.eq(out.first?.id, "file:\(home)/Documents/report.pdf")
        t.eq(out.first?.section, .files)
        t.eq(out.first?.icon, .file("\(home)/Documents/report.pdf"))
        t.eq(out.first?.fileURL?.path, "\(home)/Documents/report.pdf")
        t.eq(out.first?.actions.map(\.id), ["open", "reveal", "copy-path", "copy-file", "quicklook", "trash"])
        t.ok((out.last?.score ?? 1) < (out.first?.score ?? 0) - 0.2, "the repo file sits below")
    }

    t.test("predicates parse and say what they should") {
        let d = SpotlightPredicates.documents("quarterly led")
        t.ok(d.contains(#"kMDItemTextContent == "quarterly*"cdw && kMDItemTextContent == "led*"cdw"#), d)
        t.ok(d.contains(#"kMDItemDisplayName != "*quarterly led*"cd"#), "name matches are left to Files")
        t.ok(NSPredicate(fromMetadataQueryString: d) != nil)
        let m = SpotlightPredicates.mail("Harlow \"x")
        t.ok(m.hasPrefix(#"kMDItemContentType == "com.apple.mail.emlx""#))
        t.ok(m.contains(#"kMDItemSubject == "*Harlow \"x*"cd"#), m)
        t.ok(NSPredicate(fromMetadataQueryString: m) != nil)
        let r = SpotlightPredicates.predicate(SpotlightPredicates.recent())
        t.ok(r.predicateFormat.contains("kMDItemLastUsedDate >="), r.predicateFormat)
        t.eq(SpotlightPredicates.predicate("((((").predicateFormat, "FALSEPREDICATE", "a bad string matches nothing, and does not raise")
        t.eq(SpotlightPredicates.predicate(SpotlightPredicates.documents("   ")).predicateFormat, "FALSEPREDICATE")
        t.ok(NSPredicate(fromMetadataQueryString: SpotlightPredicates.mail("   ")) != nil)
    }

    t.test("SpotlightRow from item values") {
        let d = Date(timeIntervalSince1970: 1_700_000_000)
        let r = SpotlightRow.from([NSMetadataItemPathKey: "/Users/alex/a.pdf", NSMetadataItemDisplayNameKey: "a", NSMetadataItemContentTypeKey: "com.adobe.pdf",
                                   lastUsedKey: d, "kMDItemAuthors": ["Juno", "Kit"], "kMDItemSubject": "Hi"])
        t.eq(r?.name, "a")
        t.eq(r?.dates[lastUsedKey], 1_700_000_000_000)
        t.eq(r?.strings["kMDItemAuthors"], "Juno, Kit")
        t.eq(r?.strings["kMDItemSubject"], "Hi")
        t.ok(SpotlightRow.from([NSMetadataItemPathKey: "relative"]) == nil)
    }

    t.test("recent: wants, order, filter and listing scores") {
        t.eq(RecentFilesProvider.wants(""), "")
        t.eq(RecentFilesProvider.wants("recent"), "")
        t.eq(RecentFilesProvider.wants("Recent invoice"), "invoice")
        t.eq(RecentFilesProvider.wants("receipt"), nil)
        let now = 1_790_000_000_000.0
        let rows = [
            SpotlightRow(path: "/Users/alex/Documents/older.pdf", dates: [lastUsedKey: now - 3 * DAY]),
            SpotlightRow(path: "/Users/alex/Documents/newest invoice.pdf", dates: [lastUsedKey: now - 60_000 * 5]),
            SpotlightRow(path: "/Users/alex/Library/x.plist", dates: [lastUsedKey: now]),
        ]
        let all = RecentFilesProvider.map(rows, filter: "", listing: false, home: "/Users/alex", now: now, limit: 8, exists: { _ in true })
        t.eq(all.map(\.title), ["newest invoice.pdf", "older.pdf"])
        t.eq(all.first?.subtitle, "Opened 5 min ago · ~/Documents")
        t.ok((all.first?.score ?? 1) < 1, "the empty box's rows sit low")
        let listed = RecentFilesProvider.map(rows, filter: "invoice", listing: true, home: "/Users/alex", now: now, limit: 8, exists: { _ in true })
        t.eq(listed.map(\.title), ["newest invoice.pdf"])
        t.ok((listed.first?.score ?? 0) > 2, "asked for by name, above everything")
    }

    t.test("documents: below name matches, section In documents") {
        let now = 1_790_000_000_000.0
        let rows = [SpotlightRow(path: "/Users/alex/Documents/ledger.pages", dates: [lastUsedKey: now - DAY]),
                    SpotlightRow(path: "/Users/alex/Documents/notes.txt"),
                    SpotlightRow(path: "/Users/alex/node_modules/x.txt")]
        let out = DocumentsProvider.map(rows, home: "/Users/alex", now: now, limit: 5, exists: { _ in true })
        t.eq(out.map(\.title), ["ledger.pages", "notes.txt"])
        t.ok(out.allSatisfy { $0.section == .documents && $0.score < 0.25 })
        t.eq(out.first?.id, "doc:/Users/alex/Documents/ledger.pages")
    }

    t.test("mail: message URL when the index has the id, else the emlx") {
        t.eq(MailProvider.messageURL("<abc.123@northwind.example>")?.absoluteString, "message://%3cabc.123@northwind.example%3e")
        t.eq(MailProvider.messageURL("abc@x"), URL(string: "message://%3cabc@x%3e"))
        t.ok(MailProvider.messageURL("") == nil)
        let now = 1_790_000_000_000.0
        let rows = [
            SpotlightRow(path: "/Users/alex/Library/Mail/V10/1.emlx", strings: ["kMDItemSubject": "Harlow Legal invoice", "kMDItemAuthors": "Juno",
                                                                                 "com_apple_mail_messageID": "<m1@harlow.example>"],
                         ),
            SpotlightRow(path: "/Users/alex/Library/Mail/V10/2.emlx", dates: ["com_apple_mail_dateReceived": now - 2 * 3_600_000],
                         strings: ["kMDItemSubject": "", "kMDItemAuthors": "Kit"]),
        ]
        let out = MailProvider.map(rows, query: "harlow", now: now, limit: 5)
        t.eq(out.map(\.title), ["Harlow Legal invoice", "(no subject)"])
        t.eq(out.first?.payload["url"], "message://%3cm1@harlow.example%3e")
        t.eq(out.last?.payload["url"], "file:///Users/alex/Library/Mail/V10/2.emlx")
        t.eq(out.last?.subtitle, "Kit · 2 h ago")
        t.ok(out.allSatisfy { $0.section == .mail && $0.kind == "mail" })
        t.eq(out.first?.icon, .bundle("com.apple.mail"))
    }

    t.test("debounce: only the newest keystroke searches") {
        let d = Debounce(0.05)
        let got = t.wait { () async -> [Bool] in
            async let a = d.settle()
            try? await Task.sleep(nanoseconds: 10_000_000)
            async let b = d.settle()
            return [await a, await b]
        }
        t.eq(got, [false, true])
    }

    t.test("the long-lived query runs against a fixture scope, is re-aimed, and cool() stops it") {
        let dir = providerFixture("spot")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        FileManager.default.createFile(atPath: dir + "/northwind ledger.txt", contents: Data("Northwind Bakery".utf8))
        let p = t.wait { @MainActor () -> (FilesProvider, [Int], Double) in
            let files = FilesProvider(scopes: [dir], home: dir, debounce: 0, board: { NSPasteboard(name: testBoardName) })
            files.warm()
            let t0 = Date()
            var counts: [Int] = []
            for q in ["no", "nor", "northwind"] { counts.append(await files.results(for: Query(q)).count) }
            return (files, counts, Date().timeIntervalSince(t0))
        }
        // Spotlight does not index the scratch folder, so no hit is asserted: only that each search
        // answers, within its deadline, and that nothing is left running.
        t.eq(p?.1.count, 3)
        t.ok((p?.2 ?? 9) < 1.5, "three searches in \(p?.2 ?? -1) s")
        let state = t.wait { @MainActor () -> (Bool, Bool) in
            let f = p!.0
            let before = f.spot.exists
            f.cool()
            return (before, f.spot.isRunning || f.spot.exists)
        }
        t.eq(state?.0, true)
        t.eq(state?.1, false, "cool() leaves no query")
        t.eq(t.wait { await p!.0.results(for: Query("a")) }?.count, 0, "one letter does not search")
    }

    t.test("each provider's cool() leaves no query") {
        let dir = providerFixture("cool")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let left = t.wait { @MainActor () -> [Bool] in
            let r = RecentFilesProvider(scopes: [dir], home: dir), d = DocumentsProvider(scopes: [dir], home: dir, debounce: 0), m = MailProvider(scopes: [dir], debounce: 0)
            _ = await r.results(for: Query(""))
            _ = await d.results(for: Query("northwind"))
            _ = await m.results(for: Query("harlow"))
            r.cool(); d.cool(); m.cool()
            return [r.spot.exists, d.spot.exists, m.spot.exists]
        }
        t.eq(left, [false, false, false])
    }

    // Keystroke to results, against the real home folder. Prints timings and counts only, never a
    // name. Runs only when the lead asks: VYRE_CAPSULE_MEASURE=1.
    if ProcessInfo.processInfo.environment["VYRE_CAPSULE_MEASURE"] == "1" {
        t.test("measure: keystroke to file rows, NSMetadataQuery vs mdfind") {
            let words = ["in", "inv", "invo", "invoice", "re", "rep", "report", "no", "not", "notes", "bud", "budget", "zzqx"]
            let native = t.wait(timeout: 60) { @MainActor () -> [Double] in
                let f = FilesProvider(debounce: 0, board: { NSPasteboard(name: testBoardName) })
                f.warm()
                var ms: [Double] = [], spot: [Double] = []
                for w in words {
                    let t0 = Date()
                    _ = await f.results(for: Query(w))
                    ms.append(Date().timeIntervalSince(t0) * 1000)
                }
                for w in words {
                    let t0 = Date()
                    _ = await f.spot.run(SpotlightAsk(predicate: SpotlightPredicates.predicate(SpotlightPredicates.names(w)), limit: 60, deadline: 0.4, enough: 24,
                                                      accept: { !FileTaste.noise($0) }))
                    spot.append(Date().timeIntervalSince(t0) * 1000)
                }
                print("query phase only:", spot.map { String(Int($0)) }.joined(separator: " "))
                let rows = await f.spot.run(SpotlightAsk(predicate: SpotlightPredicates.predicate(SpotlightPredicates.names("report")), limit: 60, deadline: 0.4,
                                                         accept: { !FileTaste.noise($0) }))
                for ow in [false, true] {
                    let t1 = Date()
                    _ = mapFileRows(rows, query: "report", home: NSHomeDirectory(), now: Date().timeIntervalSince1970 * 1000, limit: 8, openWith: ow)
                    print("map \(rows.count) rows, openWith \(ow): \(Int(Date().timeIntervalSince(t1) * 1000)) ms")
                }
                f.cool()
                return ms
            } ?? []
            var spawn: [Double] = []
            for w in words {
                let t0 = Date()
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/usr/bin/mdfind")
                p.arguments = ["-onlyin", NSHomeDirectory(), FileTaste.mdQuery(w)]
                p.standardOutput = FileHandle.nullDevice
                p.standardError = FileHandle.nullDevice
                try? p.run()
                p.waitUntilExit()
                spawn.append(Date().timeIntervalSince(t0) * 1000)
            }
            func stats(_ a: [Double]) -> String {
                let s = a.sorted()
                return s.isEmpty ? "-" : "median \(Int(s[s.count / 2])) ms, p90 \(Int(s[min(s.count - 1, Int(Double(s.count) * 0.9))])) ms, max \(Int(s.last!)) ms"
            }
            print("per word ms:", zip(words.indices, native).map { "\($0.0):\(Int($0.1))" }.joined(separator: " "))
            print("measure files: NSMetadataQuery \(stats(native)) (n=\(native.count)); mdfind full run \(stats(spawn)) (n=\(spawn.count))")
        }
    }
}
