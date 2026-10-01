// The row for words typed without `@` ("timer 10 min", "remind me to call juno at 6", "whatsapp
// juno: running late"): the apps extension's provider. Words that start like an app phrase go to
// apps.route (vyred on this Mac, which reads the time with the planner's parser); what it places
// becomes one row, "Timer for 10 minutes · Planner". Enter on a row that sends nothing runs it
// through apps.act. A row that sends is a preview: the first Enter shows "Enter again to send"
// through the Capsule's own confirm (any key forgets it), the second sends it through apps.send
// with the person's proof. An unclear app or recipient is a row that asks, never nothing. Words
// that start like nothing an app does never leave the Capsule.

import Foundation

final class AppsWordsProvider: ResultProvider, @unchecked Sendable {
    let id = "apps-words"
    let speed: Speed = .full
    private let vyred: VyredLink
    init(vyred: VyredLink) { self.vyred = vyred }

    var sendsQuery: String? { "Vyre on this Mac (apps), for words like \"timer 10 min\"" }

    /// The first words of an app phrase. Anything else is not asked about.
    nonisolated static func looksLikeApps(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard t.count >= 4, t.count <= 2000 else { return false }
        let starts = ["timer", "alarm", "wake me", "remind me", "reminder", "todo", "to do", "to-do", "note", "weather",
                      "whatsapp ", "slack ", "tell ", "message ", "text ", "msg ", "set a timer", "set an alarm", "set timer",
                      "set alarm", "start a timer", "add "]
        if starts.contains(where: { t.hasPrefix($0) }) { return true }
        // "10 min timer", "5 min".
        return t.range(of: #"^\d+(\.\d+)?\s*(h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)\b"#, options: .regularExpression) != nil
    }

    func results(for query: Query) async -> [ResultItem] {
        guard Self.looksLikeApps(query.text), vyred.has("apps.route") else { return [] }
        let words = query.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let r = await vyred.call("apps.route", ["text": words])
        guard !Task.isCancelled, r.error == nil else { return [] }
        return Self.rows(AppsRoute.from(r.data), words: words, vyred: vyred)
    }

    /// The row for a route. Internal so a test can check it without vyred.
    nonisolated static func rows(_ route: AppsRoute, words: String, vyred: VyredLink) -> [ResultItem] {
        switch route {
        case .unsure:
            // Half-typed words ("remind me to") are unsure on every key: no row until they place.
            return []
        case .ask(let ask, let dym, let names):
            let line = AppsRoute.question(ask, dym, names).replacingOccurrences(of: " Type @ to pick.", with: " Say it with @ and the name.")
            return [ResultItem(id: "apps:ask", kind: "apps", title: ask, subtitle: dym ?? (names.isEmpty ? "Say who, with @" : names.prefix(3).joined(separator: ", ")),
                               icon: .symbol("questionmark.bubble"), section: .commands, score: 0.9,
                               actions: [ResultAction(id: "ask", title: "Ask", symbol: "questionmark") { _, _ in .said(line) }])]
        case .action(let app, let action, let args, let sends, let gated, let said):
            let input = UncheckedBox(["app": app, "action": action, "args": args])
            let via = app == "Planner" ? "Vyre's planner" : app
            if !sends {
                return [ResultItem(id: "apps:act:\(app):\(action)", kind: "apps", title: said, subtitle: via, icon: icon(app, action),
                                   section: .commands, score: 0.95,
                                   actions: [ResultAction(id: "run", title: "Do it", symbol: "return") { _, _ in
                                       let r = await vyred.call("apps.act", input.value)
                                       if let why = r.error { return .failed(why) }
                                       return .said(VJ.nonEmpty((r.data as? [String: Any])?["said"]) ?? "Done in \(app).")
                                   }], sendsTo: via)]
            }
            // The id carries the words, so the Capsule's confirm belongs to this exact message.
            return [ResultItem(id: "apps:send:\(app):\(words)", kind: "apps", title: said, subtitle: "sends as you, through \(app)",
                               icon: icon(app, action), section: .commands, score: 0.95,
                               actions: [ResultAction(id: "send", title: "Send", symbol: "paperplane", confirm: "\(said) · Enter again to send") { _, _ in
                                   await commit(input, app: app, gated: gated, said: said, vyred: vyred)
                               }], sendsTo: app)]
        }
    }

    /// apps.send with the proof, or for a Gate-held send apps.act then gate.approve as the proof.
    nonisolated static func commit(_ input: UncheckedBox, app: String, gated: Bool, said: String, vyred: VyredLink) async -> ActionOutcome {
        if gated {
            let r = await vyred.call("apps.act", input.value)
            if let why = r.error { return .failed(why) }
            return await approveHeld(r.data, input: input.value, app: app, said: said, vyred: vyred) { id in
                await vyred.call("gate.approve", ["id": id], presence: true, summary: said)
            }
        }
        let r = await vyred.call("apps.send", input.value, presence: true, summary: said)
        if let why = r.error { return .failed(why) }
        return .said(VJ.nonEmpty((r.data as? [String: Any])?["said"]) ?? "Sent through \(app).")
    }

    /// A held message, approved with the person's proof (`prove`), never posted twice. An item
    /// whose earlier approval failed (`tried`), or an approval that comes back failed with
    /// `reached: "maybe"` (the app's server dropped mid-send), may have gone out: the app's `sent`
    /// check reads it first, and when the words are there the item is settled as sent at the Gate
    /// (gate.settle, with what the app showed) and "It went out" is the answer. `reached: "no"`
    /// means it did not go. Either way an unsent message waits at the Gate, and Enter again finds
    /// that same item (apps.act answers `again`), so nothing is held twice.
    nonisolated static func approveHeld(_ data: Any?, input: [String: Any], app: String, said: String, vyred: VyredLink,
                                        prove: (String) async -> VyredResult) async -> ActionOutcome {
        guard let held = (data as? [String: Any])?["held"] as? [String: Any], let id = VJ.nonEmpty(held["id"]) else {
            return .failed("\(app) did not hold the message for approval, so Vyre stopped. Check \(app) before trying again.")
        }
        let args = (input["args"] as? [String: Any]) ?? [:]
        let wentOut: () async -> Bool = {
            var check: [String: Any] = ["to": args["to"] ?? "", "text": args["text"] ?? ""]
            if let thread = args["thread"] { check["thread"] = thread }
            if let at = VJ.num(held["at"]) { check["since"] = at }
            let s = await vyred.call("apps.act", ["app": app, "action": "sent", "args": check])
            guard let d = s.data as? [String: Any], VJ.bool(d["sent"]) == true else { return false }
            var evidence: [String: Any] = ["app": app]
            if let ts = VJ.nonEmpty(d["ts"]) { evidence["ts"] = ts }
            _ = await vyred.call("gate.settle", ["id": id, "outcome": "sent", "evidence": evidence])
            return true
        }
        if VJ.bool(held["tried"]) == true, await wentOut() { return .said("It went out already: \(said)") }
        let g = await prove(id)
        if let why = g.error { return .failed(why) }
        let d = (g.data as? [String: Any]) ?? [:]
        guard (d["state"] as? String) == "failed" else { return .said(VJ.nonEmpty(d["said"]) ?? "Sent through \(app).") }
        if (d["reached"] as? String) == "no" {
            return .failed("\(app) could not be reached, so nothing went. It waits at the Gate: press Enter to try again.")
        }
        if await wentOut() { return .said("It went out: \(said)") }
        return .failed("\(app) did not answer, so it may not have gone. It waits at the Gate: press Enter to try again.")
    }

    nonisolated static func icon(_ app: String, _ action: String) -> IconSpec {
        switch action {
        case "timer": return .symbol("timer")
        case "alarm": return .symbol("alarm")
        case "send", "post": return .symbol("paperplane")
        default: break
        }
        switch app {
        case "Planner": return .symbol("checklist")
        case "Notes": return .bundle("com.apple.Notes")
        case "Reminders": return .bundle("com.apple.reminders")
        case "Weather": return .bundle("com.apple.weather")
        default: return .symbol("app")
        }
    }
}
