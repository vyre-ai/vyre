// capsule-suite: appsExtensionSuite
// The apps extension against a fake vyred and a fake host: which apps `@` offers and with what
// icons, what is inside a chip, that the person's own things run on the first Enter, that a send
// is only previewed on the first Enter and sent (with the person's proof) on the second, that a
// Gate-held send is approved as the proof, and that an unclear app or recipient is a question.
// Nothing here reaches a real app, a real send or a dialog.

import AppKit
import Foundation

private final class AppsLink: VyredLink, @unchecked Sendable {
    private let lock = NSLock()
    private var answers: [String: ([String: Any]) -> VyredResult] = [:]
    private var log: [(tool: String, input: [String: Any], presence: Bool)] = []
    var isUp: Bool { true }
    func answer(_ tool: String, _ fn: @escaping ([String: Any]) -> VyredResult) { lock.lock(); answers[tool] = fn; lock.unlock() }
    func has(_ tool: String) -> Bool { lock.lock(); defer { lock.unlock() }; return answers[tool] != nil }
    func call(_ tool: String, _ input: [String: Any], presence: Bool) async -> VyredResult {
        record(tool, input, presence)?(input) ?? .failure(code: "no_such_tool", message: "no such tool: \(tool)")
    }
    private func record(_ tool: String, _ input: [String: Any], _ presence: Bool) -> (([String: Any]) -> VyredResult)? {
        lock.lock(); defer { lock.unlock() }; log.append((tool, input, presence)); return answers[tool]
    }
    func on(_ pattern: String, _ handler: @escaping @MainActor (VyredEvent) -> Void) -> VyredSubscription { Sub() }
    func calls(_ tool: String) -> [[String: Any]] { lock.lock(); defer { lock.unlock() }; return log.filter { $0.tool == tool }.map(\.input) }
    /// "tool" or "tool+proof" for each call, in order.
    var trail: [String] { lock.lock(); defer { lock.unlock() }; return log.map { $0.presence ? $0.tool + "+proof" : $0.tool } }
    final class Sub: VyredSubscription { func cancel() {} }
}

@MainActor
private final class AppsHost: CapsuleHost {
    let vyred: VyredLink
    var front: FrontApp?
    var isShown = true
    init(_ link: VyredLink) { vyred = link }
    func permission(_ p: Permission) -> PermissionState { .notAsked }
    func request(_ p: Permission, reason: String) async -> Bool { false }
    func showPanel(_ extensionID: String) {}
    func hidePanel() {}
    func setQuery(_ text: String) {}
    func say(_ line: String) {}
    func stepAside() async -> Bool { false }
    func notify(title: String, body: String) {}
    func log(_ message: String) {}
}

private let LIST: [String: Any] = ["apps": [
    ["name": "Notes", "bundleId": "com.apple.Notes", "path": "/System/Applications/Notes.app", "tier": "script", "actions": ["create", "append"], "nests": true],
    ["name": "WhatsApp", "bundleId": "net.whatsapp.WhatsApp", "path": "/Applications/WhatsApp.app", "tier": "ax", "actions": ["send"], "nests": true],
    ["name": "Slack", "bundleId": "com.tinyspeck.slackmacgap", "path": "/Applications/Slack.app", "tier": "connector", "actions": ["send"], "nests": true],
    ["name": "Northwind Bakery POS", "bundleId": "com.example.pos", "path": "/Applications/Northwind Bakery POS.app", "tier": "ax"],
]]
private let PEOPLE: [String: Any] = ["targets": [
    ["id": "c1", "title": "Juno Park", "kind": "contact"], ["id": "c2", "title": "Jules", "kind": "contact"], ["id": "c4", "title": "kit", "kind": "contact"],
]]

