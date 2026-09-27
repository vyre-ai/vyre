// apps: every Mac app as an `@` target (ADR 0022). The vyred module `apps` (local/apps) does the
// work; this extension only asks it, as the "capsule" caller, and shows what came back.
//
//   - `@` lists the apps on this Mac (apps.list, read once per showing of the Capsule, no mdfind)
//     with their own icons. An app Vyre has words for says what it does; one that holds people or
//     notes (nests) becomes a chip, and a second `@` lists what is inside it (apps.targets, read
//     into memory when the chip is picked and refreshed once for the words typed).
//   - Enter routes the words through apps.route, scoped to the chip. What sends nothing (a timer,
//     a note, the weather) runs at once through apps.act: no prompt for the person's own things.
//     What sends as the person is shown first ("WhatsApp → juno: running late · Enter again to
//     send"); the second Enter on the same words sends it through apps.send with the person's
//     proof, or, for an action held at the Gate (Slack), approves the held item with gate.approve.
//   - When the app or who is unclear, the answer is a question with "Did you mean ...?" and the
//     candidates, never nothing.
// Nothing polls and nothing runs while the Capsule is hidden; a preview is forgotten on hide.

import AppKit
import Foundation

/// An app from apps.list, as the picker shows it.
struct AppRow: Equatable {
    var name: String
    var bundleId: String?
    var path: String
    var tier: String
    /// What Vyre can do in it; empty for an app it has no words for yet.
    var actions: [String]
    var nests: Bool

    static func from(_ data: Any?) -> [AppRow] {
        guard let d = data as? [String: Any], let rows = d["apps"] as? [[String: Any]] else { return [] }
        return rows.compactMap { r in
            guard let name = VJ.nonEmpty(r["name"]), let path = VJ.nonEmpty(r["path"]) else { return nil }
            return AppRow(name: name, bundleId: VJ.nonEmpty(r["bundleId"]), path: path, tier: VJ.nonEmpty(r["tier"]) ?? "ax",
                          actions: (r["actions"] as? [String]) ?? [], nests: VJ.bool(r["nests"]) ?? false)
        }
    }

    /// The few words under the name.
    var sub: String {
        if actions.isEmpty { return "Vyre has no words for it yet" }
        if actions.contains("send") { return "messages" }
        return actions.prefix(3).joined(separator: ", ")
    }
}

/// What apps.route answered, cut down to what the Capsule acts on. The args go back to vyred as
/// they came (numbers stay numbers).
enum AppsRoute: @unchecked Sendable {
    /// One action, and whether it sends as the person. `gated`: held at the Gate first (Slack).
    case action(app: String, action: String, args: [String: Any], sends: Bool, gated: Bool, said: String)
    /// A question: what it asks, the Did you mean line, and the names to pick between.
    case ask(ask: String, didYouMean: String?, names: [String])
    /// The words could not be placed, and why.
    case unsure(String)

    static func from(_ data: Any?) -> AppsRoute {
        guard let d = data as? [String: Any] else { return .unsure("apps.route said nothing.") }
        if let needs = d["needs"] as? [String: Any] {
            let names: [String]
            if let apps = needs["app"] as? [[String: Any]] { names = apps.compactMap { VJ.nonEmpty($0["name"]) } }
            else { names = ((needs["recipient"] as? [[String: Any]]) ?? []).compactMap { VJ.nonEmpty($0["title"]) } }
            return .ask(ask: VJ.nonEmpty(d["ask"]) ?? "Who should get this?", didYouMean: VJ.nonEmpty(d["didYouMean"]), names: names)
        }
        if VJ.truthy(d["ambiguous"]) { return .unsure(VJ.nonEmpty(d["reason"]) ?? "Not sure what to do with that.") }
        guard let app = VJ.nonEmpty(d["app"]), let action = VJ.nonEmpty(d["action"]) else { return .unsure("apps.route said nothing.") }
        return .action(app: app, action: action, args: (d["args"] as? [String: Any]) ?? [:], sends: VJ.bool(d["sends"]) ?? true, gated: VJ.truthy(d["gated"]),
                       said: VJ.nonEmpty(d["said"]) ?? "\(app) \(action)")
    }

    /// A question in one line: "Who should get this? Did you mean Ammi jee on WhatsApp?" or the
    /// names to pick between, and how to pick.
    static func question(_ ask: String, _ didYouMean: String?, _ names: [String]) -> String {
        if let d = didYouMean { return "\(ask) \(d) Type @ to pick." }
        if names.isEmpty { return "\(ask) Type @ to pick, or say the name." }
        let shown = names.prefix(3)
        let list = shown.count == 1 ? shown[0] : shown.dropLast().joined(separator: ", ") + " or " + shown.last!
        return "\(ask) \(list)\(names.count > 3 ? ", or \(names.count - 3) more" : "")? Type @ to pick."
    }
}

