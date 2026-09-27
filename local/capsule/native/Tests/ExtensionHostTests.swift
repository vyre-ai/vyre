// capsule-suite: extensionHostSuite
// capsule-suite: extensionMentionSuite
// capsule-suite: attachSuite
// The seam from the host's side: a registered extension is made once, its commands are rows, its
// chords reach it only with Option or Control, its side panel is drawn for its own rows, and hide
// reaches it.

import SwiftUI

@MainActor
final class ProbeExtension: CapsuleExtension {
    static let id = "probe"
    static var made = 0
    let host: CapsuleHost
    var chords: [KeyShortcut] = []
    var hidden = 0
    init(host: CapsuleHost) { self.host = host; Self.made += 1 }
    var commands: [CapsuleCommand] {
        [CapsuleCommand(id: "probe-look", title: "Look at Northwind", keywords: ["bakery"], icon: .symbol("eye"), subtitle: "a probe",
                        actions: [ResultAction(id: "run", title: "Run") { _, _ in .said("looked") }])]
    }
    var keyChords: [KeyShortcut] { [KeyShortcut("return", option: true)] }
    func handle(chord: KeyShortcut, query: Query) -> Bool { chords.append(chord); return true }
    func sidePanel(for item: ResultItem?) -> AnyView? {
        if let item, item.panel != Self.id { return nil }
        return AnyView(Text("probe panel"))
    }
    func capsuleDidHide() { hidden += 1 }
}

let extensionHostSuite = Suite("extension host") { t in
    t.test("made once, commands listed, Option chords routed, panel shown on request, told of hide") {
        let r: [String]? = t.wait {
            await MainActor.run {
                let v = VyredClient(socket: vyScratch("ext") + "/none.sock")
                let m = CapsuleModel(home: vyScratch("ext-home"), vyred: v, providers: [])
                let h = ExtensionHost(model: m)
                ProbeExtension.made = 0
                h.load([ProbeExtension.self, ProbeExtension.self])
                m.text = "bakery"
                let row = m.flat.first { $0.id == "ext:probe-look" }?.title ?? "none"
                let routed = h.handle(chord: KeyShortcut("return", option: true))
                let other = h.handle(chord: KeyShortcut("k", control: true))
                let before = h.sidePanel(for: m.current) == nil
                h.showPanel("probe")
                let after = h.sidePanel(for: m.current) != nil
                h.didHide()
                let probe = h.extensions.first as! ProbeExtension
                return ["\(ProbeExtension.made)", row, "\(routed)", "\(other)", "\(before)", "\(after)", "\(probe.hidden)", "\(h.sidePanel(for: nil) == nil)"]
            }
        }
        t.eq(r, ["1", "Look at Northwind", "true", "false", "true", "true", "1", "true"])
    }
}

@MainActor
final class NotesProbe: CapsuleExtension {
    static let id = "notesprobe"
    static var sent: [String] = []
    init(host: CapsuleHost) {}
    func mentions(matching query: String) -> [MentionTarget] {
        let t = MentionTarget(id: "notes", label: "Notes", sub: "new note", icon: .symbol("note.text"), sendsTo: "Notes on this Mac")
        return query.isEmpty || "notes".hasPrefix(query.lowercased()) ? [t] : []
    }
    func send(_ text: String, to target: MentionTarget, query: Query) async -> ActionOutcome {
        Self.sent.append("\(target.id): \(text)")
        return .said("Added to Notes")
    }
}

let extensionMentionSuite = Suite("extension mentions") { t in
    t.test("@ lists an extension's target after Vyre's own, the chip says where, Enter sends through the extension") {
        let r: [String]? = t.wait {
            let (m, h) = await MainActor.run { () -> (CapsuleModel, ExtensionHost) in
                let m = CapsuleModel(home: vyScratch("ext-at"), vyred: VyredClient(socket: vyScratch("x") + "/none.sock"), providers: [])
                let h = ExtensionHost(model: m)
                NotesProbe.sent = []
                h.load([NotesProbe.self])
                m.catalog = VyreCatalog(agents: [VyreAgent(name: "juno", kind: "assistant")])
                m.text = "@not"
                return (m, h)
            }
            let rows = await MainActor.run { m.flat.map(\.title) }
            await MainActor.run { m.run() }
            for _ in 0..<100 where await MainActor.run(body: { m.target == nil }) { try? await Task.sleep(nanoseconds: 10_000_000) }
            await MainActor.run { m.text = "buy flour for Northwind" }
            let via = await MainActor.run { m.current?.sendsTo ?? "" }
            await MainActor.run { m.run() }
            for _ in 0..<100 where await MainActor.run(body: { m.line == nil }) { try? await Task.sleep(nanoseconds: 10_000_000) }
            let line = await MainActor.run { m.line ?? "" }
            let sent = await MainActor.run { withExtendedLifetime(h) { NotesProbe.sent } }
            return rows + [via, line] + sent
        }
        t.eq(r, ["Notes", "Notes on this Mac", "Added to Notes", "notes: buy flour for Northwind"])
    }
}

@MainActor
final class ScreenProbe: CapsuleExtension, SendAttaching {
    static let id = "screenprobe"
    init(host: CapsuleHost) {}
    func attachment(for words: String, to: SendTargetKind) async -> SendAttachment? {
        words.contains("this") ? SendAttachment(id: "sight:screen", chip: "with your screen: Safari · Northwind Bakery", body: "Screen: Safari, Northwind Bakery menu") : nil
    }
}

let attachSuite = Suite("attachments") { t in
    t.test("a chip shows while the words point at the screen, goes with the send, and ⌘⌫ keeps it off") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("threads.send") { _ in ["sent": true, "thread": "t1"] }
        let r: [String]? = t.wait {
            let (m, h) = await MainActor.run { () -> (CapsuleModel, ExtensionHost) in
                let m = CapsuleModel(home: vyScratch("attach"), vyred: VyredClient(socket: v.socket), providers: [])
                let h = ExtensionHost(model: m)
                h.load([ScreenProbe.self])
                m.catalog = VyreCatalog(threads: [VyreThread(id: "t1", label: "Northwind menu rebuild")])
                m.target = VyreCandidate(kind: .thread, id: "t1", label: "Northwind menu rebuild")
                m.text = "fix this price"
                return (m, h)
            }
            for _ in 0..<100 where await MainActor.run(body: { m.attachments.isEmpty }) { try? await Task.sleep(nanoseconds: 10_000_000) }
            let chip = await MainActor.run { m.attachments.first?.chip ?? "" }
            await MainActor.run { m.run() }
            for _ in 0..<100 where v.callsOf("threads.send").isEmpty { try? await Task.sleep(nanoseconds: 10_000_000) }
            let first = VJ.s(v.callsOf("threads.send").first?["text"])
            await MainActor.run { m.removeAttachment(); m.text = "and this one too" }
            try? await Task.sleep(nanoseconds: 100_000_000)
            let after = await MainActor.run { withExtendedLifetime(h) { m.attachments.count } }
            return [chip, first, "\(after)"]
        }
        t.eq(r, ["with your screen: Safari · Northwind Bakery", "fix this price\n\nScreen: Safari, Northwind Bakery menu", "0"])
    }
}