/// A link with apps.list and apps.targets answering, and apps.route by the rules below.
private func link(route: @escaping ([String: Any]) -> [String: Any]) -> AppsLink {
    let l = AppsLink()
    l.answer("apps.list") { _ in .success(LIST) }
    l.answer("apps.targets") { _ in .success(PEOPLE) }
    l.answer("apps.route") { .success(route($0)) }
    l.answer("apps.act") { i in .success(["said": "Note saved: \((i["args"] as? [String: Any])?["text"] ?? "")"]) }
    l.answer("apps.send") { i in .success(["said": "Sent to \((i["args"] as? [String: Any])?["to"] ?? "")"]) }
    return l
}

/// apps.route the way vyred answers the words these tests type.
private func rules(_ i: [String: Any]) -> [String: Any] {
    let text = i["text"] as? String ?? "", app = i["app"] as? String ?? ""
    if let to = i["to"] as? String {
        return ["app": app, "action": "send", "args": ["to": to, "text": text], "sends": true, "said": "\(app) → \(to == "c1" ? "Juno Park" : to): \(text)"]
    }
    if app == "Notes" { return ["app": "Notes", "action": "create", "args": ["text": text], "sends": false, "said": "Note: \(text)"] }
    if app == "WhatsApp" {
        return ["ambiguous": true, "reason": "who is the WhatsApp message for?", "ask": "Who should get this?", "text": text, "app": "WhatsApp", "action": "send",
                "needs": ["recipient": [["id": "c3", "title": "Ammi jee", "app": "WhatsApp", "score": 0.9]]], "didYouMean": "Did you mean Ammi jee on WhatsApp?"]
    }
    return ["ambiguous": true, "reason": "Vyre has no words for \(app) yet"]
}

