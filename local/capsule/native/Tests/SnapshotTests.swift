// capsule-suite: snapshotSuite
// Pictures of the Capsule's states, drawn off screen into PNGs (no screen capture, no window on
// the user's screen): results, the memory box, an answer, @ names. Set VYRE_CAPSULE_SNAP to a
// folder to write them; otherwise this only checks that each state draws.

import AppKit
import SwiftUI

final class FixedRows: ResultProvider, ImmediateResults, @unchecked Sendable {
    let id: String
    let speed = Speed.quick
    let rows: [ResultItem]
    init(id: String, rows: [ResultItem]) { self.id = id; self.rows = rows }
    func resultsNow(for query: Query) -> [ResultItem] { rows }
    func results(for query: Query) async -> [ResultItem] { rows }
}

@MainActor func snapModel(_ rows: [ResultItem]) -> CapsuleModel {
    CapsuleModel(home: vyScratch("snap-home"), vyred: VyredClient(socket: vyScratch("snap") + "/none.sock"),
                 providers: [FixedRows(id: "fixed", rows: rows)])
}

@MainActor func snapshot(_ model: CapsuleModel, _ name: String, dir: String?) -> Bool {
    let view = CapsuleView(model: model, focus: FocusTicket(), snapshot: true)
    let host = NSHostingView(rootView: view)
    host.frame = NSRect(x: 0, y: 0, width: Theme.width, height: CapsuleLayout.panelHeight(model))
    host.appearance = NSAppearance(named: .darkAqua)
    host.layoutSubtreeIfNeeded()
    guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return false }
    host.cacheDisplay(in: host.bounds, to: rep)
    if let dir, let png = rep.representation(using: .png, properties: [:]) {
        try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name + ".png"))
    }
    return rep.pixelsWide > 0
}

@MainActor func snapRows() -> [ResultItem] {
    let open = ResultAction(id: "open", title: "Open", shortcut: KeyShortcut("return")) { _, _ in .close(nil) }
    let apps = ["Safari", "Notes", "Calendar", "Reminders"].map { n in
        let path = n == "Safari" ? "/Applications/Safari.app" : "/System/Applications/\(n).app"
        return ResultItem(id: "app:\(n)", kind: "app", title: n, subtitle: "/System/Applications", icon: .file(path),
                   section: .apps, score: n == "Safari" ? 0.9 : 0.5, actions: [open])
    }
    let dir = vyScratch("snap-files")
    let files = [("Northwind menu.pdf", "~/Documents/Northwind"), ("Harlow Legal intake.rtf", "~/Work/Harlow Legal"), ("bakery-prices.csv", "~/Documents")].map { f in
        let p = dir + "/" + f.0
        FileManager.default.createFile(atPath: p, contents: Data("x".utf8))
        return ResultItem(id: "file:\(f.0)", kind: "file", title: f.0, subtitle: f.1, icon: .file(p), section: .files, score: 0.4, actions: [open])
    }
    return apps + files
}

let snapshotSuite = Suite("snapshots") { t in
    t.test("each state draws") {
        let dir = ProcessInfo.processInfo.environment["VYRE_CAPSULE_SNAP"]
        if let dir { try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true) }
        let ok: [Bool] = MainActor.assumeIsolated {
            var out: [Bool] = []
            let m1 = snapModel(snapRows()); m1.text = "sa"
            out.append(snapshot(m1, "1-results", dir: dir))

            let m2 = snapModel([]); m2.text = "12*7 + 3"
            out.append(snapshot(m2, "2-calc", dir: dir))

            let m3 = snapModel([])
            m3.text = "which car do I own"
            m3.memory = Memo.fold(text: "which car do I own", facts: [], hits: [
                ["session": "a1", "role": "user", "name": "Insurance renewal", "text": "I own a blue Volvo XC40, bought in 2022. Renew the insurance before March.",
                 "ts": Date().timeIntervalSince1970 * 1000 - 14 * 86_400_000],
                ["session": "b2", "role": "assistant", "name": "Errands", "text": "Your Volvo is due for a service in April.",
                 "ts": Date().timeIntervalSince1970 * 1000 - 3 * 86_400_000],
            ], scratch: nil)
            m3.search()
            out.append(snapshot(m3, "3-memory", dir: dir))

            let m4 = snapModel([])
            m4.asked = "which car do I own"
            m4.askedMemory = m3.memory
            var r = VyState.reply("q1"); r.model = "haiku"; r.finished = true; r.ok = true; r.cost = 0.004
            r.order = ["m"]; r.text = ["m": "You own a **blue Volvo XC40**, bought in 2022 (you said so 2 weeks ago). The insurance renews before March."]
            m4.reply = r
            out.append(snapshot(m4, "4-answer", dir: dir))

            let m5 = snapModel([])
            m5.catalog = VyreCatalog(agents: [VyreAgent(name: "juno", kind: "assistant")],
                                     projects: [VyreProject(slug: "northwind", name: "Northwind Bakery", threads: 4, last: Date().timeIntervalSince1970 * 1000 - 3_600_000)],
                                     threads: [VyreThread(id: "t1", label: "Northwind menu rebuild", cwd: "/home/alex/Work/northwind", last: Date().timeIntervalSince1970 * 1000 - 120_000)])
            m5.text = "@"
            out.append(snapshot(m5, "5-mention", dir: dir))
            return out
        }
        t.eq(ok, [true, true, true, true, true])
    }
}
