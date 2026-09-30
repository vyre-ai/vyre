// ModuleProviders, ported from lib/providers.test.js, plus the gallery gaps: names not ids, and a
// fill that nothing took is not reported as done.
import Foundation

private let VAULT = """
{"results:vault.search":{"title":"Vault"},"action:vault.fill.native":{"title":"Fill in the front app"},"action:vault.copy":{"title":"Copy the password or key"},\
"action:vault.copy#username":{"title":"Copy username","input":{"field":"username"}},"action:vault.copy#totp":{"title":"Copy one-time code","input":{"field":"totp"}},\
"action:vault.totp":{"title":"Show the one-time code"},"action:vault.lock":{"title":"Lock the vault"}}
"""

/// A fake client: `modules` is the listing's JSON, `callable` what GET /v1/tools says (nil: it errs).
private func fake(modules: String, callable: [String]? = nil, tools: [String: @Sendable ([String: Any]) async -> VyredResult] = [:]) -> FakeLink {
    let l = FakeLink { tool, input in
        if let f = tools[tool] { return await f(input) }
        return .failure(code: "no_such_tool", message: "no tool \(tool)")
    }
    l.raw["/v1/modules"] = modules
    l.getAnswer = { route in
        if route == "/v1/tools", let callable { return .success(callable.map { ["name": $0] }) }
        return .failure(code: "not_found", message: "no")
    }
    return l
}

private func sleepMs(_ ms: UInt64) async { try? await Task.sleep(nanoseconds: ms * 1_000_000) }

