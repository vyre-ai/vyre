// capsule-suite: extensionNestSuite
// `@` inside an app: an extension's target that nests (WhatsApp) becomes a chip, a second `@` asks
// that extension alone for what it holds (juno, kit), the pick is a two-level chip, Enter sends to
// the child with its parent, and delete on an empty box unwinds the child, then the chip. The
// slower second answer (refreshMentions) replaces the rows only for the same words, chip and
// search, and nothing is asked while the Capsule is hidden.

import AppKit
import Foundation

@MainActor
final class ChatProbe: CapsuleExtension {
    static let id = "chatprobe"
    /// "words|parent id|extension id" for every synchronous ask.
    static var asked: [String] = []
    static var sent: [String] = []
    static var picked: [String] = []
    /// The words of each refreshMentions call, by call number, and the calls a test lets finish.
    static var refreshCalls: [String] = []
    static var released = Set<Int>()
    static var refreshing = false
    /// Stubborn: a call ignores cancellation and waits only for its release, so an answer can land
    /// after the words changed, and only the Capsule's own guard keeps it off the list.
    static var stubborn = false
    private static var waiters: [Int: CheckedContinuation<Void, Never>] = [:]
    /// Bumped by reset: a call left waiting by an earlier test gives up instead of spinning.
    private static var generation = 0

    static func reset() {
        generation += 1
        for (_, w) in waiters { w.resume() }
        waiters = [:]
        asked = []; sent = []; picked = []; refreshCalls = []; released = []; refreshing = false; stubborn = false
    }

    static func release(_ n: Int) {
        released.insert(n)
        waiters.removeValue(forKey: n)?.resume()
    }

    static let app = MentionTarget(id: "whatsapp", label: "WhatsApp", sub: "app", icon: .symbol("message"),
                                   sendsTo: "WhatsApp", nests: true)
    init(host: CapsuleHost) {}

