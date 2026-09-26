// capsule-suite: extensionNestSuite
// `@` inside an app: an extension's target that nests (WhatsApp) becomes a chip, a second `@` asks
// that extension alone for what it holds (juno, kit), the pick is a two-level chip, Enter sends to
// the child with its parent, and delete unwinds the child, then the chip. The slower second answer
// (refreshMentions) replaces the rows only for the same words and never runs while hidden.

import Foundation

@MainActor
final class ChatProbe: CapsuleExtension {
    static let id = "chatprobe"
    /// "words|parent id|extension id" for every synchronous ask.
    static var asked: [String] = []
    static var sent: [String] = []
    static var picked: [String] = []
    /// Words each refreshMentions was called with, and the words a test lets through.
    static var refreshCalls: [String] = []
    static var release = Set<String>()
    static var refreshing = false

    static func reset() { asked = []; sent = []; picked = []; refreshCalls = []; release = []; refreshing = false }

    static let app = MentionTarget(id: "whatsapp", label: "WhatsApp", sub: "app", icon: .symbol("message"),
                                   sendsTo: "WhatsApp", nests: true)
    init(host: CapsuleHost) {}

    func mentions(matching query: String, context: MentionContext) -> [MentionTarget] {
        Self.asked.append("\(query)|\(context.parent?.id ?? "-")|\(context.extensionID ?? "-")")
        if let p = context.parent {
            guard p.id == Self.app.id else { return [] }
            return ["juno", "kit"].filter { query.isEmpty || $0.hasPrefix(query.lowercased()) }
                .map { MentionTarget(id: $0, label: $0, sub: "in WhatsApp", sendsTo: "WhatsApp", parentID: p.id) }
        }
        return query.isEmpty || "whatsapp".hasPrefix(query.lowercased()) ? [Self.app] : []
    }

    func refreshMentions(matching query: String, context: MentionContext) async -> [MentionTarget]? {
        guard Self.refreshing, context.parent != nil else { return nil }
        Self.refreshCalls.append(query)
        // A cancelled sleep returns at once, so the loop checks for cancellation too.
        while !Self.release.contains(query) && !Task.isCancelled { try? await Task.sleep(nanoseconds: 5_000_000) }
        return [MentionTarget(id: "fresh-\(query)", label: "fresh:\(query)", sendsTo: "WhatsApp", parentID: "whatsapp")]
    }

    func mentionPicked(_ target: MentionTarget, context: MentionContext) {
        Self.picked.append("\(target.id)@\(context.parent?.id ?? "-")")
    }

    func send(_ text: String, to target: MentionTarget, in parent: MentionTarget?, query: Query) async -> ActionOutcome {
        Self.sent.append("\(parent?.label ?? "-") > \(target.label): \(text)")
        return .said("Sent to \(target.label) on WhatsApp")
    }
}

/// Poll a main-actor condition for up to 5 s.
private func soon(_ cond: @escaping @MainActor () -> Bool) async -> Bool {
    for _ in 0..<250 { if await MainActor.run(body: cond) { return true }; try? await Task.sleep(nanoseconds: 20_000_000) }
    return false
}

private func pause(_ ms: UInt64) async { try? await Task.sleep(nanoseconds: ms * 1_000_000) }

/// A model with NotesProbe and ChatProbe loaded and an agent named juno in Vyre, no vyred.
@MainActor private func world(_ name: String) -> (CapsuleModel, ExtensionHost) {
    let m = CapsuleModel(home: vyScratch("nest-\(name)-\(UUID().uuidString.prefix(6))"),
                         vyred: VyredClient(socket: vyScratch("x") + "/none.sock"), providers: [])
    let h = ExtensionHost(model: m)
    ChatProbe.reset(); NotesProbe.sent = []
    h.load([NotesProbe.self, ChatProbe.self])
    m.catalog = VyreCatalog(agents: [VyreAgent(name: "juno", kind: "assistant")])
    return (m, h)
}

/// Type "@wha" and pick WhatsApp: the nesting chip.
private func chipWhatsApp(_ m: CapsuleModel) async {
    await MainActor.run { m.text = "@wha"; m.run() }
    _ = await soon { m.target != nil }
}

