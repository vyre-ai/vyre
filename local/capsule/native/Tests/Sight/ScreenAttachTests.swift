// capsule-suite: screenAttachSuite
// Screen context on an Ask, against a fake vyred whose screen.context answers with the shapes
// the screen module gives (normal, secure, blind, a selection, a failure). No real screen is read.

import AppKit
import SwiftUI

private final class AttachLink: VyredLink, @unchecked Sendable {
    private let lock = NSLock()
    private var answers: [String: ([String: Any]) -> VyredResult] = [:]
    private var log: [(String, [String: Any])] = []
    var isUp: Bool { true }
    func answer(_ tool: String, _ fn: @escaping ([String: Any]) -> VyredResult) { lock.withLock { answers[tool] = fn } }
    func has(_ tool: String) -> Bool { lock.withLock { answers[tool] != nil } }
    func call(_ tool: String, _ input: [String: Any], presence: Bool) async -> VyredResult {
        let fn = lock.withLock { log.append((tool, input)); return answers[tool] }
        return fn?(input) ?? .failure(code: "no_such_tool", message: "no such tool: \(tool)")
    }
    func calls(_ tool: String) -> [[String: Any]] { lock.withLock { log.filter { $0.0 == tool }.map(\.1) } }
    func on(_ pattern: String, _ handler: @escaping @MainActor (VyredEvent) -> Void) -> VyredSubscription { Sub() }
    final class Sub: VyredSubscription { func cancel() {} }
}

@MainActor
private final class AttachHost: CapsuleHost {
    let vyred: VyredLink
    var front: FrontApp? = FrontApp(bundle: "com.google.Chrome", pid: 4242, name: "Google Chrome")
    var isShown = true
    var logged: [String] = []
    init(_ link: VyredLink) { vyred = link }
    func permission(_ p: Permission) -> PermissionState { .notAsked }
    func request(_ p: Permission, reason: String) async -> Bool { false }
    func showPanel(_ extensionID: String) {}
    func hidePanel() {}
    func setQuery(_ text: String) {}
    func say(_ line: String) {}
    func stepAside() async -> Bool { false }
    func notify(title: String, body: String) {}
    func log(_ message: String) { logged.append(message) }
}

/// A screen.context answer as the screen module shapes it.
private func context(app: String = "Google Chrome", bundle: String = "com.google.Chrome", title: String = "Northwind Bakery - Orders",
                     url: String? = "https://orders.example/northwind/42", selected: String? = nil, text: String = "", secure: Bool = false,
                     truncated: Bool = false) -> [String: Any] {
    var focused: [String: Any] = ["role": secure ? "AXTextField" : "AXTextArea", "subrole": secure ? "AXSecureTextField" : "", "name": "Body"]
    if !secure { focused["value"] = "draft"; focused["selectedText"] = selected ?? "" }
    var d: [String: Any] = ["app": ["name": app, "bundle": bundle, "pid": 4242], "window": ["title": title], "focused": focused,
                            "text": text, "truncated": truncated, "secure": secure]
    if let url { d["url"] = url }
    return d
}

private let BLIND: [String: Any] = ["app": ["name": "1Password", "bundle": "com.1password.1password", "pid": 77],
                                    "window": ["title": "Vault"], "blind": "a password manager"]

private let PAGE = "Order 42 for Northwind Bakery\n\n   two   dozen   rolls\nDeliver to Harlow Legal\n"

@MainActor private func ext(_ link: AttachLink) -> (AttachHost, SightExtension) {
    let host = AttachHost(link)
    return (host, SightExtension(host: host))
}

