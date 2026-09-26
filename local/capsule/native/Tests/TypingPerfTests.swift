// capsule-suite: typingSuite
// Typing into the Capsule, measured: 20 keys into a panel of our own, far off screen and never key,
// with results arriving in waves as they do live (apps now, files ~150 ms later, memory later
// still). For each key: the time from the text changing to the panel laid out and drawn, layout
// passes, and size changes. Over the run: size changes while typing, and rows that vanished and came
// back (flicker). Model-driven: the text changes as the field's binding would change it; no
// keyboard event leaves this process.

import AppKit
import Foundation

/// A slow provider standing in for Spotlight: rows for any query, after a delay, off the main actor.
final class WaveProvider: ResultProvider, @unchecked Sendable {
    let id: String
    let speed = Speed.full
    let delay: UInt64
    let section: Section
    let paths: [String]
    init(id: String, delayMs: UInt64, section: Section, paths: [String]) { self.id = id; self.delay = delayMs * 1_000_000; self.section = section; self.paths = paths }
    func results(for query: Query) async -> [ResultItem] {
        try? await Task.sleep(nanoseconds: delay)
        return paths.enumerated().map { i, p in
            ResultItem(id: "\(id):\(p)", kind: "file", title: (p as NSString).lastPathComponent + " " + query.text, subtitle: (p as NSString).deletingLastPathComponent,
                       icon: .file(p), section: section, score: 0.35 - Double(i) * 0.01)
        }
    }
}

struct TypingReport {
    var paint: [Double] = []
    var layouts: [Int] = []
    var jumpsWhileTyping = 0
    var jumpsAfter = 0
    var flickers = 0
    /// Main-thread busy spans (one run-loop pass each), the whole run, waves included.
    var busy: [Double] = []
    var p50: Double { let s = paint.sorted(); return s.isEmpty ? 0 : s[s.count / 2] }
    var p95: Double { let s = paint.sorted(); return s.isEmpty ? 0 : s[min(s.count - 1, Int(Double(s.count) * 0.95))] }
    var line: String {
        String(format: "keystroke-to-paint p50 %.2f ms, p95 %.2f ms, max %.2f ms; layout passes per key %.1f; size changes while typing %d, after %d; flickers %d; longest main-thread pass %.2f ms, passes over 16 ms %d",
               p50, p95, paint.max() ?? 0, Double(layouts.reduce(0, +)) / Double(max(1, layouts.count)), jumpsWhileTyping, jumpsAfter, flickers,
               busy.max() ?? 0, busy.filter { $0 > 16 }.count)
    }
}

@MainActor func typeTwenty(_ text: String = "safari northwind menu", gapMs: Double = 90) -> TypingReport {
    let v = VyredClient(socket: vyScratch("typing") + "/none.sock")
    let apps = (try? FileManager.default.contentsOfDirectory(atPath: "/System/Applications"))?.filter { $0.hasSuffix(".app") }.prefix(8).map { "/System/Applications/" + $0 } ?? []
    let model = CapsuleModel(home: vyScratch("typing-home"), vyred: v, providers: [
        AppsProvider(), WaveProvider(id: "files", delayMs: 150, section: .files, paths: apps),
        WaveProvider(id: "docs", delayMs: 320, section: .documents, paths: Array(apps.reversed())),
    ])
    (model.providers.first as? AppsProvider)?.refreshIfChanged(wait: true)
    let pc = PanelController(model: model)
    pc.showOffscreen()
    var report = TypingReport()
    var seen: [String: Date] = [:], gone: [String: Date] = [:]
    let sub = model.$groups.sink { gs in
        let ids = Set(gs.flatMap { $0.items.map(\.id) })
        let now = Date()
        for id in ids { if let g = gone[id], now.timeIntervalSince(g) < 0.3 { report.flickers += 1 }; gone[id] = nil; seen[id] = now }
        for (id, _) in seen where !ids.contains(id) { gone[id] = now; seen[id] = nil }
    }
    var woke: UInt64 = 0
    var spans: [Double] = []
    let obs = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.afterWaiting.rawValue | CFRunLoopActivity.beforeWaiting.rawValue, true, 0) { _, act in
        let now = DispatchTime.now().uptimeNanoseconds
        if act == .afterWaiting { woke = now } else if woke != 0 { spans.append(Double(now - woke) / 1e6); woke = 0 }
    }
    CFRunLoopAddObserver(CFRunLoopGetMain(), obs, .commonModes)
    defer { CFRunLoopRemoveObserver(CFRunLoopGetMain(), obs, .commonModes) }
    func pump(_ ms: Double) { RunLoop.main.run(until: Date().addingTimeInterval(ms / 1000)) }
    pump(50)
    let startJumps = pc.frameChanges
    for c in text {
        let l0 = pc.host.layouts
        let t0 = DispatchTime.now().uptimeNanoseconds
        model.text.append(c)
        pc.host.layoutSubtreeIfNeeded()
        pc.panel.displayIfNeeded()
        report.paint.append(Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6)
        report.layouts.append(pc.host.layouts - l0)
        pump(gapMs)
    }
    // The first key may size the panel once (empty to results); every other change is a jump.
    report.jumpsWhileTyping = max(0, pc.frameChanges - startJumps - 1)
    let beforeSettle = pc.frameChanges
    pump(700)
    report.jumpsAfter = pc.frameChanges - beforeSettle
    report.busy = spans
    sub.cancel()
    pc.hide()
    pc.panel.orderOut(nil)
    return report
}

let typingSuite = Suite("typing") { t in
    t.test("twenty keys: paint p95 under 16 ms, no size change mid-word, no row flicker") {
        let r = MainActor.assumeIsolated { () -> TypingReport in
            _ = typeTwenty("warm up the caches ab", gapMs: 20)
            return typeTwenty()
        }
        print("typing\(ProcessInfo.processInfo.environment["VYRE_CAPSULE_OPT"] == "1" ? " (optimised)" : " (debug build)"): " + r.line)
        t.ok(r.p95 < 16, "p95 \(r.p95) ms")
        t.eq(r.jumpsWhileTyping, 0, "size changes while typing")
        t.eq(r.flickers, 0, "rows that vanished and came back")
        t.ok(r.busy.filter { $0 > 16 }.count == 0, "main-thread passes over 16 ms: \(r.busy.filter { $0 > 16 }.map { String(format: "%.1f", $0) })")
    }
}