// capsule-extension: AppsExtension
@MainActor
final class AppsExtension: CapsuleExtension {
    static let id = "apps"
    private let host: CapsuleHost
    private var vyred: VyredLink? { host.vyred }

    /// The apps from the last apps.list, read once each time the Capsule shows.
    private(set) var apps: [AppRow] = []
    private var listing: Task<Void, Never>?
    /// What is inside each app (contacts, notes), by app name, read when its chip is picked.
    private(set) var inside: [String: [MentionTarget]] = [:]
    /// The raw ids apps.targets gave, by our target id.
    private var rawIDs: [String: String] = [:]
    private var reading: Task<Void, Never>?
    /// A send shown and waiting for the second Enter: the words, where, and the route. Forgotten
    /// when the words or the chip change (boxChanged), on hide, and after previewFor.
    private(set) var pending: (key: String, route: AppsRoute, at: Date)?
    /// How long a preview waits for its second Enter.
    static let previewFor: TimeInterval = 60
    /// Bumped on every hide and box change: a route that lands after one never arms a preview.
    private var generation = 0
    /// A route or a send in flight: another Enter meanwhile is not a second Enter.
    private var busy = false

    init(host: CapsuleHost) { self.host = host }

    var refreshesMentions: Bool { true }

    func capsuleWillShow(front: FrontApp?) { loadApps() }

    func capsuleDidHide() {
        listing?.cancel(); listing = nil
        reading?.cancel(); reading = nil
        pending = nil; generation += 1
    }

    func boxChanged() { pending = nil; generation += 1 }

    /// apps.list, once per showing; the rows stay for the next `@` from memory.
    func loadApps() {
        guard listing == nil, let v = vyred, v.has("apps.list") else { return }
        listing = Task { [weak self] in await self?.refreshApps(v) }
    }

    func refreshApps(_ v: VyredLink) async {
        let r = await v.call("apps.list", ["limit": 100])
        guard !Task.isCancelled else { return }
        // A failure is tried again at the next `@`, not left until the next showing.
        guard r.error == nil else { listing = nil; return }
        apps = AppRow.from(r.data)
    }

    // MARK: @

    func target(_ a: AppRow) -> MentionTarget {
        MentionTarget(id: "app:" + a.name, label: a.name, sub: a.sub, icon: .file(a.path),
                      sendsTo: a.actions.isEmpty ? "\(a.name), which Vyre has no words for yet" : "\(a.name) on this Mac", nests: a.nests)
    }

    func mentions(matching query: String, context: MentionContext) -> [MentionTarget] {
        if let p = context.parent {
            guard let app = appName(p) else { return [] }
            return filter(inside[app] ?? [], query)
        }
        // vyred's tools may not have been read when the Capsule showed: ask again, without waiting.
        if apps.isEmpty { loadApps() }
        let q = query.trimmingCharacters(in: .whitespaces)
        let known = apps.filter { !$0.actions.isEmpty }
        let rows = q.isEmpty ? known : apps
        let scored: [(AppRow, Double)] = rows.map { ($0, q.isEmpty ? 1 : Match.score(q, $0.name)) }.filter { $0.1 >= 0.5 }
        // Apps Vyre can work in come first, then the best names.
        let best = scored.sorted { (x: (AppRow, Double), y: (AppRow, Double)) -> Bool in
            if x.0.actions.isEmpty != y.0.actions.isEmpty { return !x.0.actions.isEmpty }
            if x.1 != y.1 { return x.1 > y.1 }
            return x.0.name.lowercased() < y.0.name.lowercased()
        }
        return best.prefix(8).map { target($0.0) }
    }

    func refreshMentions(matching query: String, context: MentionContext) async -> [MentionTarget]? {
        guard let p = context.parent, let app = appName(p), let v = vyred else { return nil }
        let r = await v.call("apps.targets", ["app": app, "q": query.trimmingCharacters(in: .whitespaces), "limit": 20])
        guard !Task.isCancelled, r.error == nil else { return nil }
        return targets(r.data, app: app, parent: p.id)
    }

    func mentionPicked(_ target: MentionTarget, context: MentionContext) {
        guard context.parent == nil, target.nests, let app = appName(target), let v = vyred else { return }
        reading?.cancel()
        reading = Task { [weak self] in await self?.readInside(app, parent: target.id, v) }
    }

    /// What is inside an app, into memory, so the next `@` under its chip answers at once.
    func readInside(_ app: String, parent: String, _ v: VyredLink) async {
        let r = await v.call("apps.targets", ["app": app, "q": "", "limit": 50])
        guard !Task.isCancelled, r.error == nil else { return }
        inside[app] = targets(r.data, app: app, parent: parent)
    }

