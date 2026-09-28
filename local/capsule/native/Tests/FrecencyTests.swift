// Frecency tests: the two frecency tests of local.test.js, ported, plus the file mode.

import Foundation

/// A fresh directory under the test scratch folder: VYRE_CAPSULE_SCRATCH, else scratch/ beside the
/// test binary (inside the build folder), never the user's home.
func coreTestDir(_ name: String) -> URL {
    let root = ProcessInfo.processInfo.environment["VYRE_CAPSULE_SCRATCH"].map { URL(fileURLWithPath: $0) }
        ?? URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("scratch")
    let d = root.appendingPathComponent("cp-core-\(name)-\(getpid())-\(UUID().uuidString.prefix(8))")
    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
}

private final class Clock: @unchecked Sendable { var ms: Double; init(_ ms: Double) { self.ms = ms } }

// capsule-suite: frecencySuite
let frecencySuite = Suite("frecency") { t in
    let day = 86_400_000.0

    t.test("picks lift, decay with a 7-day half-life, and stay capped") {
        let dir = coreTestDir("frecency")
        defer { try? FileManager.default.removeItem(at: dir) }
        let clock = Clock(1_000 * day)
        let f = Frecency(file: dir.appendingPathComponent("deep/frecency.json"), now: { clock.ms })
        t.eq(f.boost("app:/A.app", query: "a"), 0)
        f.pick("app:/A.app", query: "saf")
        let one = f.boost("app:/A.app")
        t.ok(one > 0 && one < 0.2)
        for _ in 0..<50 { f.pick("app:/A.app", query: "saf") }
        t.ok(f.boost("app:/A.app") <= 0.45)
        t.ok(f.boost("app:/A.app", query: "sa") > f.boost("app:/A.app", query: "xyz"), "same prefix picked it before")
        t.ok(f.boost("app:/A.app", query: "safari") > f.boost("app:/A.app"), "a longer query sharing the prefix counts")
        t.ok(f.boost("app:/A.app", query: "sa") <= 0.6)

        let g = Frecency(file: dir.appendingPathComponent("g.json"), now: { clock.ms })
        g.pick("x")
        let fresh = g.boost("x")
        clock.ms += 7 * day
        let week = g.boost("x")
        clock.ms += 70 * day
        t.ok(week < fresh && g.boost("x") < week / 10, "old picks fade")
        // Decayed count halves in a week: 1 -> 0.5.
        t.near(week, 0.45 * (1 - exp(-0.5 / 3)))

        let h = Frecency(file: dir.appendingPathComponent("h.json"), now: { clock.ms }, cap: 5)
        for i in 0..<8 { clock.ms += day; h.pick("id\(i)") }
        h.pick("id7")
        t.eq(h.items.keys.sorted(), ["id3", "id4", "id5", "id6", "id7"], "oldest dropped first")

        let p = Frecency(file: dir.appendingPathComponent("p.json"), now: { clock.ms })
        for w in ["a", "b", "c", "d", "e", "f", "g", "h"] { clock.ms += 1000; p.pick("x", query: w) }
        t.eq(p.items["x"]?.q.count, 6, "six prefixes kept per id")
        t.ok(p.items["x"]?.q["a"] == nil && p.items["x"]?.q["h"] != nil, "the stalest prefixes go")
        f.flush(); g.flush(); h.flush(); p.flush()
    }

    t.test("writes atomically on a debounce, 0600, reloads, and survives a corrupt file") {
        let dir = coreTestDir("frecency-file")
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("sub/frecency.json")
        let f = Frecency(file: file, delay: 0.02)
        f.pick("setting:com.apple.wifi-settings-extension", query: "wifi please turn it on")
        t.ok(!FileManager.default.fileExists(atPath: file.path), "not written on the keystroke")
        // The debounce is 20 ms; a loaded CI runner can take far longer to run it, so wait for the
        // file (and its rename) rather than for a fixed time.
        for _ in 0..<250 where (try? FileManager.default.contentsOfDirectory(atPath: file.deletingLastPathComponent().path)) != ["frecency.json"] {
            Thread.sleep(forTimeInterval: 0.02)
        }
        let raw = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
        t.ok(!raw.contains("please"), "only a short prefix is stored")
        t.ok(raw.contains("\"wifi p\""), raw)
        t.eq(try? FileManager.default.contentsOfDirectory(atPath: file.deletingLastPathComponent().path), ["frecency.json"], "no temp file left behind")
        let mode = (try? FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int) ?? -1
        t.eq(mode, 0o600, "only the user can read it")
        let again = Frecency(file: file)
        t.ok(again.boost("setting:com.apple.wifi-settings-extension", query: "wifi") > 0)

        try? "{not json".write(to: file, atomically: false, encoding: .utf8)
        let broken = Frecency(file: file)
        t.eq(broken.boost("anything", query: "a"), 0)
        broken.pick("a", query: "b")
        broken.flush()
        let j = (try? JSONSerialization.jsonObject(with: Data(contentsOf: file))) as? [String: Any]
        t.eq(j?["v"] as? Int, 1)
        t.eq(((j?["items"] as? [String: Any])?["a"] as? [String: Any])?["s"] as? Double, 1)
    }

    t.test("reads the Electron file format") {
        let dir = coreTestDir("frecency-js")
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("frecency.json")
        let now = 1_700_000_000_000.0
        try? #"{"v":1,"items":{"app:/Applications/Safari.app":{"s":3,"t":1700000000000,"q":{"saf":{"s":2,"t":1700000000000}}},"bad":7}}"#
            .write(to: file, atomically: false, encoding: .utf8)
        let f = Frecency(file: file, now: { now })
        t.near(f.boost("app:/Applications/Safari.app"), 0.45 * (1 - exp(-1.0)))
        t.near(f.boost("app:/Applications/Safari.app", query: "safari"), 0.45 * (1 - exp(-1.0)) + 0.15 * (1 - exp(-2.0)))
        t.eq(f.items.count, 1, "a malformed entry is skipped")
    }
}