// capsule-suite: moduleProvidersSuite
let moduleProvidersSuite = Suite("module providers") { t in
    t.test("an ordered object keeps its order, titles, # suffixes and inputs") {
        let s = ModuleProviders.parseShows("vault", OJ.parse(Data(VAULT.utf8)))
        t.eq(s.results.map { "\($0.tool)|\($0.title)" }, ["vault.search|Vault"])
        t.eq(s.actions.map { "\($0.key)|\($0.tool)|\($0.title)" }, [
            "action:vault.fill.native|vault.fill.native|Fill in the front app", "action:vault.copy|vault.copy|Copy the password or key",
            "action:vault.copy#username|vault.copy|Copy username", "action:vault.copy#totp|vault.copy|Copy one-time code",
            "action:vault.totp|vault.totp|Show the one-time code", "action:vault.lock|vault.lock|Lock the vault"])
        t.eq(s.actions[2].input["field"] as? String, "username")
    }

    t.test("an array of plain strings works with made-up titles, and odd keys are skipped") {
        let s = ModuleProviders.parseShows("notes", OJ.parse(Data(#"["results:notes.find","action:notes.open","panel:notes",7,"action:notes.open"]"#.utf8)))
        t.eq(s.results.map { "\($0.tool)|\($0.title)" }, ["notes.find|Notes"])
        t.eq(s.actions.map { "\($0.key)|\($0.title)" }, ["action:notes.open|notes.open"])
        let none = ModuleProviders.parseShows("x", nil)
        t.eq(none.results.count + none.actions.count, 0)
    }

    t.test("refresh keeps running modules and only what this caller may call") {
        let l = fake(modules: """
        [{"name":"vault","state":"running","shows":{"capsule":\(VAULT)}},{"name":"notes","state":"running","manifest":{"shows":{"capsule":["results:notes.find","action:notes.open"]}}},\
        {"name":"broken","state":"failed","shows":{"capsule":["results:broken.find"]}},{"name":"quiet","state":"running","shows":{"deck":["panel:quiet"]}}]
        """, callable: ["vault.search", "vault.copy", "vault.totp", "notes.find", "notes.open"])
        let p = ModuleProviders(link: l)
        let n = t.wait { await p.refresh() }
        t.eq(try? n?.get(), 2)
        let list = p.list()
        t.eq(list.map(\.module), ["vault", "notes"])
        t.eq(list[0].actions.map(\.key), ["action:vault.copy", "action:vault.copy#username", "action:vault.copy#totp", "action:vault.totp"],
             "fill.native and lock are not on the caller's list, so they are dropped; order is kept")
        t.eq(l.calls.count, 0, "refresh calls no tool")
        t.eq(p.sendsQuery, "vault, notes", "the Capsule can say where the words go")
    }

    t.test("without a tools listing nothing is filtered; a failed listing keeps the old state") {
        let l = fake(modules: #"[{"name":"vault","state":"running","shows":{"capsule":\#(VAULT)}}]"#)
        let p = ModuleProviders(link: l)
        _ = t.wait { await p.refresh() }
        t.eq(p.list().first?.actions.count, 6)
        l.raw = [:]
        l.getAnswer = { _ in .failure(code: "unreachable", message: "vyred is not running") }
        let r = t.wait { await p.refresh() }
        if case .failure(let e)?? = r { t.eq(e.message, "vyred is not running") } else { t.ok(false) }
        t.eq(p.list().count, 1)
    }

    t.test("search asks every provider in parallel and makes launcher rows") {
        // Overlap is counted, not timed: a slow CI machine stretches the clock, not the overlap.
        let overlap = Overlap()
        let l = fake(modules: #"[{"name":"vault","state":"running","shows":{"capsule":\#(VAULT)}},{"name":"notes","state":"running","shows":{"capsule":{"results:notes.find":{"title":"Notes","input":{"scope":"all"}}}}}]"#,
                     tools: ["vault.search": { _ in overlap.enter(); await sleepMs(150); overlap.leave(); return .success(["rows": [["id": "GitHub", "name": "GitHub", "kind": "login", "sub": "login · github.com"],
                                                                                                ["id": "Work mail", "name": "Work mail", "kind": "login", "sub": "login · mail.example.com"]]]) },
                             "notes.find": { _ in overlap.enter(); await sleepMs(150); overlap.leave(); return .success([["id": 3, "name": "Git tips", "kind": "note"]]) }])
        let p = ModuleProviders(link: l)
        _ = t.wait { await p.refresh() }
        let rows = t.wait { await p.search("git", limit: 5) } ?? []
        t.eq(overlap.most, 2, "the two providers ran at once")
        t.eq(rows.first, ModuleRow(id: "vault:GitHub", label: "GitHub", sub: "login · github.com", module: "vault", provider: "Vault", rowId: "GitHub", rowKind: "login", score: 1.0))
        t.near(rows.first?.score, 0.9 + 0.1, 1e-9)
        t.eq(rows.count > 1 ? rows[1].score : nil, 0.5, "matched by the provider on something else: the floor")
        t.eq(rows.count > 2 ? rows[2] : nil, ModuleRow(id: "notes:3", label: "Git tips", sub: "Notes", module: "notes", provider: "Notes", rowId: "3", rowKind: "note", score: 0.9))
        let notes = l.calls.first { $0.tool == "notes.find" }?.input
        t.eq(notes?["scope"] as? String, "all"); t.eq(notes?["q"] as? String, "git"); t.eq(notes?["limit"] as? Int, 5)
    }

    t.test("short queries go nowhere") {
        let l = fake(modules: #"[{"name":"vault","state":"running","shows":{"capsule":\#(VAULT)}}]"#)
        let p = ModuleProviders(link: l)
        _ = t.wait { await p.refresh() }
        t.eq(t.wait { await p.search("g") }?.count, 0)
        t.eq(t.wait { await p.search("  ") }?.count, 0)
        t.eq(l.calls.count, 0)
    }

    t.test("a slow or failing provider hides no one else, and each has its own timeout") {
        let l = fake(modules: #"[{"name":"slow","state":"running","shows":{"capsule":["results:slow.find"]}},{"name":"bad","state":"running","shows":{"capsule":["results:bad.find"]}},{"name":"good","state":"running","shows":{"capsule":["results:good.find"]}}]"#,
                     tools: ["slow.find": { _ in await sleepMs(400); return .success(["rows": [["id": "s", "name": "slow one"]]]) },
                             "bad.find": { _ in .failure(code: "locked", message: "The vault is locked.") },
                             "good.find": { _ in .success(["rows": [["id": "g", "name": "good one"], ["name": "no id"], NSNull()]]) }])
        let p = ModuleProviders(link: l)
        _ = t.wait { await p.refresh() }
        let t0 = Date()
        let rows = t.wait { await p.search("one", timeout: 0.08) } ?? []
        t.ok(Date().timeIntervalSince(t0) < 0.3, "the slow provider was cut off at its own timeout")
        t.eq(rows.map(\.id), ["good:g"])
        t.ok(l.calls.allSatisfy { $0.timeout == 0.08 }, "each call carries the timeout too")
    }

    t.test("actions for a result come from its module, in order, and hide says step aside") {
        let l = fake(modules: #"[{"name":"vault","state":"running","shows":{"capsule":{"results:vault.search":{"title":"Vault"},"action:vault.fill.native":{"title":"Fill in the front app","hide":true},"action:vault.copy":{"title":"Copy"}}}}]"#)
        let p = ModuleProviders(link: l)
        _ = t.wait { await p.refresh() }
        let acts = p.actions(module: "vault")
        t.eq(acts.map { "\($0.title)|\($0.hide)" }, ["Fill in the front app|true", "Copy|false"])
        t.eq(p.actions(module: "nope").count, 0)
        let item = p.item(for: ModuleRow(id: "vault:p1", label: "GitHub", sub: "login · github.com", module: "vault", provider: "Vault", rowId: "p1", rowKind: "login", score: 1), actions: acts)
        t.eq(item.actions.map(\.needsFrontApp), [true, false], "a hide action is needsFrontApp")
        t.eq(item.title, "GitHub"); t.eq(item.sendsTo, "vault"); t.eq(item.section, .modules)
        t.eq(item.copyText, nil, "never the id on the clipboard")
    }

    t.test("run passes { ...input, id, front } and hands said back as is") {
        let l = fake(modules: #"[{"name":"vault","state":"running","shows":{"capsule":\#(VAULT)}}]"#,
                     tools: ["vault.copy": { i in .success(["copied": true, "said": "Copied the \((i["field"] as? String) ?? "value") of \((i["id"] as? String) ?? "") · clears in 90 s"]) },
                             "vault.totp": { _ in .success(["code": "123456", "period": 30, "remaining": 12]) }])
        let p = ModuleProviders(link: l)
        _ = t.wait { await p.refresh() }
        let front = FrontApp(bundle: "com.example.browser", pid: 42, name: "Example")
        let r = t.wait { await p.run(module: "vault", rowId: "GitHub", key: "action:vault.copy#username", front: front) }
        let first = l.calls[0].input
        t.eq(first["field"] as? String, "username"); t.eq(first["id"] as? String, "GitHub")
        t.eq((first["front"] as? [String: Any])?["bundle"] as? String, "com.example.browser"); t.eq((first["front"] as? [String: Any])?["pid"] as? Int, 42)
        t.ok(l.calls[0].timeout >= 30, "an action may wait on Touch ID")
        if case .done(let said, _, _, _, _)?? = r { t.eq(said, "Copied the username of GitHub · clears in 90 s") } else { t.ok(false) }
        let code = t.wait { await p.run(module: "vault", rowId: "GitHub", key: "action:vault.totp", front: nil) }
        t.ok(l.calls[1].input["front"] == nil, "no front app, no front key")
        if case .done(_, let c, let period, let remaining, _)?? = code { t.eq(c, "123456"); t.eq(period, 30); t.eq(remaining, 12) } else { t.ok(false) }
    }

    t.test("run passes an error through as is, and a slow action times out") {
        let l = fake(modules: #"[{"name":"vault","state":"running","shows":{"capsule":\#(VAULT)}}]"#,
                     tools: ["vault.copy": { _ in .failure(code: "presence_refused", message: "Touch ID was cancelled.") },
                             "vault.totp": { _ in await sleepMs(500); return .success(["code": "1"]) }])
        let p = ModuleProviders(link: l)
        _ = t.wait { await p.refresh() }
        func words(_ r: ModuleRun??) -> String { if case .error(let m, let reason)?? = r { return "\(m)|\(reason ?? "-")" }; return "ok" }
        t.eq(words(t.wait { await p.run(module: "vault", rowId: "GitHub", key: "action:vault.copy", front: nil) }), "Touch ID was cancelled.|presence_refused")
        t.eq(words(t.wait { await p.run(module: "vault", rowId: "GitHub", key: "action:vault.lock", front: nil) }), "no tool vault.lock|no_such_tool")
        t.eq(words(t.wait { await p.run(module: "vault", rowId: "GitHub", key: "action:vault.gone", front: nil) }), "That action is no longer offered.|-")
        t.eq(words(t.wait { await p.run(module: "vault", rowId: "GitHub", key: "action:vault.totp", front: nil, timeout: 0.02) }), "No answer in time. Try again.|timeout")
    }

    t.test("the site bump is the vault's alone") {
        t.eq(ModuleProviders.scoreRow("vault", "github", name: "Work", sub: "login · github.com"), 0.6)
        t.eq(ModuleProviders.scoreRow("notes", "github", name: "Work", sub: "note · github.com"), 0.5)
        t.eq(ModuleProviders.scoreRow("vault", "github", name: "Work", sub: "login"), 0.5)
    }

    t.test("what an action says uses the row's name, never its id") {
        let l = fake(modules: #"[{"name":"vault","state":"running","shows":{"capsule":\#(VAULT)}}]"#,
                     tools: ["vault.copy": { i in .success(["said": "Copied the password of \((i["id"] as? String) ?? "")"]) },
                             "vault.totp": { _ in .success(["code": "123456", "remaining": 12, "said": "Code for p1"]) }])
        let p = ModuleProviders(link: l)
        _ = t.wait { await p.refresh() }
        let item = p.item(for: ModuleRow(id: "vault:p1", label: "Northwind Bakery admin", sub: "login · northwind.example", module: "vault", provider: "Vault", rowId: "p1", rowKind: "login", score: 1),
                          actions: p.actions(module: "vault"))
        let ctx = ActionContext(query: Query("north"))
        let copy = item.actions.first { $0.id == "action:vault.copy" }!
        let totp = item.actions.first { $0.id == "action:vault.totp" }!
        t.eq(t.wait { await copy.run(item, ctx) }, .said("Copied the password of Northwind Bakery admin"))
        t.eq(t.wait { await totp.run(item, ctx) }, .said("Code for Northwind Bakery admin: 123456, 12 s left"))
    }

    t.test("a fill that no app took is failed, with the reason, and never reported as done") {
        let l = fake(modules: #"[{"name":"vault","state":"running","shows":{"capsule":{"results:vault.search":{},"action:vault.fill.native":{"title":"Fill","hide":true}}}}]"#,
                     tools: ["vault.fill.native": { i in
                         let front = i["front"] as? [String: Any]
                         if (front?["pid"] as? Int) == 7 { return .success(["filled": false, "said": "Filled p1 in no app"]) }
                         return .success(["filled": true, "said": "Filled p1 in Example"]) }])
        let p = ModuleProviders(link: l)
        _ = t.wait { await p.refresh() }
        let item = p.item(for: ModuleRow(id: "vault:p1", label: "GitHub", sub: "login · github.com", module: "vault", provider: "Vault", rowId: "p1", rowKind: "login", score: 1),
                          actions: p.actions(module: "vault"))
        let fill = item.actions[0]
        let app = FrontApp(bundle: "com.example.browser", pid: 42, name: "Example")
        guard case .failed(let none)? = t.wait({ await fill.run(item, ActionContext(query: Query("git"), frontIsBack: false)) }) else { t.ok(false, "no front app is not done"); return }
        t.ok(none.contains("No app was in front"), none)
        t.eq(l.calls.count, 0, "nothing sent when there is nothing to fill")
        guard case .failed(let gone)? = t.wait({ await fill.run(item, ActionContext(query: Query("git", front: app), frontIsBack: false)) }) else { t.ok(false); return }
        t.ok(gone.contains("Example did not come back"), gone)
        let wrong = FrontApp(bundle: "com.example.other", pid: 7, name: "Other")
        guard case .failed(let nothing)? = t.wait({ await fill.run(item, ActionContext(query: Query("git", front: wrong), frontIsBack: true)) }) else { t.ok(false, "the module said nothing was filled"); return }
        t.ok(!nothing.contains("p1") && nothing.contains("Nothing was filled"), nothing)
        t.eq(t.wait { await fill.run(item, ActionContext(query: Query("git", front: app), frontIsBack: true)) }, .close("Filled GitHub in Example"))
    }

    t.test("mail rows: an account to write from holds the send and says so, a message says what it is") {
        let l = fake(modules: #"[{"name":"mail","state":"running","shows":{"capsule":{"results:mail.find":{"title":"Mail"},"action:mail.compose":{"title":"Write it"}}}}]"#,
                     tools: ["mail.compose": { i in
                         if (i["id"] as? String) == "m1" { return .success(["kind": "email", "message": ["subject": "The order", "from": "Dana <dana@northwind-bakery.example>"]]) }
                         return .success(["kind": "held", "held": "h1", "message": "Held at the Gate: long words"]) }])
        let p = ModuleProviders(link: l)
        _ = t.wait { await p.refresh() }
        let send = ModuleRow(id: "mail:c1", label: "Send from alex@harlow.example", sub: "IMAP · alex@harlow.example · to dana@northwind-bakery.example", module: "mail", provider: "Mail", rowId: "c1", rowKind: "compose", score: 1)
        let msg = ModuleRow(id: "mail:m1", label: "The order", sub: "Dana", module: "mail", provider: "Mail", rowId: "m1", rowKind: "email", score: 1)
        let a = p.item(for: send, actions: p.actions(module: "mail")), b = p.item(for: msg, actions: p.actions(module: "mail"))
        t.eq(a.subtitle, "IMAP · alex@harlow.example · to dana@northwind-bakery.example", "the sub is the module's, as written")
        t.eq(ModuleProviders.symbol(send), "square.and.pencil")
        t.eq(ModuleProviders.symbol(msg), "envelope")
        let ctx = ActionContext(query: Query("email dana"))
        t.eq(t.wait { await a.actions[0].run(a, ctx) }, .said("Waiting for you: Send from alex@harlow.example. Nothing is sent until you send it from Needs you."))
        t.eq(t.wait { await b.actions[0].run(b, ctx) }, .said("The order · Dana <dana@northwind-bakery.example>"))
    }

    t.test("warm refreshes on open at most twice a minute") {
        var clock = Date(timeIntervalSince1970: 1000)
        let l = fake(modules: "[]")
        let p = ModuleProviders(link: l, now: { clock })
        var gets = 0
        l.getAnswer = { _ in gets += 1; return .failure(code: "x", message: "x") }
        p.warm()
        _ = t.wait { await sleepMs(50) }
        p.warm(); p.warm()
        _ = t.wait { await sleepMs(50) }
        t.eq(gets, 1, "three opens in a row read the listing once")
        clock = clock.addingTimeInterval(31)
        p.warm()
        _ = t.wait { await sleepMs(50) }
        t.eq(gets, 2)
    }
}

/// How many calls were in flight at once, at most.
final class Overlap: @unchecked Sendable {
    private let lock = NSLock()
    private var now = 0
    private(set) var most = 0
    func enter() { lock.lock(); now += 1; most = max(most, now); lock.unlock() }
    func leave() { lock.lock(); now -= 1; lock.unlock() }
}