let screenAttachSuite = Suite("screen attach") { t in
    t.test("triggers: words that point at the screen") {
        let yes = [
            "summarize this", "Summarize this page", "what's this error?", "What is this", "translate this to French",
            "reply to this", "explain this", "is this right?", "fix this", "rewrite this more politely", "proofread this",
            "what does this mean", "what's here", "anything wrong here?", "look at these numbers", "check these results",
            "what's that", "explain that", "what about that?", "summarize", "summarise it", "translate to Spanish",
            "translate into German please", "reply saying yes", "reply", "explain please", "tl;dr this", "what's on my screen",
            "read what's on screen", "can you see my screen", "this email from juno", "this doc from kit", "does that look right",
            "Summarize the page", "explain the error", "What\u{2019}s this?",
        ]
        let no = [
            "", "remind me this week to call alex", "what's on this morning", "book a table this Friday", "plan this year",
            "did kit call this time", "that's great, thanks", "here's my plan for Northwind Bakery", "here is my list",
            "tell juno that the order is late", "I think that we should go", "explain recursion", "translate good morning to Spanish",
            "summarize the Harlow Legal meeting notes from last Tuesday", "what time is it", "call alex", "open Notes",
            "set a timer for 10 minutes", "weather in London", "rewrite my bio for Northwind Bakery", "these days are long",
            "come here", "send kit the invoice", "what's the capital of France", "email Harlow Legal about Monday",
            "that month was busy", "remind me next week", "who is juno", "screen time report", "these weeks fly by",
        ]
        for w in yes { t.ok(ScreenAttach.refersToScreen(w), "should trigger: \(w)") }
        for w in no { t.ok(!ScreenAttach.refersToScreen(w), "should not trigger: \(w)") }
        t.ok(yes.count >= 30 && no.count >= 30)
    }

    t.test("decide: a selection attaches with no trigger; blind and secure never do") {
        let sel = ScreenSnapshot.from(context(selected: "two dozen rolls"))!
        t.ok(ScreenAttach.decide(words: "how many", light: sel))
        let plain = ScreenSnapshot.from(context())!
        t.ok(!ScreenAttach.decide(words: "how many", light: plain))
        t.ok(ScreenAttach.decide(words: "how many here", light: plain))
        let blind = ScreenSnapshot.from(BLIND)!
        t.ok(!ScreenAttach.decide(words: "summarize this", light: blind))
        let secure = ScreenSnapshot.from(context(selected: "hunter2", secure: true))!
        t.eq(secure.selection, nil)
        t.ok(!ScreenAttach.decide(words: "how many", light: secure))
        t.ok(!ScreenSnapshot.from(context(selected: "   \n "))!.hasSelection)
    }

    t.test("chip: app and window, long titles cut with an ellipsis, app alone without a title") {
        t.eq(ScreenAttach.chip(ScreenSnapshot.from(context())!), "with your screen: Google Chrome \u{00B7} Northwind Bakery - Orders")
        let long = ScreenAttach.chip(ScreenSnapshot.from(context(title: "Harlow Legal - Engagement letter for Northwind Bakery, second draft"))!)
        t.ok(long.hasSuffix("\u{2026}"), long)
        t.eq(long.count, "with your screen: Google Chrome \u{00B7} ".count + 40)
        t.eq(ScreenAttach.chip(ScreenSnapshot.from(context(app: "Notes", title: ""))!), "with your screen: Notes")
    }

    t.test("body: app, window, URL, selection, a collapsed excerpt, no empty lines") {
        let b = ScreenAttach.body(ScreenSnapshot.from(context(selected: "two dozen rolls", text: PAGE))!)
        t.eq(b, """


        [Screen context, shared by the user from the Capsule]
        App: Google Chrome
        Window: Northwind Bakery - Orders
        URL: https://orders.example/northwind/42
        Selected text:
        two dozen rolls
        Visible text (excerpt):
        Order 42 for Northwind Bakery
        two dozen rolls
        Deliver to Harlow Legal
        """)
        let bare = ScreenAttach.body(ScreenSnapshot.from(context(url: nil, text: ""))!)
        t.ok(!bare.contains("URL:") && !bare.contains("Selected") && !bare.contains("Visible"), bare)
    }

    t.test("body: secure leaves the value out and says so; blind gives nothing") {
        let b = ScreenAttach.body(ScreenSnapshot.from(context(selected: "hunter2", text: "Sign in", secure: true))!)
        t.ok(b.contains("(a password field was focused; its value was left out)"))
        t.ok(!b.contains("hunter2") && !b.contains("Selected text"))
        t.eq(ScreenAttach.body(ScreenSnapshot.from(BLIND)!), "")
    }

    t.test("trim: the excerpt stops on a line near 1500 characters, the selection at 2000") {
        let lines = (1...200).map { "Line \($0) of the Northwind Bakery ledger" }.joined(separator: "\n")
        let ex = ScreenAttach.excerpt(lines)
        t.ok(ex.hasSuffix("\n..."))
        let kept = ex.dropLast(4).split(separator: "\n")
        t.ok(kept.allSatisfy { $0.hasPrefix("Line ") && $0.hasSuffix("ledger") }, "cut on a line boundary")
        t.ok(ex.count <= 1504 && ex.count > 1400, "\(ex.count)")
        let one = ScreenAttach.excerpt(String(repeating: "rolls ", count: 600))
        t.ok(one.count <= 1504 && one.hasSuffix("\n..."))
        t.ok(ScreenAttach.excerpt("short", truncated: true).hasSuffix("\n..."), "the helper's own cut is marked too")
        let sel = String(repeating: "a", count: 2500)
        let b = ScreenAttach.body(ScreenSnapshot.from(context(selected: sel))!)
        t.ok(b.contains(String(repeating: "a", count: 2000) + "...") && !b.contains(String(repeating: "a", count: 2001)))
    }

    t.test("URL: token-looking query and fragment go, the path stays") {
        t.eq(ScreenAttach.cleanURL("https://mail.example/inbox/42?token=abc&view=full"), "https://mail.example/inbox/42")
        t.eq(ScreenAttach.cleanURL("https://app.example/cb#access_token=xyz&state=1"), "https://app.example/cb")
        t.eq(ScreenAttach.cleanURL("https://docs.example/d/7?tab=2#heading-3"), "https://docs.example/d/7?tab=2#heading-3")
        t.eq(ScreenAttach.cleanURL("https://s3.example/f.pdf?X-Amz-Signature=q&X-Amz-Date=1"), "https://s3.example/f.pdf")
        t.eq(ScreenAttach.cleanURL("https://shop.example/keyboards?sort=price"), "https://shop.example/keyboards?sort=price")
    }

    t.test("extension: one light read on show, one full read on the first trigger, the same snapshot after") {
        let link = AttachLink()
        link.answer("screen.context") { input in .success(context(text: (input["text"] as? Bool) == true ? PAGE : "")) }
        let r = t.wait { @MainActor () -> [String] in
            let (_, e) = ext(link)
            e.capsuleWillShow(front: nil)
            var out: [String] = []
            let none = await e.screenAttachment(for: "how many rolls")
            out.append("none \(none == nil)")
            let a = await e.screenAttachment(for: "summarize this")
            let b = await e.screenAttachment(for: "summarize this for juno")
            out.append(a?.id ?? "nil"); out.append(a?.chip ?? "nil"); out.append(a?.bundle ?? "nil")
            out.append("same \(a?.body == b?.body)")
            out.append("reads \(link.calls("screen.context").map { "\($0["text"] as? Bool ?? false)" })")
            e.capsuleDidHide()
            e.capsuleWillShow(front: nil)
            _ = await e.screenAttachment(for: "what's this")
            out.append("after hide \(link.calls("screen.context").count)")
            out.append("body \(a?.body.contains("two dozen rolls") == true)")
            return out
        }
        t.eq(r?[0], "none true")
        t.eq(r?[1], "sight:screen")
        t.eq(r?[2], "with your screen: Google Chrome \u{00B7} Northwind Bakery - Orders")
        t.eq(r?[3], "com.google.Chrome")
        t.eq(r?[4], "same true")
        t.eq(r?[5], "reads [\"false\", \"true\"]")
        t.eq(r?[6], "after hide 4", "a new show reads the screen again")
        t.eq(r?[7], "body true")
    }

    t.test("extension: blind, a selection only, a failure, and no module") {
        let r = t.wait { @MainActor () -> [String] in
            var out: [String] = []
            let blind = AttachLink(); blind.answer("screen.context") { _ in .success(BLIND) }
            let (_, b) = ext(blind); b.capsuleWillShow(front: nil)
            out.append("blind \(await b.screenAttachment(for: "summarize this") == nil) reads \(blind.calls("screen.context").count)")

            let sel = AttachLink(); sel.answer("screen.context") { _ in .success(context(selected: "Deliver to Harlow Legal", text: PAGE)) }
            let (_, s) = ext(sel); s.capsuleWillShow(front: nil)
            let x = await s.screenAttachment(for: "who is that for")
            out.append("selection \(x?.body.contains("Selected text:\nDeliver to Harlow Legal") == true)")

            let bad = AttachLink(); bad.answer("screen.context") { _ in .failure(code: "not_trusted", message: "not_trusted: grant Accessibility to Vyre") }
            let (h, f) = ext(bad); f.capsuleWillShow(front: nil)
            out.append("failure \(await f.screenAttachment(for: "summarize this") == nil) logged \(h.logged.count > 0)")

            let none = AttachLink()
            let (_, n) = ext(none); n.capsuleWillShow(front: nil)
            out.append("no module \(await n.screenAttachment(for: "summarize this") == nil) calls \(none.calls("screen.context").count)")
            return out
        }
        t.eq(r?[0], "blind true reads 1", "a blind place stops at the light read: its text is never asked for")
        t.eq(r?[1], "selection true")
        t.eq(r?[2], "failure true logged true")
        t.eq(r?[3], "no module true calls 0")
    }

    t.test("panel: the chip rides along only if it stayed") {
        let link = AttachLink()
        link.answer("screen.context") { input in .success(context(text: (input["text"] as? Bool) == true ? PAGE : "")) }
        link.answer("agents.ask") { _ in .success(["ok": true, "thread": "t1"]) }
        let r = t.wait { @MainActor () -> [String] in
            let (_, e) = ext(link)
            let p = e.panel
            p.shown = PanelSession(id: "agent:juno", label: "juno", kind: .assistant("juno"), thread: "t1")
            var out: [String] = []
            p.draft = "summarize this"
            await p.refreshChip()
            out.append(p.chip?.chip ?? "nil")
            await p.send()
            let sent = link.calls("agents.ask").last?["text"] as? String ?? ""
            out.append("with \(sent.hasPrefix("summarize this\n\n[Screen context") && sent.contains("Deliver to Harlow Legal"))")
            out.append("cleared \(p.chip == nil)")

            p.draft = "translate this"
            await p.refreshChip()
            out.append("chip again \(p.chip != nil)")
            p.removeChip()
            await p.refreshChip()
            out.append("stays removed \(p.chip == nil)")
            await p.send()
            out.append("without \(link.calls("agents.ask").last?["text"] as? String ?? "")")

            p.draft = "call alex"
            await p.refreshChip()
            out.append("no trigger \(p.chip == nil)")
            return out
        }
        t.eq(r?[0], "with your screen: Google Chrome \u{00B7} Northwind Bakery - Orders")
        t.eq(r?[1], "with true")
        t.eq(r?[2], "cleared true")
        t.eq(r?[3], "chip again true")
        t.eq(r?[4], "stays removed true")
        t.eq(r?[5], "without translate this")
        t.eq(r?[6], "no trigger true")
    }
}
