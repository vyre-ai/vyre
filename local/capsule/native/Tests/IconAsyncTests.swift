// capsule-suite: iconAsyncSuite
// A file's or app's icon is made off the main thread: a row never waits on the system for a picture.

import AppKit
import Foundation

let iconAsyncSuite = Suite("icons off the main thread") { t in
    t.test("a file icon is nil now, arrives once, and is cached after; asking twice makes it once") {
        let path = vyScratch("icon-async") + "/note.txt"
        FileManager.default.createFile(atPath: path, contents: Data("x".utf8))
        let r: [String]? = t.wait { @MainActor () -> [String] in
            let c = IconCache()
            var got = 0
            let first = c.imageAsync(.file(path), points: 20, scale: 2) { _ in got += 1 }
            let again = c.imageAsync(.file(path), points: 20, scale: 2) { _ in got += 1 }
            var log = ["\(first == nil)", "\(again == nil)", "\(c.cachedNow(.file(path), points: 20, scale: 2) == nil)"]
            for _ in 0..<300 where got == 0 { try? await Task.sleep(nanoseconds: 10_000_000) }
            log.append("\(got)")
            log.append("\(c.cachedNow(.file(path), points: 20, scale: 2) != nil)")
            log.append("\(c.imageAsync(.file(path), points: 20, scale: 2) { _ in got += 1 } != nil)")
            log.append("renders \(c.renders)")
            return log
        }
        t.eq(r, ["true", "true", "true", "1", "true", "true", "renders 1"])
    }

    t.test("a file that is gone gets the plain document symbol, and a symbol is made at once") {
        let r: [String]? = t.wait { @MainActor () -> [String] in
            let c = IconCache()
            var img: NSImage?
            _ = c.imageAsync(.file("/no/such/file.pdf"), points: 20, scale: 2) { img = $0 }
            for _ in 0..<300 where img == nil { try? await Task.sleep(nanoseconds: 10_000_000) }
            let sym = c.imageAsync(.symbol("envelope"), points: 20, scale: 2) { _ in }
            return ["\(img != nil)", "\(sym != nil)"]
        }
        t.eq(r, ["true", "true"])
    }

    t.test("the modified-time lookup for a key is not repeated on every draw") {
        let path = vyScratch("icon-async") + "/stamp.txt"
        FileManager.default.createFile(atPath: path, contents: Data("x".utf8))
        let r: [String]? = t.wait { @MainActor () -> [String] in
            let c = IconCache()
            let k1 = c.key(.file(path), px: 40)
            try? FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(500)], ofItemAtPath: path)
            let k2 = c.key(.file(path), px: 40)
            return ["\(k1 == k2)"]
        }
        t.eq(r, ["true"])
    }

    t.test("the panel can be drawn once while hidden and stays hidden") {
        MainActor.assumeIsolated {
            let v = FakeVyred()
            let m = CapsuleModel(home: vyScratch("prewarm-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket), providers: [])
            let p = PanelController(model: m)
            p.prewarm()
            t.ok(!p.isShown)
        }
    }
}
