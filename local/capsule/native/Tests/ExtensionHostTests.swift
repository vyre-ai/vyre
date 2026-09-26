// capsule-suite: extensionHostSuite
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
