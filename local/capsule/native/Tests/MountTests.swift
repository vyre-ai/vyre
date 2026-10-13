// capsule-suite: mountSuite
// Vyre in Finder, the pure half: names, the mirror of the Drive, the calls Finder's acts become, and the frame between the extension and the app.

import Foundation

private func ch(_ p: String, _ v: Int64, _ s: Int64, deleted: Bool = false) -> MountChange { MountChange(path: p, size: deleted ? 0 : 10, version: v, seq: s, deleted: deleted) }
private func names(_ ops: [MountOp]) -> [String] { ops.map { if case .upsert(let i) = $0 { return "+" + i.id } else if case .remove(let id) = $0 { return "-" + id } else { return "" } } }

let mountSuite = Suite("mount") { t in
    t.test("a Drive name reads back exactly, and a name Finder cannot show is escaped") {
        for p in ["retainer.pdf", "a:b", "c?d.txt", "100%", "50%off.txt", "100%25.txt", "emoji \u{1F600}.txt", "q\"uote|pipe<>*"] {
            guard let l = MountNames.localSegment(p) else { t.ok(false, p); continue }
            t.ok(!l.contains(":"), l)
            t.eq(MountNames.driveSegment(l), p, "\(p) -> \(l)")
        }
        t.eq(MountNames.localSegment("a:b"), "a%3Ab")
        t.eq(MountNames.localSegment("100%25.txt"), "100%2525.txt")
        t.eq(MountNames.localSegment("50%off"), "50%off", "a lone percent stays")
        t.eq(MountNames.localSegment(String(repeating: "x", count: 300)), nil)
    }

    t.test("a name from Finder is a Drive name only when the Drive would take it") {
        t.eq(MountNames.driveName(forFinder: "a%3Ab.txt"), "a:b.txt")
        for bad in ["", ".", "..", "a/b", "a\\b", "x%2Fy", "x%00y", "ends.", "ends ", " starts", ".trash", ".upload"] { t.eq(MountNames.driveName(forFinder: bad), nil, bad) }
        t.eq(MountNames.driveName(forFinder: ".trashy"), ".trashy")
    }

    t.test("the system's own files stay on this Mac") {
        for n in [".DS_Store", "._report.docx", ".Trashes", "~$report.docx", ".~lock.a.odt#", "x.tmp", "Thumbs.db", ".sb-1234-abc"] { t.ok(MountNames.isTransient(n), n) }
        for n in ["report.docx", "tmp", "a.tmpl", ".gitignore"] { t.ok(!MountNames.isTransient(n), n) }
    }

    t.test("the first listing makes folders then files and skips the server's own folders and transient files") {
        let m = MountMirror()
        let ops = m.apply([ch("a/b/one.txt", 1, 1), ch("a/two.txt", 1, 2), ch(".trash/old.txt", 1, 3), ch("a/.DS_Store", 1, 4)], anchor: 4)
        t.eq(names(ops), ["+d:a", "+d:a/b", "+f:a/b/one.txt", "+f:a/two.txt"])
        t.eq(m.anchor, 4)
        t.eq(m.count, 2)
        t.eq(m.children(of: MountId.root).map { $0.id }, ["d:a"])
        t.eq(m.children(of: "d:a").map { $0.id }, ["d:a/b", "f:a/two.txt"])
        t.eq(m.item("f:a/b/one.txt")?.parent, "d:a/b")
    }

    t.test("a change at a known version is skipped and a newer one updates in place") {
        let m = MountMirror()
        m.apply([ch("a.txt", 2, 1)], anchor: 1)
        t.eq(m.apply([ch("a.txt", 2, 1)], anchor: 1), [], "asking again from an old anchor is safe")
        t.eq(m.apply([ch("a.txt", 1, 1)], anchor: 1), [])
        t.eq(names(m.apply([ch("a.txt", 3, 5)], anchor: 5)), ["+f:a.txt"])
        t.eq(m.version(ofPath: "a.txt"), 3)
    }

    t.test("a delete removes the file and the folders it leaves empty, not the ones still in use") {
        let m = MountMirror()
        m.apply([ch("a/b/one.txt", 1, 1), ch("a/two.txt", 1, 2)], anchor: 2)
        t.eq(names(m.apply([ch("a/b/one.txt", 2, 3, deleted: true)], anchor: 3)), ["-f:a/b/one.txt", "-d:a/b"])
        t.eq(names(m.apply([ch("a/two.txt", 2, 4, deleted: true)], anchor: 4)), ["-f:a/two.txt", "-d:a"])
        t.eq(m.count, 0)
        t.eq(m.apply([ch("never.txt", 2, 5, deleted: true)], anchor: 5), [], "a delete of an unknown file does nothing")
    }

    t.test("siblings that differ only in case are told apart, and one that goes frees its name") {
        let m = MountMirror()
        m.apply([ch("Report.txt", 1, 1), ch("report.txt", 1, 2), ch("REPORT.txt", 1, 3)], anchor: 3)
        t.eq(m.item("f:Report.txt")?.name, "Report.txt")
        t.eq(m.item("f:report.txt")?.name, "report (2).txt")
        t.eq(m.item("f:REPORT.txt")?.name, "REPORT (3).txt")
        m.apply([ch("Report.txt", 2, 4, deleted: true)], anchor: 4)
        t.eq(m.item("f:report.txt")?.name, "report (2).txt", "an item keeps the name it was shown with")
    }

    t.test("a folder marker keeps an empty folder, and is never shown as a file") {
        let m = MountMirror()
        t.eq(names(m.apply([ch("Clients/\(MountNames.folderMarker)", 1, 1)], anchor: 1)), ["+d:Clients"])
        t.eq(m.count, 0)
        m.apply([ch("Clients/a.txt", 1, 2)], anchor: 2)
        t.eq(names(m.apply([ch("Clients/a.txt", 2, 3, deleted: true)], anchor: 3)), ["-f:Clients/a.txt"], "the marker keeps the folder")
        t.eq(names(m.apply([ch("Clients/\(MountNames.folderMarker)", 2, 4, deleted: true)], anchor: 4)), ["-d:Clients"])
    }

    t.test("a write made here is remembered, so the change coming back shows nothing") {
        let m = MountMirror(anchor: 3)
        t.eq(names(m.noteWritten(path: "x/new.txt", version: 1, size: 5)), ["+d:x", "+f:x/new.txt"])
        t.eq(m.apply([ch("x/new.txt", 1, 7)], anchor: 7), [])
        t.eq(names(m.noteGone(path: "x/new.txt")), ["-f:x/new.txt", "-d:x"])
        t.eq(m.files(under: "x"), [])
    }

    t.test("a folder names every file under it") {
        let m = MountMirror()
        m.apply([ch("Docs/a.txt", 1, 1), ch("Docs/sub/b.txt", 1, 2), ch("Docsx/c.txt", 1, 3)], anchor: 3)
        t.eq(m.files(under: "Docs"), ["Docs/a.txt", "Docs/sub/b.txt"])
    }

    t.test("the anchor Finder holds round-trips and a wrong one is refused") {
        for n: Int64 in [0, 1, 255, 256, 1 << 40] { t.eq(MountAnchor.decode(MountAnchor.encode(n)), n) }
        t.eq(MountAnchor.decode(Data([1, 2, 3])), nil)
    }

    t.test("what Finder does becomes the right server call") {
        t.eq(MountCalls.changes(since: nil).canonical, #"{"input":{"limit":500},"tool":"files.drive.space.changes"}"#)
        t.eq(MountCalls.changes(since: 7).canonical, #"{"input":{"limit":500,"since":7},"tool":"files.drive.space.changes"}"#)
        t.eq(MountCalls.trash(path: "a/b.txt").canonical, #"{"input":{"path":"a\/b.txt"},"tool":"files.drive.space.trash"}"#)
        t.eq(MountCalls.move(from: "a/b.txt", to: "a/c.txt").tool, "files.drive.space.move")
        t.eq(MountCalls.upload(path: "a", bytes: Data("hi".utf8), base: 3).input["base64"] as? String, "aGk=")
        t.eq(MountCalls.upload(path: "a", bytes: Data("hi".utf8), base: nil).input["base"] == nil, true)
        t.eq(MountCalls.read(path: "a", version: 3, offset: 4, length: 5).input["length"] as? Int, 5)
        t.eq(MountCalls.part(upload: "u1", index: 2, bytes: Data("hi".utf8)).tool, "files.drive.space.upload.part")
    }

    t.test("big files go up in parts and small ones in one call") {
        t.ok(!MountCalls.needsParts(size: 0)); t.ok(!MountCalls.needsParts(size: Int64(MountCalls.oneCall))); t.ok(MountCalls.needsParts(size: Int64(MountCalls.oneCall) + 1))
        let r = MountCalls.ranges(size: Int64(MountCalls.oneCall) + 1)
        t.eq(r.count, 3)
        t.eq(r.map { Int64($0.length) }.reduce(0, +), Int64(MountCalls.oneCall) + 1)
        t.ok(zip(r, r.dropFirst()).allSatisfy { $0.offset + Int64($0.length) == $1.offset }, "no gap and no overlap")
        t.ok(MountCalls.part * 4 / 3 + 8 < MountCalls.oneCall, "a part's base64 stays under the one-call cap")
    }

    t.test("a frame carries a call and its answer, and refuses what is too big or short") {
        let call = MountCalls.trash(path: "a/b.txt")
        guard let f = MountWire.request(id: 9, call: call) else { t.ok(false, "frame"); return }
        t.eq(MountWire.length(of: f), f.count - 4)
        let body = MountWire.decode(f.dropFirst(4))
        t.eq(body?["id"] as? Int, 9)
        t.eq(body?["tool"] as? String, "files.drive.space.trash")
        t.eq(MountWire.length(of: Data([0, 0])), nil)
        t.eq(MountWire.length(of: Data([0xFF, 0xFF, 0xFF, 0xFF])), nil, "a length beyond the cap")
        let bad = MountWire.failure(id: 3, code: "denied", message: "no")
        t.eq((MountWire.decode(bad!.dropFirst(4))?["error"] as? [String: Any])?["code"] as? String, "denied")
        t.ok(MountWire.allowedTools.contains("files.drive.space.trash"))
        t.ok(!MountWire.allowedTools.contains("files.drive.delete") && !MountWire.allowedTools.contains("files.drive.restore"), "the extension cannot ask for a real delete or a restore")
    }
}