    private func targets(_ data: Any?, app: String, parent: String) -> [MentionTarget] {
        let rows = ((data as? [String: Any])?["targets"] as? [[String: Any]]) ?? []
        return rows.compactMap { t in
            guard let id = VJ.nonEmpty(t["id"]), let title = VJ.nonEmpty(t["title"]) else { return nil }
            let mine = "in:\(app):\(id)"
            rawIDs[mine] = id
            return MentionTarget(id: mine, label: title, sub: VJ.nonEmpty(t["kind"]) ?? "in \(app)", icon: .symbol("person.crop.circle"),
                                 sendsTo: "\(title) on \(app)", parentID: parent)
        }
    }

    private func filter(_ rows: [MentionTarget], _ query: String) -> [MentionTarget] {
        let q = query.trimmingCharacters(in: .whitespaces)
        if q.isEmpty { return Array(rows.prefix(8)) }
        let scored: [(MentionTarget, Double)] = rows.map { ($0, Match.score(q, $0.label)) }.filter { $0.1 >= 0.5 }
        let best = scored.sorted { (x: (MentionTarget, Double), y: (MentionTarget, Double)) -> Bool in
            if x.1 != y.1 { return x.1 > y.1 }
            return x.0.label.lowercased() < y.0.label.lowercased()
        }
        return best.prefix(8).map(\.0)
    }

    /// The app a target of ours names: "app:WhatsApp" is WhatsApp.
    private func appName(_ t: MentionTarget) -> String? {
        t.id.hasPrefix("app:") ? String(t.id.dropFirst(4)) : nil
    }

    // MARK: Enter

    func send(_ text: String, to target: MentionTarget, in parent: MentionTarget?, query: Query) async -> ActionOutcome {
        guard let v = vyred else { return .failed("vyred is not running.") }
        guard v.has("apps.route") else { return .failed("The apps module is not on this Vyre yet.") }
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let app = appName(parent ?? target) else { return .failed("\(target.label) is not an app Vyre knows.") }
        // A child is sent to by the id its app gave, never by a name vyred might match to another.
        var child: String?
        if parent != nil {
            guard let id = rawIDs[target.id] else { return .failed("\(target.label) is not in \(app) any more. Type @ to pick again.") }
            child = id
        }
        let key = "\(app)\u{0}\(child ?? "")\u{0}\(words)"
        guard !busy else { return .said("One moment: the last one is still going.") }
        busy = true
        defer { busy = false }

        // The second Enter on the same words, while its preview is fresh: send it.
        if let p = pending, p.key == key, Date().timeIntervalSince(p.at) < Self.previewFor {
            pending = nil
            return await commit(p.route, v)
        }
        pending = nil

        var input: [String: Any] = ["text": words, "app": app]
        if let c = child { input["to"] = c }
        let gen = generation
        let r = await v.call("apps.route", input)
        if let why = r.error { return .failed(why) }
        let route = AppsRoute.from(r.data)
        switch route {
        case .unsure(let why): return .failed(why)
        case .ask(let ask, let dym, let names): return .said(AppsRoute.question(ask, dym, names))
        case .action(_, _, _, let sends, _, let said):
            if !sends { return await commit(route, v) }
            // Hidden, or other words, while the route was asked: show nothing to confirm.
            guard gen == generation, host.isShown else { return .failed("The words changed. Press Enter to see the message again.") }
            pending = (key, route, Date())
            return .said("\(said) · Enter again to send")
        }
    }

    /// Run a route: apps.act for what sends nothing, apps.send with the person's proof for what
    /// sends, apps.act then gate.approve (the proof) for what the Gate holds.
    private func commit(_ route: AppsRoute, _ v: VyredLink) async -> ActionOutcome {
        guard case .action(let app, let action, let args, let sends, let gated, _) = route else { return .failed("Nothing to send.") }
        let input: [String: Any] = ["app": app, "action": action, "args": args]
        if !sends || gated {
            let r = await v.call("apps.act", input)
            if let why = r.error { return .failed(why) }
            let d = (r.data as? [String: Any]) ?? [:]
            if gated && d["held"] == nil { return .failed("\(app) did not hold the message for approval, so Vyre stopped. Check \(app) before trying again.") }
            if let held = d["held"] as? [String: Any] {
                guard let id = VJ.nonEmpty(held["id"]) else { return .failed("\(app) held the message but gave no id to approve.") }
                let g = await v.call("gate.approve", ["id": id], presence: true)
                if let why = g.error { return .failed(why) }
                return .said(VJ.nonEmpty((g.data as? [String: Any])?["said"]) ?? "Sent through \(app).")
            }
            return .said(VJ.nonEmpty(d["said"]) ?? "Done in \(app).")
        }
        let r = await v.call("apps.send", input, presence: true)
        if let why = r.error { return .failed(why) }
        return .said(VJ.nonEmpty((r.data as? [String: Any])?["said"]) ?? "Sent through \(app).")
    }
}
