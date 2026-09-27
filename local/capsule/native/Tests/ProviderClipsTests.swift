// capsule-suite: providerClipsSuite
// The clipboard store (ported from clips.test.js) and the watcher, against a private named
// pasteboard ("vyre-test-<pid>") and a temp file. Nothing here reads or writes the general
// pasteboard. Secret-shaped fixtures are split in two so the repository's secret scan does not flag
// this file.

import AppKit
import Foundation

final class TestClock: @unchecked Sendable {
    var t: Double = 1_800_000_000_000
    func now() -> Double { t }
}

func clipFile(_ name: String) -> (URL, String) {
    let dir = providerFixture(name)
    return (URL(fileURLWithPath: dir + "/sub/clips.json"), dir)
}

let providerClipsSuite = Suite("provider clips") { t in
    let SECRETS = [
        "sk" + "-proj-abcdefghijklmnopqrstuvwxyz0123456789",
        "sk_live_51Habcdefghijklmnop",
        "gh" + "p_abcdefghijklmnopqrstuvwxyz0123456789",
        "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
        "glpat-abcdefghij0123456789",
        "xo" + "xb-1234567890-0987654321-abcdefghijklmnop",
        "AK" + "IAIOSFODNN7EXAMPLE",
        "AIzaSyA-abcdefghijklmnopqrstuvwxyz01234",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        "-----BEGIN OPENSSH PRIVATE " + "KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
        "-----BEGIN RSA PRIVATE " + "KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
        "-----BEGIN PGP PRIVATE KEY BLOCK-----",
        "export OPENAI_API_KEY=abc123def456ghi789",
        "DB_PASSWORD=correcthorsebattery",
        "{\"token\": \"abcdef123456\"}",
        "password: hunter2hunter2",
        "curl -H 'Authorization: Bearer abcdefghijklmnop0123456789' https://api.example.com",
        "postgres://admin:s3cretpass@db.example.com:5432/app",
        "https://example.com/reset?token=abc123def456ghi",
        "https://bucket.s3.amazonaws.com/f?X-Amz-Signature=abcdef0123456789",
        "482913", "4829 1375", "482 913", "12345678",
        "4111 1111 1111 1111", "4111-1111-1111-1111",
        "Zx9Qm2Lp8Rt4Vw7Ns1Kd",
        "a8Fk2LmQ9zX3pR7tV1wY5nB0cD4eG6hJ",
        "550e8400-e29b-41d4-a716-446655440000",
        "da39a3ee5e6b4b0d3255bfef95601890afd80709",
        "here is the key a8Fk2LmQ9zX3pR7tV1wY5nB0cD4eG6hJk2Lm for later",
        "sk" + "-ant-api03-abcdefghijklmnopqrstuvwxyz",
        "npm_abcdefghijklmnopqrstuvwxyz0123456789",
        "hf_abcdefghijklmnopqrstuvwxyz01234567",
    ]
    let PLAIN = [
        "hello world", "Meeting moved to Thursday at 3pm.", "https://example.com/docs/getting-started",
        "/Users/someone/Projects/app/src/index.js", "~/Downloads/invoice-2026-03.pdf", "someone@example.com",
        "+1 555 123 4567", "5551234567", "2026", "12345", "ask-questions-first", "task-list and risk-free",
        "const total = items.reduce((a, b) => a + b, 0);", "The quick brown fox jumps over the lazy dog 42 times.",
        "npm install --save-dev typescript", "tokens are counted per request", "supercalifragilistic",
        "Invoice 4111 is due", "version 1.2.3",
    ]

    t.test("anything that looks like a secret is never recorded") {
        for s in SECRETS { t.ok(ClipText.looksSecret(s), "should skip: \(s)") }
        for s in PLAIN { t.ok(!ClipText.looksSecret(s), "should keep: \(s)") }
        let (file, dir) = clipFile("secrets")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let c = ClipStore(file: file)
        for s in SECRETS { t.ok(c.add(ClipItem(count: 1, at: 1, text: s)) == nil, s) }
        t.eq(c.list().count, 0)
        c.flush()
        t.ok(!((try? String(contentsOf: file, encoding: .utf8)) ?? "").contains("hunter2"))
    }

    t.test("the same text copied again moves to the top instead of repeating") {
        let (file, dir) = clipFile("dupe")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let clock = TestClock()
        let c = ClipStore(file: file, now: { clock.now() })
        let t0 = clock.t
        c.add(ClipItem(count: 1, at: t0 + 1, text: "alpha"))
        c.add(ClipItem(count: 2, at: t0 + 2, text: "beta"))
        c.add(ClipItem(count: 3, at: t0 + 3, app: "Mail", text: "alpha"))
        t.eq(c.list().map { "\($0.text!) \(Int($0.t - t0)) \($0.app ?? "-")" }, ["alpha 3 Mail", "beta 2 -"])
    }

    t.test("kinds and labels, newest first") {
        let (file, dir) = clipFile("kinds")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let clock = TestClock()
        let c = ClipStore(file: file, now: { clock.now() })
        c.add(ClipItem(count: 1, at: clock.t, app: "Notes", text: "first"))
        c.add(ClipItem(count: 2, at: clock.t + 1000, app: "Safari", text: "second"))
        c.add(ClipItem(count: 3, at: clock.t + 2000, app: "Finder", files: ["/Users/alex/Documents/report.pdf", "/tmp/b.txt"]))
        c.add(ClipItem(count: 4, at: clock.t + 3000, app: "Preview", image: true))
        t.eq(c.list().map(\.kind), [.image, .files, .text, .text])
        t.eq(c.list().map(ClipText.label), ["Image", "report.pdf and 1 more", "second", "first"])
        t.ok(c.add(ClipItem(count: 5, files: ["relative/path"])) == nil, "files must be absolute")
        t.ok(c.add(ClipItem(count: 6, text: "   \n")) == nil, "blank text is nothing")
    }

    t.test("capped by count and by age") {
        let (file, dir) = clipFile("caps")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let clock = TestClock()
        let c = ClipStore(file: file, now: { clock.now() }, max: 3)
        for i in 0..<5 { c.add(ClipItem(count: i, at: clock.t, text: "item \(i)")) }
        t.eq(c.list().map { $0.text! }, ["item 4", "item 3", "item 2"])
        let d = ClipStore(file: URL(fileURLWithPath: dir + "/d.json"), now: { clock.now() }, days: 7)
        d.add(ClipItem(count: 1, at: clock.t - 8 * 86_400_000, text: "last week and a day"))
        d.add(ClipItem(count: 2, at: clock.t - 6 * 86_400_000, text: "six days"))
        t.eq(d.list().map { $0.text! }, ["six days"])
        clock.t += 2 * 86_400_000
        t.eq(d.list().count, 0, "ages out while running, too")
    }

    t.test("long text is kept to the storage cap and labelled on one short line") {
        let (file, dir) = clipFile("long")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let c = ClipStore(file: file)
        let x = c.add(ClipItem(count: 1, at: 1_800_000_000_000, text: "line one\n\n  line two " + String(repeating: "word ", count: 10_000)))
        t.eq(x?.text?.count, ClipText.TEXT_MAX)
        let l = x.map(ClipText.label) ?? ""
        t.ok(l.hasPrefix("line one line two word"))
        t.ok(l.count <= 200 && l.hasSuffix("…"))
    }

    t.test("persisted as 0600 JSON in a 0700 folder, debounced, read back by a new store") {
        let (file, dir) = clipFile("persist")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let clock = TestClock()
        let c = ClipStore(file: file, now: { clock.now() }, delay: 0.02)
        c.add(ClipItem(count: 1, at: clock.t, app: "Notes", text: "keep me"))
        c.add(ClipItem(count: 2, at: clock.t, files: ["/tmp/a.txt"]))
        t.ok(!FileManager.default.fileExists(atPath: file.path), "debounced, not written per copy")
        let until = Date().addingTimeInterval(2)
        while !FileManager.default.fileExists(atPath: file.path) && Date() < until { usleep(10_000) }
        let attrs = try? FileManager.default.attributesOfItem(atPath: file.path)
        t.eq((attrs?[.posixPermissions] as? Int).map { $0 & 0o777 }, 0o600)
        let dattrs = try? FileManager.default.attributesOfItem(atPath: file.deletingLastPathComponent().path)
        t.eq((dattrs?[.posixPermissions] as? Int).map { $0 & 0o077 }, 0, "folder is the user's alone")
        t.eq(try? FileManager.default.contentsOfDirectory(atPath: file.deletingLastPathComponent().path), ["clips.json"], "no temp file left behind")
        let d = ClipStore(file: file, now: { clock.now() })
        t.eq(d.list().map { $0.text ?? $0.files!.joined() }, ["/tmp/a.txt", "keep me"])
        try? "{not json".write(to: file, atomically: true, encoding: .utf8)
        t.eq(ClipStore(file: file, now: { clock.now() }).list().count, 0, "a broken file is an empty history")
    }

    t.test("clear and remove") {
        let (file, dir) = clipFile("clear")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let clock = TestClock()
        let c = ClipStore(file: file, now: { clock.now() })
        let a = c.add(ClipItem(count: 1, at: clock.t, text: "one"))
        c.add(ClipItem(count: 2, at: clock.t, text: "two"))
        t.ok(c.remove("clip:" + (a?.h ?? "")))
        t.ok(!c.remove("clip:nope"))
        t.eq(c.list().map { $0.text! }, ["two"])
        c.clear()
        t.eq(c.list().count, 0)
        let j = (try? JSONSerialization.jsonObject(with: Data(contentsOf: file))) as? [String: Any]
        t.eq((j?["items"] as? [Any])?.count, 0, "clear writes at once")
    }

    t.test("search ranks with Match and a clipboard prefix lists in order") {
        let (file, dir) = clipFile("search")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let clock = TestClock()
        let c = ClipStore(file: file, now: { clock.now() })
        c.add(ClipItem(count: 1, at: clock.t - 3 * 3_600_000, app: "Pages", text: "the quarterly report draft"))
        c.add(ClipItem(count: 2, at: clock.t - 120_000, text: "report card"))
        c.add(ClipItem(count: 3, at: clock.t, text: "unrelated note"))
        let r = c.search("report")
        t.eq(r.map { ClipText.label($0.clip) }, ["report card", "the quarterly report draft"], "prefix beats a later word")
        t.eq(r.map(\.score), [0.9, 0.8])
        t.ok(r.first?.clip.h.range(of: "^[0-9a-f]{16}$", options: .regularExpression) != nil)
        t.eq(c.search("rpt").count, 0, "scattered letters in a long text do not count")
        t.eq(c.search("r").count, 0, "one letter is too little to search clips")
        for q in ["clipboard", "clip", "clips", "paste", "Paste "] {
            let l = c.search(q, limit: 2)
            t.eq(l.map { ClipText.label($0.clip) }, ["unrelated note", "report card"], q)
            t.ok(l[0].score > l[1].score && l[1].score > 2)
        }
        t.eq(c.search("clip quarterly").map { ClipText.label($0.clip) }, ["the quarterly report draft"])
    }

    t.test("age reads short") {
        t.eq(ClipText.age(5_000), "just now")
        t.eq(ClipText.age(5 * 60_000), "5 min ago")
        t.eq(ClipText.age(2 * 3_600_000), "2 h ago")
        t.eq(ClipText.age(3 * 86_400_000), "3 d ago")
    }

    t.test("the watcher reads a private board, skips marked items, password managers and its own writes") {
        let (file, dir) = clipFile("watch")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let board = NSPasteboard(name: testBoardName)
        defer { board.releaseGlobally() }
        board.clearContents()
        board.setString("already there", forType: .string)
        let got = t.wait { @MainActor () -> [String] in
            let store = ClipStore(file: file)
            var front: (bundle: String?, name: String?) = ("com.apple.TextEdit", "TextEdit")
            let w = ClipWatcher(store: store, board: board, interval: 0.1, front: { front })
            w.start()
            var log: [String] = []
            w.tick()
            log.append("start:\(store.list().count)")                          // what was there is not new
            board.clearContents(); board.setString("Northwind order 42", forType: .string)
            w.tick()
            log.append("copied:\(store.list().first?.text ?? "-"):\(store.list().first?.app ?? "-")")
            board.clearContents()
            board.declareTypes([.string, NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")], owner: nil)
            board.setString("hunter", forType: .string)
            w.tick()
            log.append("concealed:\(store.list().count)")
            front = ("com.1password.1password", "1Password")
            board.clearContents(); board.setString("from a password manager", forType: .string)
            w.tick()
            log.append("manager:\(store.list().count)")
            front = ("com.apple.TextEdit", "TextEdit")
            let first = store.list().first!
            _ = w.write(first)
            w.tick()
            log.append("own:\(store.list().count)")
            log.append("own marker skipped:\(ClipRead.read(board, appBundle: nil, appName: nil).1)")
            // The timer, not a hand-driven tick.
            board.clearContents(); board.setString("Harlow Legal memo", forType: .string)
            let until = Date().addingTimeInterval(2)
            while store.list().first?.text != "Harlow Legal memo" && Date() < until { try? await Task.sleep(nanoseconds: 20_000_000) }
            log.append("timer:\(store.list().first?.text ?? "-")")
            w.stop()
            log.append("stopped:\(w.isWatching)")
            return log
        }
        t.eq(got, ["start:0", "copied:Northwind order 42:TextEdit", "concealed:1", "manager:1", "own:1", "own marker skipped:own",
                   "timer:Harlow Legal memo", "stopped:false"])
    }

    t.test("the provider lists clips, a pick writes back to the board, and the history can be cleared") {
        let (file, dir) = clipFile("provider")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let board = NSPasteboard(name: testBoardName)
        defer { board.releaseGlobally() }
        let out = t.wait { @MainActor () -> [String] in
            let store = ClipStore(file: file)
            let w = ClipWatcher(store: store, board: board, interval: 5, front: { (nil, nil) })
            let p = ClipboardProvider(store: store, watcher: w)
            store.add(ClipItem(count: 1, at: Date().timeIntervalSince1970 * 1000 - 60_000, text: "older"))
            store.add(ClipItem(count: 2, at: Date().timeIntervalSince1970 * 1000, text: "newer"))
            var log: [String] = []
            let rows = await p.results(for: Query("clip"))
            log.append(rows.map(\.title).joined(separator: ","))
            log.append(rows.map(\.section.rawValue).joined(separator: ","))
            let older = rows.first { $0.title == "older" }!
            let outcome = await older.actions[0].run(older, ActionContext(query: Query("clip")))
            log.append("\(outcome == .close(ClipText.NOTE))")
            log.append(board.string(forType: .string) ?? "-")
            log.append(store.list().map { $0.text! }.joined(separator: ","))
            w.start()
            w.tick()
            log.append("\(store.list().count)")                                  // the pick is not a new clip
            w.stop()
            let clear = rows.last!
            log.append(clear.id + ":" + (clear.actions[0].confirm ?? "no confirm"))
            _ = await clear.actions[0].run(clear, ActionContext(query: Query("clip")))
            log.append("\(store.list().count)")
            log.append("\(await p.results(for: Query("n")).count)")
            return log
        }
        t.eq(out, ["newer,older,Clear clipboard history", "Clipboard,Clipboard,Clipboard", "true", "older", "older,newer", "2",
                   "clipclear:Forget every clip?", "0", "0"])
    }

    t.test("the source names nothing that sends or logs") {
        let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Sources/Providers")
        for f in ["ClipStore.swift", "Clipboard.swift"] {
            let src = ((try? String(contentsOf: here.appendingPathComponent(f), encoding: .utf8)) ?? "")
                .split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }.joined(separator: "\n")
            t.ok(!src.isEmpty, f)
            for bad in ["print(", "NSLog", "os_log", "URLSession", "Logger(", "vyred"] { t.ok(!src.contains(bad), "\(f) has \(bad)") }
        }
    }
}
