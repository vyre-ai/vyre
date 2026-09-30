// capsule-suite: viewSessionSuite
// A module command in the Capsule against a scripted vyred: the list as results, the cache, slow calls,
// details, forms, previews and the second Return, effects, and Esc one level at a time. No real link
// is opened and nothing is sent anywhere.

import AppKit
import Foundation

private final class ScriptLink: VyredLink, @unchecked Sendable {
    private let lock = NSLock()
    private var log: [(String, [String: Any])] = []
    var tools: Set<String> = ["capsule.commands", "capsule.view", "capsule.act"]
    /// Answers by tool, called with the input.
    var answer: [String: ([String: Any]) -> VyredResult] = [:]
    var isUp: Bool { true }
    func has(_ tool: String) -> Bool { tools.contains(tool) }
    func call(_ tool: String, _ input: [String: Any], presence: Bool) async -> VyredResult {
        lock.withLock { log.append((tool, input)) }
        return answer[tool]?(input) ?? .failure(code: "no_such_tool", message: "no such tool: \(tool)")
    }
    func calls(_ tool: String) -> [[String: Any]] { lock.withLock { log.filter { $0.0 == tool }.map(\.1) } }
    func on(_ pattern: String, _ handler: @escaping @MainActor (VyredEvent) -> Void) -> VyredSubscription { Sub() }
    func stream(_ path: String, onMessage: @escaping @Sendable ([String: Any]) -> Void, onClose: @escaping @Sendable () -> Void) async -> Result<VyredStream, VyredStreamFailure> {
        .failure(VyredStreamFailure(code: "refused", message: "no stream in this test"))
    }
    final class Sub: VyredSubscription { func cancel() {} }
}

private let MAIL = ViewCommand(module: "google", id: "mail", title: "Search mail", keywords: ["gmail"], alias: "mail", icon: "envelope", root: true,
                               argName: "q", argPlaceholder: "from, subject or words", firstParty: true, hash: "h1")

private func list(_ ids: [String], actions: [[String: Any]] = [["id": "open", "title": "Open in Gmail"]], from: String? = nil) -> [String: Any] {
    var o: [String: Any] = ["v": 1, "kind": "list", "title": "Mail",
                            "rows": ids.map { ["id": $0, "title": "Thread \($0)", "subtitle": "alex", "accessory": "Tue", "actions": actions] as [String: Any] }]
    if let from { o["from"] = from }
    return o
}

@MainActor private func session(_ link: ScriptLink, _ cmd: ViewCommand = MAIL) -> (ViewSession, ManualClock) {
    let clock = ManualClock()
    let s = ViewSession(command: cmd, vyred: link, clock: clock)
    return (s, clock)
}

/// Wait, from async main-actor code, until cond holds (up to 3 s). The loop is free for other work meanwhile.
@MainActor private func poll(_ cond: @MainActor () -> Bool) async -> Bool {
    for _ in 0..<300 { if cond() { return true }; try? await Task.sleep(nanoseconds: 10_000_000) }
    return cond()
}

/// Spin the main loop until cond holds (up to 3 s), from sync code on the main thread.
private func spin(_ cond: () -> Bool) -> Bool { MainActor.assumeIsolated { until(3, cond) } }