    var refreshesMentions: Bool { true }

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
        let n = Self.refreshCalls.count, gen = Self.generation
        Self.refreshCalls.append(query)
        if Self.stubborn {
            await withCheckedContinuation { (w: CheckedContinuation<Void, Never>) in
                if Self.released.contains(n) || Self.generation != gen { w.resume() } else { Self.waiters[n] = w }
            }
        } else {
            // A cancelled sleep returns at once, so the loop checks for cancellation too.
            while !Self.released.contains(n) && !Task.isCancelled && Self.generation == gen {
                try? await Task.sleep(nanoseconds: 5_000_000)
            }
        }
        return [MentionTarget(id: "fresh-\(n)", label: "fresh:\(query)#\(n)", sendsTo: "WhatsApp", parentID: "whatsapp")]
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

/// A shown model with the given extensions and an agent named juno in Vyre, no vyred. The
/// follower willShow starts is stopped at once, so nothing retries a missing socket.
@MainActor private func world(_ name: String, _ types: [CapsuleExtension.Type] = [NotesProbe.self, ChatProbe.self]) -> (CapsuleModel, ExtensionHost) {
    let m = CapsuleModel(home: vyScratch("nest-\(name)-\(UUID().uuidString.prefix(6))"),
                         vyred: VyredClient(socket: vyScratch("x") + "/none.sock"), providers: [])
    let h = ExtensionHost(model: m)
    ChatProbe.reset(); NotesProbe.sent = []
    h.load(types)
    m.willShow(front: nil)
    m.vyred.follower.stop()
    m.catalog = VyreCatalog(agents: [VyreAgent(name: "juno", kind: "assistant")])
    return (m, h)
}

private func titles(_ m: CapsuleModel) async -> [String] { await MainActor.run { m.flat.map(\.title) } }

let extensionNestSuite = Suite("extension nesting") { t in
    /// Type "@wha" and pick WhatsApp: the nesting chip.
    @Sendable func chipWhatsApp(_ m: CapsuleModel) async {
        await MainActor.run { m.text = "@wha"; m.run() }
        t.ok(await soon { m.target?.label == "WhatsApp" }, "WhatsApp became the chip")
    }

    t.test("an old-style extension is asked through the default, with no chip only") {
        let r: [String]? = t.wait {
            await MainActor.run {
                let (m, h) = world("flat")
                m.text = "@"
                let rows = m.flat.map(\.title)
                let notes = NotesProbe(host: h)
                let inside = notes.mentions(matching: "", context: MentionContext(parent: ChatProbe.app, extensionID: "chatprobe")).count
                let top = notes.mentions(matching: "no", context: .top).map(\.label)
                m.didHide()
                return rows + ["\(inside)"] + top + ChatProbe.asked
            }
        }
        t.eq(r, ["juno", "Notes", "WhatsApp", "0", "Notes", "|-|-"])
    }

    t.test("no refresh is scheduled when no extension has one") {
        let r: [Bool]? = t.wait {
            await MainActor.run {
                let (m, h) = world("none", [NotesProbe.self])
                m.text = "@no"
                let without = m.refreshScheduled
                let (m2, h2) = world("some")
                m2.text = "@no"
                let with = m2.refreshScheduled
                m.didHide(); m2.didHide()
                return withExtendedLifetime((h, h2)) { [without, with] }
            }
        }
        t.eq(r, [false, true])
    }

    t.test("old-style send is reached through send(_:to:in:query:)") {
        let r: [String]? = t.wait {
            let notes = await MainActor.run { () -> NotesProbe in NotesProbe.sent = []; return NotesProbe(host: world("fwd").1) }
            let target = MentionTarget(id: "notes", label: "Notes", sendsTo: "Notes on this Mac")
            _ = await notes.send("proof the Northwind menu", to: target, in: nil, query: Query("proof the Northwind menu"))
            return await MainActor.run { NotesProbe.sent }
        }
        t.eq(r, ["notes: proof the Northwind menu"])
    }

    t.test("a second @ inside a nesting chip asks only its extension, with the chip as parent") {
        let r: [String]? = t.wait {
            let (m, h) = await MainActor.run { world("inner") }
            await chipWhatsApp(m)
            let chip = await MainActor.run { [m.target?.label ?? "", m.text, "\(m.nestingChip != nil)"] }
            await MainActor.run { ChatProbe.asked = []; m.text = "@" }
            let all = await titles(m)
            await MainActor.run { m.text = "@ju" }
            let some = await titles(m)
            let asked = await MainActor.run { withExtendedLifetime(h) { m.didHide(); return ChatProbe.asked } }
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
            t.ok(await soon { m.targetParent != nil }, "juno picked inside WhatsApp")
            let chip = await MainActor.run { [m.targetParent?.label ?? "", m.target?.label ?? "", m.text] }
            await MainActor.run { m.text = "the bakery opens at nine" }
            let via = await MainActor.run { m.current?.sendsTo ?? "" }
            await MainActor.run { m.run() }
            t.ok(await soon { m.line != nil }, "the send said something")
            let line = await MainActor.run { m.line ?? "" }
            let out = await MainActor.run { withExtendedLifetime(h) { m.didHide(); return ChatProbe.sent + ChatProbe.picked } }
            return first + chip + [via, line] + out
        }
        t.eq(r, ["whatsapp@-", "WhatsApp", "juno", "", "WhatsApp", "Sent to juno on WhatsApp",
                 "WhatsApp > juno: the bakery opens at nine", "whatsapp@-", "juno@whatsapp"])
    }

    t.test("delete on an empty box, through the panel's key handler: the child, then the chip; text keeps both") {
        let r: [String]? = t.wait {
            let (m, h) = await MainActor.run { world("unwind") }
            await chipWhatsApp(m)
            await MainActor.run { m.text = "@kit"; m.run() }
            t.ok(await soon { m.targetParent != nil }, "kit picked inside WhatsApp")
            return await MainActor.run { () -> [String] in
                // The panel is made, never shown; the event is made, never posted.
                let pc = PanelController(model: m)
                let delete = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil,
                                              characters: "\u{7f}", charactersIgnoringModifiers: "\u{7f}", isARepeat: false, keyCode: 51)!
                @MainActor func chip() -> String { "\(m.targetParent?.label ?? "-") > \(m.target?.label ?? "-")" }
                var out = [chip()]
                m.text = "hi"
                out.append("\(pc.key(delete)) \(chip())")
                m.text = ""
                out.append("\(pc.key(delete)) \(chip()) nests:\(m.nestingChip != nil)")
                out.append("\(pc.key(delete)) \(chip())")
                out.append("\(pc.key(delete)) \(chip())")
                m.didHide()
                return withExtendedLifetime(h) { out }
            }
        }
        t.eq(r, ["WhatsApp > kit", "false WhatsApp > kit", "true - > WhatsApp nests:true", "true - > -", "false - > -"])
    }

    t.test("the outer chip never outlives its child: setting target elsewhere makes the chip one level") {
        let r: [String]? = t.wait {
            let (m, h) = await MainActor.run { world("step") }
            await chipWhatsApp(m)
            await MainActor.run { m.text = "@juno"; m.run() }
            t.ok(await soon { m.targetParent != nil }, "juno picked inside WhatsApp")
            return await MainActor.run { () -> [String] in
                m.target = VyreCandidate(kind: .agent, id: "juno", label: "juno")
                let agent = "\(m.targetParent?.label ?? "-") > \(m.target?.label ?? "-")"
                m.target = nil
                let none = "\(m.targetParent?.label ?? "-") > \(m.target?.label ?? "-")"
                m.didHide()
                return withExtendedLifetime(h) { [agent, none] }
            }
        }
        t.eq(r, ["- > juno", "- > -"])
    }

    t.test("child ids cannot collide across chips") {
        t.ok(CapsuleModel.childID("ext:a:b", "c") != CapsuleModel.childID("ext:a", "b:c"))
        t.ok(CapsuleModel.childID("ext:a>b", "c") != CapsuleModel.childID("ext:a", "b>c"))
    }