let appsExtensionSuite = Suite("apps extension") { t in
    t.test("rows: apps.list and apps.route answers read into what the Capsule shows") {
        let rows = AppRow.from(LIST)
        t.eq(rows.map(\.name), ["Notes", "WhatsApp", "Slack", "Northwind Bakery POS"])
        t.eq(rows[0].sub, "create, append"); t.eq(rows[1].sub, "messages"); t.eq(rows[3].sub, "Vyre has no words for it yet")
        t.eq(rows[3].nests, false)
        t.eq(AppsRoute.question("Who should get this?", "Did you mean Ammi jee on WhatsApp?", ["Ammi jee"]),
             "Who should get this? Did you mean Ammi jee on WhatsApp? Type @ to pick.")
        t.eq(AppsRoute.question("Which app?", nil, ["WhatsApp", "Messages"]), "Which app? WhatsApp or Messages? Type @ to pick.")
        t.eq(AppsRoute.question("Who should get this?", nil, ["a", "b", "c", "d", "e"]), "Who should get this? a, b or c, or 2 more? Type @ to pick.")
        t.eq(AppsRoute.question("Who should get this?", nil, []), "Who should get this? Type @ to pick, or say the name.")
        if case .unsure(let why) = AppsRoute.from(["ambiguous": true, "reason": "nothing to do"]) { t.eq(why, "nothing to do") } else { t.ok(false) }
        if case .action(_, _, let args, let sends, let gated, _) = AppsRoute.from(["app": "Clock", "action": "timer", "args": ["seconds": 600], "sends": false]) {
            t.eq(args["seconds"] as? Int, 600, "numbers stay numbers"); t.eq(sends, false); t.eq(gated, false)
        } else { t.ok(false) }
    }

    t.test("@: the apps Vyre has words for, with their own icons; any app by name; what is inside a chip") {
        let l = link(route: rules)
        let r = t.wait { @MainActor () -> ([String], [String], [String], [String], [String]) in
            let ext = AppsExtension(host: AppsHost(l))
            await ext.refreshApps(l)
            let top = ext.mentions(matching: "", context: .top)
            let pos = ext.mentions(matching: "north", context: .top)
            let wa = top.first { $0.label == "WhatsApp" }!
            let icons = top.map { if case .file(let p) = $0.icon { return p } else { return "-" } }
            await ext.readInside("WhatsApp", parent: wa.id, l)
            let inside = ext.mentions(matching: "ju", context: MentionContext(parent: wa, extensionID: "apps"))
            return (top.map(\.label), icons, pos.map { "\($0.label)|\($0.sub)|\($0.nests)" }, inside.map(\.label), top.map { "\($0.nests)" })
        }
        t.eq(r?.0, ["Notes", "Slack", "WhatsApp"], "an app with no words waits until it is named")
        t.eq(r?.1, ["/System/Applications/Notes.app", "/Applications/Slack.app", "/Applications/WhatsApp.app"])
        t.eq(r?.2, ["Northwind Bakery POS|Vyre has no words for it yet|false"])
        t.eq(r?.3, ["Jules", "Juno Park"])
        t.eq(r?.4, ["true", "true", "true"])
        t.eq(l.calls("apps.list").count, 1)
        t.eq(l.calls("apps.targets").first?["app"] as? String, "WhatsApp")
    }

    t.test("Enter: a note runs at once, with no preview and no proof") {
        let l = link(route: rules)
        let out = t.wait { @MainActor () -> ActionOutcome in
            let ext = AppsExtension(host: AppsHost(l))
            await ext.refreshApps(l)
            let notes = ext.mentions(matching: "notes", context: .top)[0]
            return await ext.send("buy milk", to: notes, in: nil, query: Query("buy milk"))
        }
        t.eq(out, .said("Note saved: buy milk"))
        t.eq(l.trail, ["apps.list", "apps.route", "apps.act"])
        t.eq(l.calls("apps.route").first?["app"] as? String, "Notes")
    }

    t.test("Enter: a send is previewed first; the second Enter on the same words sends it with the proof") {
        let l = link(route: rules)
        let r = t.wait { @MainActor () -> [ActionOutcome] in
            let ext = AppsExtension(host: AppsHost(l))
            await ext.refreshApps(l)
            let wa = ext.mentions(matching: "whats", context: .top)[0]
            await ext.readInside("WhatsApp", parent: wa.id, l)
            let juno = ext.mentions(matching: "juno", context: MentionContext(parent: wa, extensionID: "apps"))[0]
            let q = Query("running late")
            var outs: [ActionOutcome] = []
            outs.append(await ext.send("running late", to: juno, in: wa, query: q))
            outs.append(await ext.send("running late", to: juno, in: wa, query: q))
            // Once sent, the same words again are a new preview, never a second send.
            outs.append(await ext.send("running late", to: juno, in: wa, query: q))
            // Other words forget the old preview.
            outs.append(await ext.send("running later", to: juno, in: wa, query: q))
            outs.append(await ext.send("running late", to: juno, in: wa, query: q))
            return outs
        }
        t.eq(r?[0], .said("WhatsApp → Juno Park: running late · Enter again to send"))
        t.eq(r?[1], .said("Sent to c1"))
        t.eq(r?[2], .said("WhatsApp → Juno Park: running late · Enter again to send"))
        t.eq(r?[3], .said("WhatsApp → Juno Park: running later · Enter again to send"))
        t.eq(r?[4], .said("WhatsApp → Juno Park: running late · Enter again to send"))
        t.eq(l.trail.filter { $0.hasPrefix("apps.send") }, ["apps.send+proof"], "one send, and it carried the proof")
        t.eq(l.calls("apps.route").first?["to"] as? String, "c1", "the contact's id goes to vyred, not its name")
        t.eq((l.calls("apps.send").first?["args"] as? [String: Any])?["to"] as? String, "c1")
    }

    t.test("Enter: hiding the Capsule forgets a preview") {
        let l = link(route: rules)
        let r = t.wait { @MainActor () -> [ActionOutcome] in
            let ext = AppsExtension(host: AppsHost(l))
            await ext.refreshApps(l)
            let wa = ext.mentions(matching: "whats", context: .top)[0]
            await ext.readInside("WhatsApp", parent: wa.id, l)
            let kit = ext.mentions(matching: "kit", context: MentionContext(parent: wa, extensionID: "apps"))[0]
            let a = await ext.send("hi", to: kit, in: wa, query: Query("hi"))
            ext.capsuleDidHide()
            let b = await ext.send("hi", to: kit, in: wa, query: Query("hi"))
            return [a, b]
        }
        t.eq(r?[0], .said("WhatsApp → c4: hi · Enter again to send"))
        t.eq(r?[1], .said("WhatsApp → c4: hi · Enter again to send"))
        t.eq(l.calls("apps.send").count, 0)
    }

    t.test("Enter: any change to the words or chip, or a route that lands after hide, arms nothing") {
        let l = link(route: rules)
        let r = t.wait { @MainActor () -> [ActionOutcome] in
            let host = AppsHost(l)
            let ext = AppsExtension(host: host)
            await ext.refreshApps(l)
            let wa = ext.mentions(matching: "whats", context: .top)[0]
            await ext.readInside("WhatsApp", parent: wa.id, l)
            let kit = ext.mentions(matching: "kit", context: MentionContext(parent: wa, extensionID: "apps"))[0]
            var outs: [ActionOutcome] = []
            outs.append(await ext.send("hi", to: kit, in: wa, query: Query("hi")))
            // Edited and put back: the preview is gone, so this Enter only shows it again.
            ext.boxChanged()
            outs.append(await ext.send("hi", to: kit, in: wa, query: Query("hi")))
            // Hidden while the route was being asked: the answer shows nothing to confirm.
            ext.boxChanged()
            l.answer("apps.route") { i in
                DispatchQueue.main.sync { MainActor.assumeIsolated { ext.capsuleDidHide() } }
                return .success(rules(i))
            }
            outs.append(await ext.send("hi", to: kit, in: wa, query: Query("hi")))
            l.answer("apps.route") { .success(rules($0)) }
            outs.append(await ext.send("hi", to: kit, in: wa, query: Query("hi")))
            // A contact that is no longer in the list is not sent to by its name.
            outs.append(await ext.send("hi", to: MentionTarget(id: "in:WhatsApp:gone", label: "Juno Park", sendsTo: "WhatsApp"), in: wa, query: Query("hi")))
            return outs
        }
        t.eq(r?[0], .said("WhatsApp → c4: hi · Enter again to send"))
        t.eq(r?[1], .said("WhatsApp → c4: hi · Enter again to send"))
        t.eq(r?[2], .failed("The words changed. Press Enter to see the message again."))
        t.eq(r?[3], .said("WhatsApp → c4: hi · Enter again to send"))
        t.eq(r?[4], .failed("Juno Park is not in WhatsApp any more. Type @ to pick again."))
        t.eq(l.calls("apps.send").count, 0)
    }

    t.test("Enter: an unclear recipient is a question with Did you mean; an app with no words says so") {
        let l = link(route: rules)
        let r = t.wait { @MainActor () -> [ActionOutcome] in
            let ext = AppsExtension(host: AppsHost(l))
            await ext.refreshApps(l)
            let wa = ext.mentions(matching: "whats", context: .top)[0]
            let pos = ext.mentions(matching: "northwind", context: .top)[0]
            return [await ext.send("ammi dinner at 8?", to: wa, in: nil, query: Query("")),
                    await ext.send("two dozen rolls", to: pos, in: nil, query: Query(""))]
        }
        t.eq(r?[0], .said("Who should get this? Did you mean Ammi jee on WhatsApp? Type @ to pick."))
        t.eq(r?[1], .failed("Vyre has no words for Northwind Bakery POS yet"))
        t.eq(l.calls("apps.send").count + l.calls("apps.act").count, 0)
    }

    t.test("Enter: a Gate-held send runs through apps.act on the second Enter and gate.approve is the proof") {
        let l = link { i in
            ["app": "Slack", "action": "post", "args": ["to": i["to"] ?? "", "text": i["text"] ?? ""], "sends": true, "gated": true, "said": "Slack → #general: \(i["text"] ?? "")"]
        }
        l.answer("apps.act") { _ in .success(["held": ["id": "g7", "preview": "Slack → #general: shipped"]]) }
        l.answer("gate.approve") { i in .success(["said": "Posted in #general (\(i["id"] ?? ""))"]) }
        let r = t.wait { @MainActor () -> [ActionOutcome] in
            let ext = AppsExtension(host: AppsHost(l))
            await ext.refreshApps(l)
            let slack = ext.mentions(matching: "slack", context: .top)[0]
            await ext.readInside("Slack", parent: slack.id, l)
            let general = ext.mentions(matching: "juno", context: MentionContext(parent: slack, extensionID: "apps"))[0]
            return [await ext.send("shipped", to: general, in: slack, query: Query("")),
                    await ext.send("shipped", to: general, in: slack, query: Query(""))]
        }
        t.eq(r?[0], .said("Slack → #general: shipped · Enter again to send"))
        t.eq(r?[1], .said("Posted in #general (g7)"))
        t.eq(l.trail.suffix(2), ["apps.act", "gate.approve+proof"])
        t.eq(l.calls("apps.send").count, 0)
        // A gated route whose act comes back not held stops, never "Done".
        let l2 = link { i in ["app": "Slack", "action": "post", "args": ["to": i["to"] ?? "", "text": i["text"] ?? ""], "sends": true, "gated": true, "said": "Slack → #general: x"] }
        l2.answer("apps.act") { _ in .success(["said": "Posted"]) }
        let r2 = t.wait { @MainActor () -> ActionOutcome in
            let ext = AppsExtension(host: AppsHost(l2))
            await ext.refreshApps(l2)
            let slack = ext.mentions(matching: "slack", context: .top)[0]
            await ext.readInside("Slack", parent: slack.id, l2)
            let c = ext.mentions(matching: "", context: MentionContext(parent: slack, extensionID: "apps"))[0]
            _ = await ext.send("x", to: c, in: slack, query: Query(""))
            return await ext.send("x", to: c, in: slack, query: Query(""))
        }
        t.eq(r2, .failed("Slack did not hold the message for approval, so Vyre stopped. Check Slack before trying again."))
        t.eq(l2.calls("gate.approve").count, 0)
    }

    t.test("Enter: a send whose answer was lost is read in Slack before anything is said, and never approved twice") {
        /// One gated send through the extension: the act answers `held`, the approval `approve`, the check `sent`.
        func run(held: [String: Any], approve: [String: Any], sent: Bool) -> (ActionOutcome?, AppsLink) {
            let l = link { i in ["app": "Slack", "action": "send", "args": ["to": "#general", "text": i["text"] ?? ""], "sends": true, "gated": true, "said": "Slack → #general: \(i["text"] ?? "")"] }
            l.answer("apps.act") { i in (i["action"] as? String) == "sent" ? .success(["sent": sent]) : .success(["held": held]) }
            l.answer("gate.approve") { _ in .success(approve) }
            let r = t.wait { @MainActor () -> ActionOutcome in
                let ext = AppsExtension(host: AppsHost(l))
                await ext.refreshApps(l)
                let slack = ext.mentions(matching: "slack", context: .top)[0]
                await ext.readInside("Slack", parent: slack.id, l)
                let c = ext.mentions(matching: "", context: MentionContext(parent: slack, extensionID: "apps"))[0]
                _ = await ext.send("shipped", to: c, in: slack, query: Query(""))
                return await ext.send("shipped", to: c, in: slack, query: Query(""))
            }
            return (r, l)
        }
        let (lost, l1) = run(held: ["id": "g7", "at": 1790503200000], approve: ["id": "g7", "state": "failed", "error": "closed"], sent: true)
        t.eq(lost, .said("It went out: Slack → #general: shipped"))
        let check = l1.calls("apps.act").last
        t.eq((check?["args"] as? [String: Any])?["since"] as? Double, 1790503200000, "only posts since it was held count")
        let (gone, _) = run(held: ["id": "g7"], approve: ["id": "g7", "state": "failed", "error": "closed"], sent: false)
        t.eq(gone, .failed("Slack did not answer, so it may not have gone. It waits at the Gate: press Enter to try again."))
        // The same item again after a failed approval: checked first, and not approved when it went out.
        let (tried, l3) = run(held: ["id": "g7", "tried": true], approve: ["id": "g7", "state": "sent"], sent: true)
        t.eq(tried, .said("It went out already: Slack → #general: shipped"))
        t.eq(l3.calls("gate.approve").count, 0)
    }

    t.test("Enter: with no apps module on this Vyre, it says so") {
        let l = AppsLink()
        let out = t.wait { @MainActor () -> ActionOutcome in
            let ext = AppsExtension(host: AppsHost(l))
            return await ext.send("hi", to: MentionTarget(id: "app:Notes", label: "Notes", sendsTo: "Notes"), in: nil, query: Query("hi"))
        }
        t.eq(out, .failed("The apps module is not on this Vyre yet."))
    }

    t.test("words without @: only app-like words are asked about, and each route is one row") {
        t.ok(AppsWordsProvider.looksLikeApps("timer 10 min")); t.ok(AppsWordsProvider.looksLikeApps("10 min"))
        t.ok(AppsWordsProvider.looksLikeApps("remind me to call juno at 6")); t.ok(AppsWordsProvider.looksLikeApps("WhatsApp juno: hi"))
        t.ok(!AppsWordsProvider.looksLikeApps("northwind bakery hours")); t.ok(!AppsWordsProvider.looksLikeApps("tim"))
        let l = link(route: { i in
            let text = i["text"] as? String ?? ""
            if text.hasPrefix("timer") { return ["app": "Planner", "action": "add", "args": ["text": text, "kind": "timer"], "sends": false, "said": "Timer for 10 minutes"] }
            if text.hasPrefix("whatsapp") { return ["app": "WhatsApp", "action": "send", "args": ["to": "kit", "text": "hi"], "sends": true, "said": "WhatsApp → kit: hi"] }
            if text.hasPrefix("tell") { return ["ambiguous": true, "reason": "which app?", "ask": "Which app?", "text": "hi", "action": "send", "needs": ["app": [["name": "WhatsApp"], ["name": "Messages"]]]] }
            return ["ambiguous": true, "reason": "remind you of what?"]
        })
        l.answer("apps.act") { _ in .success(["said": "Timer set for 10 minutes"]) }
        let p = AppsWordsProvider(vyred: l)
        let r = t.wait { () -> [String] in
            var out: [String] = []
            for q in ["timer 10 min", "whatsapp kit: hi", "tell kit hi", "remind me to", "northwind bakery hours"] {
                let rows = await p.results(for: Query(q))
                out.append(rows.map { "\($0.title)|\($0.subtitle)|\($0.actions.first?.confirm ?? "-")" }.joined(separator: ";"))
            }
            let timer = await p.results(for: Query("timer 10 min"))[0]
            let done = await timer.actions[0].run(timer, ActionContext(query: Query("")))
            let send = await p.results(for: Query("whatsapp kit: hi"))[0]
            let sent = await send.actions[0].run(send, ActionContext(query: Query("")))
            out.append("\(done)"); out.append("\(sent)")
            return out
        }
        t.eq(r?[0], "Timer for 10 minutes|Vyre's planner|-", "no confirm for the person's own timer")
        t.eq(r?[1], "WhatsApp → kit: hi|sends as you, through WhatsApp|WhatsApp → kit: hi · Enter again to send")
        t.eq(r?[2], "Which app?|WhatsApp, Messages|-")
        t.eq(r?[3], "", "half-typed words: no row")
        t.eq(r?[4], "", "not app words: nothing asked")
        t.eq(r?[5], "said(\"Timer set for 10 minutes\")")
        t.eq(r?[6], "said(\"Sent to kit\")")
        t.eq(l.calls("apps.route").count, 6, "northwind bakery hours never reached vyred")
        t.eq(l.trail.filter { $0.hasPrefix("apps.send") }, ["apps.send+proof"])
    }
}