let extensionNestSuite = Suite("extension nesting") { t in
    t.test("an old-style extension is asked through the default, with no chip only") {
        let r: [String]? = t.wait {
            await MainActor.run {
                let (m, h) = world("flat")
                m.text = "@"
                let rows = m.flat.map(\.title)
                let notes = NotesProbe(host: h)
                let inside = notes.mentions(matching: "", context: MentionContext(parent: ChatProbe.app, extensionID: "chatprobe")).count
                let top = notes.mentions(matching: "no", context: .top).map(\.label)
                return rows + ["\(inside)"] + top + ChatProbe.asked
            }
        }
        t.eq(r, ["juno", "Notes", "WhatsApp", "0", "Notes", "|-|-"])
    }

    t.test("old-style send is reached through send(_:to:in:query:)") {
        let r: [String]? = t.wait {
            let notes = await MainActor.run { () -> NotesProbe in NotesProbe.sent = []; return NotesProbe(host: world("fwd").1) }
            let target = MentionTarget(id: "notes", label: "Notes", sendsTo: "Notes on this Mac")
            let out = await notes.send("proof the Northwind menu", to: target, in: nil, query: Query("proof the Northwind menu"))
            return await MainActor.run { NotesProbe.sent + ["\(out)"] }
        }
        t.eq(r?.first, "notes: proof the Northwind menu")
    }

    t.test("a second @ inside a nesting chip asks only its extension, with the chip as parent") {
        let r: [String]? = t.wait {
            let (m, h) = await MainActor.run { world("inner") }
            await chipWhatsApp(m)
            let chip = await MainActor.run { [m.target?.label ?? "", m.text, "\(m.nestingChip != nil)"] }
            await MainActor.run { ChatProbe.asked = []; m.text = "@" }
            let all = await MainActor.run { m.flat.map(\.title) }
            await MainActor.run { m.text = "@ju" }
            let some = await MainActor.run { m.flat.map(\.title) }
            let asked = await MainActor.run { withExtendedLifetime(h) { ChatProbe.asked } }
            return chip + all + some + asked
        }
        t.eq(r, ["WhatsApp", "", "true", "juno", "kit", "juno", "|whatsapp|chatprobe", "ju|whatsapp|chatprobe"])
    }

    t.test("a child makes a two-level chip; Enter sends to it with its parent; picks are told once each") {
        let r: [String]? = t.wait {
            let (m, h) = await MainActor.run { world("send") }
            await chipWhatsApp(m)
            let first = await MainActor.run { ChatProbe.picked }
            await MainActor.run { m.text = "@ju"; m.run() }
            _ = await soon { m.targetParent != nil }
            let chip = await MainActor.run { [m.targetParent?.label ?? "", m.target?.label ?? "", m.text] }
            await MainActor.run { m.text = "the bakery opens at nine" }
            let via = await MainActor.run { m.current?.sendsTo ?? "" }
            await MainActor.run { m.run() }
            _ = await soon { m.line != nil }
            let line = await MainActor.run { m.line ?? "" }
            let out = await MainActor.run { withExtendedLifetime(h) { ChatProbe.sent + ChatProbe.picked } }
            return first + chip + [via, line] + out
        }
        t.eq(r, ["whatsapp@-", "WhatsApp", "juno", "", "WhatsApp", "Sent to juno on WhatsApp",
                 "WhatsApp > juno: the bakery opens at nine", "whatsapp@-", "juno@whatsapp"])
    }

    t.test("delete on an empty box drops the child, then the chip") {
        let r: [String]? = t.wait {
            let (m, h) = await MainActor.run { world("unwind") }
            await chipWhatsApp(m)
            await MainActor.run { m.text = "@kit"; m.run() }
            _ = await soon { m.targetParent != nil }
            return await MainActor.run { () -> [String] in
                var out = ["\(m.targetParent?.label ?? "-") > \(m.target?.label ?? "-")"]
                m.dropChip()
                out.append("\(m.targetParent?.label ?? "-") > \(m.target?.label ?? "-") nests:\(m.nestingChip != nil)")
                m.dropChip()
                out.append("\(m.targetParent?.label ?? "-") > \(m.target?.label ?? "-")")
                return withExtendedLifetime(h) { out }
            }
        }
        t.eq(r, ["WhatsApp > kit", "- > WhatsApp nests:true", "- > -"])
    }

    t.test("a refresh replaces the rows for the same words and is dropped when the words changed") {
        let r: [String]? = t.wait {
            let (m, h) = await MainActor.run { world("refresh") }
            await chipWhatsApp(m)
            await MainActor.run { ChatProbe.refreshing = true; m.text = "@j" }
            _ = await soon { ChatProbe.refreshCalls == ["j"] }
            let before = await MainActor.run { m.flat.map(\.title) }
            await MainActor.run { _ = ChatProbe.release.insert("j") }
            _ = await soon { m.flat.map(\.title) == ["fresh:j"] }
            let same = await MainActor.run { m.flat.map(\.title) }
            // Changed while in flight: the answer for "k" is let through only after "ki" is typed.
            await MainActor.run { m.text = "@k" }
            _ = await soon { ChatProbe.refreshCalls == ["j", "k"] }
            await MainActor.run { m.text = "@ki"; ChatProbe.release.insert("k") }
            await pause(250)
            let changed = await MainActor.run { m.flat.map(\.title) }
            await MainActor.run { _ = ChatProbe.release.insert("ki") }
            _ = await soon { m.flat.map(\.title) == ["fresh:ki"] }
            let last = await MainActor.run { withExtendedLifetime(h) { m.flat.map(\.title) } }
            return before + ["|"] + same + ["|"] + changed + ["|"] + last
        }
        t.eq(r, ["juno", "|", "fresh:j", "|", "kit", "|", "fresh:ki"])
    }

    t.test("hide cancels a refresh, waiting or in flight") {
        let r: [String]? = t.wait {
            let (m, h) = await MainActor.run { world("hide") }
            await chipWhatsApp(m)
            // Waiting out the 120 ms: never asked.
            await MainActor.run { ChatProbe.refreshing = true; m.text = "@j"; m.didHide() }
            await pause(300)
            let waiting = await MainActor.run { ChatProbe.refreshCalls.joined(separator: ",") }
            // In flight: its answer is dropped.
            await MainActor.run { m.text = "@k" }
            _ = await soon { ChatProbe.refreshCalls == ["k"] }
            await MainActor.run { m.didHide(); ChatProbe.release.insert("k") }
            await pause(250)
            let rows = await MainActor.run { withExtendedLifetime(h) { m.flat.map(\.title) } }
            return ["asked:" + waiting] + rows
        }
        t.eq(r, ["asked:", "kit"])
    }
}