    t.test("a refresh replaces the rows for the same words and is dropped when the words changed") {
        let r: [String]? = t.wait {
            let (m, h) = await MainActor.run { world("refresh") }
            await chipWhatsApp(m)
            await MainActor.run { ChatProbe.refreshing = true; m.text = "@j" }
            t.ok(await soon { ChatProbe.refreshCalls == ["j"] }, "refresh asked for j")
            let before = await titles(m)
            await MainActor.run { ChatProbe.release(0) }
            t.ok(await soon { m.flat.map(\.title) == ["fresh:j#0"] }, "j's answer shown")
            let same = await titles(m)
            await MainActor.run { m.text = "@k" }
            t.ok(await soon { ChatProbe.refreshCalls == ["j", "k"] }, "refresh asked for k")
            await MainActor.run { m.text = "@ki"; ChatProbe.release(1) }
            await pause(250)
            let changed = await titles(m)
            t.ok(await soon { ChatProbe.refreshCalls == ["j", "k", "ki"] }, "refresh asked for ki")
            await MainActor.run { ChatProbe.release(2) }
            t.ok(await soon { m.flat.map(\.title) == ["fresh:ki#2"] }, "ki's answer shown")
            let last = await titles(m)
            await MainActor.run { withExtendedLifetime(h) { m.didHide(); ChatProbe.reset() } }
            return before + ["|"] + same + ["|"] + changed + ["|"] + last
        }
        t.eq(r, ["juno", "|", "fresh:j#0", "|", "kit", "|", "fresh:ki#2"])
    }

    t.test("an answer that ignores cancellation and lands after the words changed is dropped") {
        let r: [String]? = t.wait {
            let (m, h) = await MainActor.run { world("stubborn") }
            await chipWhatsApp(m)
            await MainActor.run { ChatProbe.refreshing = true; ChatProbe.stubborn = true; m.text = "@j" }
            t.ok(await soon { ChatProbe.refreshCalls == ["j"] }, "refresh asked for j")
            await MainActor.run { m.text = "@k" }
            t.ok(await soon { ChatProbe.refreshCalls == ["j", "k"] }, "refresh asked for k")
            await MainActor.run { ChatProbe.release(0) }
            await pause(200)
            let old = await titles(m)
            await MainActor.run { ChatProbe.release(1) }
            t.ok(await soon { m.flat.map(\.title) == ["fresh:k#1"] }, "k's answer shown")
            let now = await titles(m)
            await MainActor.run { withExtendedLifetime(h) { m.didHide(); ChatProbe.reset() } }
            return old + ["|"] + now
        }
        t.eq(r, ["kit", "|", "fresh:k#1"])
    }

    t.test("same words under a chip dropped and picked again: the old answer is dropped") {
        let r: [String]? = t.wait {
            let (m, h) = await MainActor.run { world("rechip") }
            await chipWhatsApp(m)
            await MainActor.run { ChatProbe.refreshing = true; ChatProbe.stubborn = true; m.text = "@j" }
            t.ok(await soon { ChatProbe.refreshCalls == ["j"] }, "refresh asked for j")
            await MainActor.run { m.text = ""; m.dropChip() }
            t.ok(await MainActor.run { m.target == nil }, "chip dropped")
            await chipWhatsApp(m)
            await MainActor.run { m.text = "@j" }
            t.ok(await soon { ChatProbe.refreshCalls == ["j", "j"] }, "refresh asked for j again")
            await MainActor.run { ChatProbe.release(0) }
            await pause(200)
            let old = await titles(m)
            await MainActor.run { ChatProbe.release(1) }
            t.ok(await soon { m.flat.map(\.title) == ["fresh:j#1"] }, "the new answer shown")
            let now = await titles(m)
            await MainActor.run { withExtendedLifetime(h) { m.didHide(); ChatProbe.reset() } }
            return old + ["|"] + now
        }
        t.eq(r, ["juno", "|", "fresh:j#1"])
    }

    t.test("hidden: a waiting refresh is cancelled, one in flight is dropped, and typing asks nothing") {
        let r: [String]? = t.wait {
            let (m, h) = await MainActor.run { world("hide") }
            await chipWhatsApp(m)
            // Waiting out the 120 ms when the Capsule hides: never asked.
            await MainActor.run { ChatProbe.refreshing = true; m.text = "@j"; m.didHide() }
            await pause(300)
            let waiting = await MainActor.run { ChatProbe.refreshCalls.count }
            // Shown again, in flight when it hides: its answer is dropped.
            await MainActor.run { m.willShow(front: nil); m.vyred.follower.stop(); ChatProbe.stubborn = true; m.text = "@k" }
            t.ok(await soon { ChatProbe.refreshCalls == ["k"] }, "refresh asked for k")
            await MainActor.run { m.didHide(); ChatProbe.release(0) }
            await pause(200)
            let rows = await titles(m)
            // Words changing while hidden ask nothing.
            await MainActor.run { m.text = "@ki" }
            await pause(300)
            let hiddenCalls = await MainActor.run { withExtendedLifetime(h) { ChatProbe.refreshCalls.count } }
            await MainActor.run { ChatProbe.reset() }
            return ["\(waiting)"] + rows + ["\(hiddenCalls)"]
        }
        t.eq(r, ["0", "kit", "1"])
    }
}