let viewSessionSuite = Suite("view session") { t in
    t.test("the first list is asked for at once, later words wait until they settle, and an older answer is dropped") {
        MainActor.assumeIsolated {
            let link = ScriptLink()
            link.answer["capsule.view"] = { i in .success(list(["for-\(i["q"] as? String ?? "?")"])) }
            let (s, clock) = session(link)
            s.load(q: "")
            t.ok(spin { s.base?.rows.map(\.id) == ["for-"] })
            s.load(q: "inv"); s.load(q: "invo"); s.load(q: "invoice")
            t.eq(link.calls("capsule.view").count, 1, "nothing asked while typing")
            clock.advance(0.2)
            t.ok(spin { s.base?.rows.map(\.id) == ["for-invoice"] })
            t.eq(link.calls("capsule.view").count, 2, "only the last words went")
            t.eq(link.calls("capsule.view").last?["module"] as? String, "google")
            t.eq(link.calls("capsule.view").last?["command"] as? String, "mail")
            t.eq(link.calls("capsule.view").last?["view"] as? String, "list")
            t.ok(link.calls("capsule.view").last?["tool"] == nil, "no tool name is ever sent")
        }
    }

    t.test("the same words within 30 seconds come from memory; a command with no argument sends no q") {
        MainActor.assumeIsolated {
            let link = ScriptLink()
            link.answer["capsule.view"] = { _ in .success(list(["a"])) }
            let (s, clock) = session(link)
            s.load(q: "x"); t.ok(spin { s.base != nil })
            s.load(q: "y"); clock.advance(0.2); t.ok(spin { link.calls("capsule.view").count == 2 })
            s.load(q: "x")
            t.eq(link.calls("capsule.view").count, 2, "x is remembered")
            let noArg = ViewCommand(module: "google", id: "next", title: "Next meeting", keywords: [], alias: nil, icon: nil, root: false,
                                    argName: nil, argPlaceholder: nil, firstParty: true, hash: "h2")
            let (s2, _) = session(link, noArg)
            s2.load(q: "ignored"); t.ok(spin { s2.base != nil })
            t.ok(link.calls("capsule.view").last?["q"] == nil)
        }
    }

    t.test("a slow call says so once, and an error is said in the module's words") {
        MainActor.assumeIsolated {
            let link = ScriptLink()
            link.answer["capsule.view"] = { _ in .success(["v": 1, "kind": "error", "code": "x", "message": "Gmail is not connected."]) }
            let (s, clock) = session(link)
            s.slowAfter = 0.5
            s.load(q: "a")
            clock.advance(0.6)
            t.ok(s.problem == "Search mail is slow. Try again." || s.problem == "Gmail is not connected.")
            t.ok(spin { s.problem == "Gmail is not connected." })
            t.ok(s.base == nil, "no list from an error")
        }
    }

    t.test("Return on a row runs its action by id; a link opens only if it is safe; copy, say and ask do what they say") {
        let opened = OvCounter()
        let r: [String]? = t.wait { @MainActor () -> [String] in
            let link = ScriptLink()
            link.answer["capsule.view"] = { _ in .success(list(["t1"])) }
            var effects: [[String: Any]] = [["open": "https://mail.example.com/t1"], ["open": "javascript:alert(1)"], ["copy": "Menu v2"], ["say": "Marked read."], ["ask": "reply to alex about "]]
            link.answer["capsule.act"] = { _ in .success(["v": 1, "kind": "done", "effect": effects.removeFirst()]) }
            let (s, _) = session(link)
            var asked: String?
            s.onAsk = { asked = $0 }
            s.openURL = { _ in opened.bump(); return true }
            var copied: String?
            s.copy = { copied = $0 }
            s.load(q: ""); _ = await poll { s.base != nil }
            let row = s.base!.rows[0], a = row.actions[0]
            var out: [String] = []
            for _ in 0..<5 { out.append("\(await s.act(a, row: row))") }
            out.append("copied \(copied ?? "-")"); out.append("asked \(asked ?? "-")")
            let sent = link.calls("capsule.act")[0]
            out.append("\(sent["module"] as? String ?? "-")/\(sent["command"] as? String ?? "-")/\(sent["action"] as? String ?? "-")/\(sent["id"] as? String ?? "-")")
            return out
        }
        t.eq(r, ["close(nil)", "failed(\"That link is not one Lumen opens.\")", "close(Optional(\"Copied \u{201C}Menu v2\u{201D}\"))", "said(\"Marked read.\")", "said(\"\")",
                 "copied Menu v2", "asked reply to alex about ", "google/mail/open/t1"])
        t.eq(opened.count, 1)
    }

    t.test("a detail opens on Tab, with its own actions, and Esc goes back") {
        let r: [String]? = t.wait { @MainActor () -> [String] in
            let link = ScriptLink()
            link.answer["capsule.view"] = { i in
                (i["view"] as? String) == "detail"
                    ? .success(["v": 1, "kind": "detail", "title": "Thread t1", "body": "Hello", "fields": [["label": "From", "value": "alex"]], "actions": [["id": "open", "title": "Open"]]])
                    : .success(list(["t1"]))
            }
            let (s, _) = session(link)
            s.load(q: ""); _ = await poll { s.base != nil }
            s.openDetail(s.base!.rows[0])
            _ = await poll { s.showsLevelView }
            var out: [String] = ["\(link.calls("capsule.view").last?["view"] as? String ?? "-") \(link.calls("capsule.view").last?["id"] as? String ?? "-")"]
            if case .detail(let d, _)? = s.level { out.append(d.title) }
            out.append("\(s.back())"); out.append("\(s.showsLevelView)"); out.append("\(s.back())")
            return out
        }
        t.eq(r, ["detail t1", "Thread t1", "true", "false", "false"])
    }

    t.test("a form: required fields are checked first, the fields go to the module, and done returns to the list") {
        let r: [String]? = t.wait { @MainActor () -> [String] in
            let link = ScriptLink()
            link.answer["capsule.view"] = { _ in .success(list(["t1"])) }
            link.answer["capsule.act"] = { i in
                if (i["action"] as? String) == "draft" {
                    return .success(["v": 1, "kind": "view", "frame": ["v": 1, "kind": "form", "id": "reply", "title": "Reply",
                                     "fields": [["name": "body", "label": "Your reply", "type": "multiline", "required": true]], "submit": ["title": "Save as draft"]]])
                }
                return .success(["v": 1, "kind": "done", "said": "Draft saved."])
            }
            let (s, _) = session(link)
            s.load(q: ""); _ = await poll { s.base != nil }
            var out: [String] = []
            out.append("\(await s.act(ViewAction(id: "draft", title: "Draft", shortcut: nil, confirm: nil, outward: false), row: s.base!.rows[0]))")
            out.append("form \(s.isFormOrPreview)")
            out.append("\(await s.submit())")
            s.values["body"] = "Thanks, see you Tuesday."
            out.append("\(await s.submit())")
            let sent = link.calls("capsule.act").last!
            out.append("\(sent["action"] as? String ?? "-") \(sent["form"] as? String ?? "-") \((sent["fields"] as? [String: String])?["body"] ?? "-")")
            return out
        }
        t.eq(r, ["said(\"\")", "form true", "failed(\"Your reply is needed.\")", "said(\"Draft saved.\")", "submit reply Thanks, see you Tuesday."])
    }

    t.test("a send is previewed first; the second Return sends those exact words with the hash; changed words preview again") {
        let r: [String]? = t.wait { @MainActor () -> [String] in
            let link = ScriptLink()
            link.answer["capsule.view"] = { _ in .success(list(["t1"], actions: [["id": "send", "title": "Send reply", "outward": true]])) }
            var n = 0
            func preview(_ hash: String) -> [String: Any] {
                ["v": 1, "kind": "preview", "title": "Send this", "hash": hash, "token": "tok-\(hash)", "words": [["label": "To", "value": "dana@harlowlegal.example"]]]
            }
            link.answer["capsule.act"] = { i in
                n += 1
                if let asked = i["asked"] as? [String: Any] {
                    // A server that takes the second call only with the hash AND the token that came with the preview.
                    guard let h = asked["hash"] as? String, (asked["token"] as? String) == "tok-\(h)" else { return .success(preview("refused")) }
                    return h == "h-2" ? .success(["v": 1, "kind": "done", "said": "Sent."]) : .success(preview("h-3"))
                }
                return .success(preview(n == 1 ? "h-1" : "h-2"))
            }
            let (s, _) = session(link)
            s.load(q: ""); _ = await poll { s.base != nil }
            let row = s.base!.rows[0], send = row.actions[0]
            var out: [String] = []
            out.append("\(await s.act(send, row: row))")               // first Return: a preview, nothing sent
            out.append("preview \(s.isFormOrPreview) \(link.calls("capsule.act").count)")
            out.append("\(await s.confirmPreview())")                   // second Return with h-1: the words changed, preview again
            let asked = link.calls("capsule.act").last?["asked"] as? [String: Any]
            out.append("\(asked?["hash"] as? String ?? "-")/\(asked?["token"] as? String ?? "-")")
            out.append("stack \(s.stack.count)")
            out.append("\(await s.confirmPreview())")                   // h-3 is not h-2 in the script: previews once more
            return out
        }
        t.eq(r?.first, "said(\"\")")
        t.eq(r?[1], "preview true 1")
        t.eq(r?[3], "h-1/tok-h-1", "the second Return carries the hash and the token of the words it showed")
        t.eq(r?[4], "stack 2", "still one preview level over the list")
    }

    t.test("held says it is waiting, never sent; needs and error are said; a push and Esc") {
        let r: [String]? = t.wait { @MainActor () -> [String] in
            let link = ScriptLink()
            link.answer["capsule.view"] = { _ in .success(list(["t1"])) }
            var kinds: [[String: Any]] = [["v": 1, "kind": "held", "message": "Waiting for your OK."], ["v": 1, "kind": "needs", "code": "n", "message": "Connect Gmail."],
                                          ["v": 1, "kind": "error", "code": "missing", "message": "That thread is gone."], ["v": 1, "kind": "push", "command": "next"]]
            link.answer["capsule.act"] = { _ in .success(kinds.removeFirst()) }
            let (s, _) = session(link)
            var pushed: String?
            s.onPush = { pushed = $0 }
            s.load(q: ""); _ = await poll { s.base != nil }
            let row = s.base!.rows[0], a = row.actions[0]
            var out: [String] = []
            for _ in 0..<4 { out.append("\(await s.act(a, row: row))") }
            out.append(pushed ?? "-"); out.append(s.problem ?? "-")
            return out
        }
        t.eq(r, ["said(\"Waiting for your OK.\")", "failed(\"Connect Gmail.\")", "failed(\"That thread is gone.\")", "said(\"\")", "next", "Connect Gmail."])
    }

    t.test("commands: matched in memory by title, keyword and alias; an alias and words open the command already searching") {
        MainActor.assumeIsolated {
            let link = ScriptLink()
            link.answer["capsule.commands"] = { _ in .success(["commands": [
                ["module": "google", "id": "mail", "title": "Search mail", "keywords": ["gmail", "inbox"], "alias": "mail", "root": true, "arg": ["name": "q"], "firstParty": true, "hash": "h"],
                ["module": "google", "id": "next", "title": "Next meeting", "keywords": ["calendar"], "firstParty": true, "hash": "h"],
                ["module": "crm", "id": "leads", "title": "Leads", "firstParty": false, "hash": "h"],
            ]]) }
            let p = ViewCommandsProvider(vyred: link)
            var entered: [String] = []
            p.enter = { c, w in entered.append("\(c.key)|\(w)") }
            t.eq(p.resultsNow(for: Query("mail")).count, 0, "nothing before the first read")
            p.read(force: true)
            t.ok(spin { p.commands.count == 3 })
            t.eq(p.resultsNow(for: Query("inbox")).first?.title, "Search mail")
            t.eq(p.resultsNow(for: Query("calendar")).first?.title, "Next meeting")
            t.eq(p.resultsNow(for: Query("mail")).first?.title, "Search mail", "the alias comes first")
            let a = p.resultsNow(for: Query("mail invoice from dana")).first
            t.eq(a?.title, "Search mail: invoice from dana")
            t.eq(p.resultsNow(for: Query("leads")).first?.subtitle, "from crm", "an added module says where it is from")
            t.eq(p.resultsNow(for: Query("m")).count, 0)
            _ = a?.actions.first
        }
        let entered: [String]? = t.wait { @MainActor () -> [String] in
            let link = ScriptLink()
            link.answer["capsule.commands"] = { _ in .success(["commands": [["module": "google", "id": "mail", "title": "Search mail", "alias": "mail", "arg": ["name": "q"], "hash": "h"]]]) }
            let p = ViewCommandsProvider(vyred: link)
            let seen = OvCounter()
            var log: [String] = []
            p.enter = { c, w in log.append("\(c.key)|\(w)"); seen.bump() }
            p.read(force: true)
            _ = await poll { p.commands.count == 1 }
            let row = p.resultsNow(for: Query("mail invoice")).first!
            _ = await row.actions[0].run(row, ActionContext(query: Query("mail invoice")))
            return log
        }
        t.eq(entered, ["google/mail|invoice"])
    }

    t.test("commands are read at most twice a minute, and never from a vyred without the tool") {
        MainActor.assumeIsolated {
            let link = ScriptLink()
            link.answer["capsule.commands"] = { _ in .success(["commands": [] as [Any]]) }
            let clock = Counter2()
            let p = ViewCommandsProvider(vyred: link, now: { Date(timeIntervalSince1970: 1_800_000_000 + Double(clock.n)) })
            p.warm(); t.ok(spin { link.calls("capsule.commands").count == 1 })
            RunLoop.main.run(until: Date().addingTimeInterval(0.15))       // let the first read finish
            p.warm(); p.warm()
            clock.n = 10; p.warm()
            t.eq(link.calls("capsule.commands").count, 1)
            clock.n = 31; p.warm(); t.ok(spin { link.calls("capsule.commands").count == 2 })
            let none = ScriptLink(); none.tools = []
            ViewCommandsProvider(vyred: none).warm()
            t.eq(none.calls("capsule.commands").count, 0)
        }
    }

    t.test("an ask effect only puts the words in the box: nothing is asked, recalled or sent until the person acts") {
        MainActor.assumeIsolated {
            let v = FakeVyred(name: "view-prefill")
            for tool in ["memory.answer", "memory.ask", "threads.start", "threads.send", "agents.ask"] { v.tool(tool) { _ in ["ok": true] } }
            v.tool("sessions.models.get") { _ in [:] }
            t.ok(v.start())
            defer { v.stop() }
            let m = CapsuleModel(home: vyScratch("view-prefill-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket), providers: [])
            m.autoDelay = 0.05
            m.prefill("reply to alex about the menu for Northwind Bakery")
            t.eq(m.text, "reply to alex about the menu for Northwind Bakery")
            let before = v.callNames.count
            RunLoop.main.run(until: Date().addingTimeInterval(1.0))
            let after = Array(v.callNames.dropFirst(before))
            t.ok(!after.contains { ["memory.answer", "memory.ask", "threads.start", "threads.send", "agents.ask"].contains($0) }, "\(after)")
            t.eq(m.asked, nil); t.ok(m.reply == nil)
            // The person edits them: from then on they are theirs.
            m.text += "!"
            t.ok(m.prefilled != m.text)
        }
    }

    t.test("in the box: Return enters the command, the list is the results, Esc leaves one step at a time") {
        MainActor.assumeIsolated {
            let link = ScriptLink()
            let v = FakeVyred(name: "view-box")
            v.tool("capsule.view") { i in list(["for-\(i["q"] as? String ?? "?")"], from: "acme-crm") }
            t.ok(v.start())
            defer { v.stop() }
            let m = CapsuleModel(home: vyScratch("view-box-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket), providers: [])
            let p = ViewCommandsProvider(vyred: link)
            m.attach(views: p)
            m.enterView(MAIL)
            t.ok(m.viewSession != nil)
            t.ok(spin { m.flat.first?.id == "view:google/mail:for-" }, "\(m.flat.map(\.id))")
            t.eq(m.flat.first?.subtitle, "from acme-crm \u{00B7} alex \u{00B7} Tue")
            t.eq(m.flat.first?.actions.map(\.title), ["Open in Gmail"])
            t.eq(CapsuleLayout.placeholder(m), "from, subject or words")
            m.text = "invoice"
            t.eq(m.viewBack(), true); t.eq(m.text, "", "first Esc clears the words")
            t.ok(m.viewSession != nil)
            t.eq(m.viewBack(), true); t.ok(m.viewSession == nil, "second Esc leaves the command")
            t.eq(m.viewBack(), false, "not in a command: Esc is the box's")
            m.enterView(MAIL); m.didHide()
            t.ok(m.viewSession == nil, "hiding the Capsule ends it")
        }
    }
}

final class Counter2: @unchecked Sendable { var n = 0 }

// capsule-suite: needCredentialSuite
let needCredentialSuite = Suite("needs a credential") { t in
    t.test("an added module's needs frame asks for its own module's credential, with its name on the card; a first-party one may name its need's module") {
        MainActor.assumeIsolated {
            let link = ScriptLink()
            link.answer["capsule.view"] = { _ in .success(["v": 1, "kind": "needs", "message": "Add your key.", "need": ["kind": "credential", "need": "api", "module": "google", "label": "Google login"]]) }
            var asked: [CredentialNeed] = []
            let added = ViewCommand(module: "acme-crm", id: "leads", title: "Leads", keywords: [], alias: nil, icon: nil, root: false, argName: nil, argPlaceholder: nil, firstParty: false, hash: "h")
            let (s1, _) = session(link, added)
            s1.onNeed = { asked.append($0) }
            s1.load(q: "")
            t.ok(spin { !asked.isEmpty })
            t.eq(asked.first?.module, "acme-crm", "never the module the frame names"); t.eq(asked.first?.label, "Google login for acme-crm")
            asked = []
            let (s2, _) = session(link, MAIL)
            s2.onNeed = { asked.append($0) }
            s2.load(q: "")
            t.ok(spin { !asked.isEmpty })
            t.eq(asked.first?.module, "google"); t.eq(asked.first?.label, "Google login")
        }
    }
}

// capsule-suite: nextMeetingSuite
let nextMeetingSuite = Suite("next meeting line") { t in
    t.test("the next meeting is one line under the empty box, asked once a minute, and absent when there is no such command") {
        let v = FakeVyred(name: "next-meeting")
        v.tool("capsule.commands") { _ in ["commands": [["module": "google", "id": "next", "title": "Next meeting", "firstParty": true, "hash": "h"],
                                                          ["module": "crm", "id": "next", "title": "Their next", "firstParty": false, "hash": "h"]]] }
        v.tool("capsule.view") { _ in ["v": 1, "kind": "list", "title": "Next", "rows": [["id": "e1", "title": "Harlow Legal call", "subtitle": "in 25 min"]]] }
        t.ok(v.start()); defer { v.stop() }
        let r: [String]? = t.wait { @MainActor () -> [String] in
            let m = CapsuleModel(home: vyScratch("next-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket), providers: [])
            let p = ViewCommandsProvider(vyred: m.vyred)
            m.attach(views: p)
            m.willShow(front: nil)
            _ = await poll { m.nextMeeting != nil }
            var out = [m.nextMeeting ?? "-"]
            let asked = v.callsOf("capsule.view").count
            m.loadNextMeeting()
            try? await Task.sleep(nanoseconds: 150_000_000)
            out.append("again \(v.callsOf("capsule.view").count - asked)")
            out.append("module \(v.callsOf("capsule.view").first?["module"] as? String ?? "-")")
            return out
        }
        t.eq(r, ["Harlow Legal call · in 25 min", "again 0", "module google"])
    }
}
