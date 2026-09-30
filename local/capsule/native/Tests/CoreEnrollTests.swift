// capsule-suite: coreEnrollSuite
// The Capsule's first key through vyre-core: the fd 3 handoff, core.json's trust rule, the socket
// check, and the enrol step against a fake core on a real unix socket. No Secure Enclave, no real core.

import Foundation

private func pipeWith(_ bytes: [UInt8], close writer: Bool = true) -> (read: Int32, write: Int32) {
    var fds: [Int32] = [0, 0]
    _ = pipe(&fds)
    if !bytes.isEmpty { _ = bytes.withUnsafeBufferPointer { write(fds[1], $0.baseAddress, bytes.count) } }
    if writer { close(fds[1]); return (fds[0], -1) }
    return (fds[0], fds[1])
}

private func st(mode: mode_t, uid: uid_t) -> stat { var s = stat(); s.st_mode = mode; s.st_uid = uid; return s }

private final class MemStore: PresenceKeyStore, @unchecked Sendable {
    var handle: Data?
    func loadHandle() -> Data? { handle }
    func save(_ h: Data) -> Bool { handle = h; return true }
    func delete() { handle = nil }
}

let coreEnrollSuite = Suite("core enrol") { t in
    t.test("handoff: exactly six letters and digits then end of file is the code") {
        let p = pipeWith(Array("Ab3xY9".utf8))
        t.eq(CoreEnroll.readHandoff(fd: p.read, timeout: 1), .code("Ab3xY9"))
    }

    t.test("handoff: too short, too long, or not letters and digits fails; nothing is a code") {
        for bytes in ["Ab3xY", "Ab3xY9Z", "Ab3x-9", "Ab3 Y9", "", "Ab3xY9\n"] {
            let p = pipeWith(Array(bytes.utf8))
            t.eq(CoreEnroll.readHandoff(fd: p.read, timeout: 1), .failed, "'\(bytes)'")
        }
    }

    t.test("handoff: a writer that never closes fails after the timeout, without hanging") {
        let p = pipeWith(Array("Ab3xY9".utf8), close: false)
        let start = Date()
        t.eq(CoreEnroll.readHandoff(fd: p.read, timeout: 0.2), .failed)
        t.ok(Date().timeIntervalSince(start) < 2)
        close(p.write)
    }

    t.test("handoff: a closed fd 3 or a regular file is an ordinary launch, not a handoff") {
        t.eq(CoreEnroll.readHandoff(fd: 987, timeout: 0.1), .absent)
        let path = vyScratch("enrol") + "/notpipe"
        FileManager.default.createFile(atPath: path, contents: Data("Ab3xY9".utf8))
        let fd = open(path, O_RDONLY)
        t.eq(CoreEnroll.readHandoff(fd: fd, timeout: 0.1), .absent)
        close(fd)
    }

    t.test("core.json: root's file in root's folders is read; anything writable or not root's is refused") {
        let good = Data(#"{"socket":"/Library/Application Support/Vyre/run/vyre-core.sock","uid":301}"#.utf8)
        func read(_ modes: [String: stat]) -> CoreEnroll.Config? {
            CoreEnroll.readConfig(file: "/Library/Application Support/Vyre/core.json", lstat: { modes[$0] }, read: { _ in good })
        }
        let dirs = ["/Library/Application Support/Vyre": st(mode: S_IFDIR | 0o755, uid: 0), "/Library/Application Support": st(mode: S_IFDIR | 0o755, uid: 0),
                    "/Library": st(mode: S_IFDIR | 0o755, uid: 0), "/": st(mode: S_IFDIR | 0o755, uid: 0)]
        var ok = dirs; ok["/Library/Application Support/Vyre/core.json"] = st(mode: S_IFREG | 0o644, uid: 0)
        t.eq(read(ok), CoreEnroll.Config(socket: "/Library/Application Support/Vyre/run/vyre-core.sock", uid: 301))
        var notRoot = ok; notRoot["/Library/Application Support/Vyre/core.json"] = st(mode: S_IFREG | 0o644, uid: 501)
        t.eq(read(notRoot), nil)
        var writable = ok; writable["/Library/Application Support/Vyre/core.json"] = st(mode: S_IFREG | 0o666, uid: 0)
        t.eq(read(writable), nil)
        var dirOpen = ok; dirOpen["/Library/Application Support"] = st(mode: S_IFDIR | 0o777, uid: 0)
        t.eq(read(dirOpen), nil)
        var dirOwned = ok; dirOwned["/Library"] = st(mode: S_IFDIR | 0o755, uid: 501)
        t.eq(read(dirOwned), nil)
        t.eq(read([:]), nil)
    }

    t.test("core.json: a relative socket, a zero or non-number uid, or bad JSON is refused") {
        let dirs = ["/etc/v": st(mode: S_IFDIR | 0o755, uid: 0), "/etc": st(mode: S_IFDIR | 0o755, uid: 0), "/": st(mode: S_IFDIR | 0o755, uid: 0),
                    "/etc/v/core.json": st(mode: S_IFREG | 0o644, uid: 0)]
        for body in [#"{"socket":"run/x.sock","uid":301}"#, #"{"socket":"/x.sock","uid":0}"#, #"{"socket":"/x.sock","uid":"301"}"#,
                     #"{"socket":"/x.sock","uid":true}"#, #"{"socket":"/x.sock"}"#, "nonsense"] {
            t.eq(CoreEnroll.readConfig(file: "/etc/v/core.json", lstat: { dirs[$0] }, read: { _ in Data(body.utf8) }), nil, body)
        }
    }

    t.test("socket: core's own socket in a closed folder passes; a foreign owner, a file or an open folder does not") {
        let c = CoreEnroll.Config(socket: "/run/v/core.sock", uid: 301)
        func problem(_ s: stat?, _ d: stat?) -> String? { CoreEnroll.socketProblem(c, lstat: { $0 == "/run/v/core.sock" ? s : d }) }
        t.eq(problem(st(mode: S_IFSOCK | 0o660, uid: 301), st(mode: S_IFDIR | 0o755, uid: 301)), nil)
        t.eq(problem(st(mode: S_IFSOCK | 0o660, uid: 301), st(mode: S_IFDIR | 0o755, uid: 0)), nil)
        t.ok(problem(st(mode: S_IFSOCK | 0o660, uid: 501), st(mode: S_IFDIR | 0o755, uid: 301)) != nil)
        t.ok(problem(st(mode: S_IFREG | 0o660, uid: 301), st(mode: S_IFDIR | 0o755, uid: 301)) != nil)
        t.ok(problem(st(mode: S_IFSOCK | 0o660, uid: 301), st(mode: S_IFDIR | 0o777, uid: 301)) != nil)
        t.ok(problem(st(mode: S_IFSOCK | 0o660, uid: 301), st(mode: S_IFDIR | 0o755, uid: 501)) != nil)
        t.ok(problem(nil, nil) != nil)
    }

    t.test("fingerprint: sixteen hex digits in four groups, the same key the same words") {
        let fp = CoreEnroll.fingerprint(publicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE")
        t.ok(fp?.range(of: #"^[0-9a-f]{4}( [0-9a-f]{4}){3}$"#, options: .regularExpression) != nil, "\(fp ?? "nil")")
        t.eq(fp, CoreEnroll.fingerprint(publicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE"))
        t.eq(CoreEnroll.fingerprint(publicKey: ""), nil)
    }

    t.test("enrol: the code goes to core's socket as x-vyre-presence, the key is kept, the fingerprint is said") {
        let fake = FakeVyred(name: "core-ok")
        fake.tool("presence.enroll") { _ in ["id": "k1", "kind": "capsule"] }
        t.ok(fake.start())
        let raw: CoreEnroll.Outcome?? = t.wait { @MainActor () -> CoreEnroll.Outcome? in
            let store = MemStore()
            let p = CapsulePresence(home: vyScratch("enrol-ok"), vyred: VyredClient(socket: "/nowhere"), store: store)
            p.hasSecureEnclave = { false }
            let o = await CoreEnroll.enrol(.code("Ab3xY9"), presence: p, config: CoreEnroll.Config(socket: fake.socket, uid: 1), problem: { _ in nil })
            t.ok(store.handle?.starts(with: CapsulePresence.softwareTag) == true, "a software key on a runner")
            t.eq(p.enrolled?.id, "k1")
            return o
        }
        let out: CoreEnroll.Outcome? = raw ?? nil
        t.eq(out?.enrolled, true)
        t.ok(out?.words.contains("Fingerprint") == true)
        t.ok(out?.words.contains("Ab3xY9") != true, "the code is never shown")
        t.eq(fake.callNames, ["presence.enroll"])
        let h = fake.toolHeaders.first?.headers["x-vyre-presence"]
        t.eq(h, "code code=Ab3xY9")
        fake.stop()
    }

    t.test("enrol: a refused code says core's words, keeps no key, and shows no code") {
        let fake = FakeVyred(name: "core-no")
        fake.headerHook = { _, _ in (FakeError(code: "presence_required", message: "that code is wrong, used or expired"), [:]) }
        fake.tool("presence.enroll") { _ in [:] }
        t.ok(fake.start())
        let raw: CoreEnroll.Outcome?? = t.wait { @MainActor () -> CoreEnroll.Outcome? in
            let store = MemStore()
            let p = CapsulePresence(home: vyScratch("enrol-no"), vyred: VyredClient(socket: "/nowhere"), store: store)
            p.hasSecureEnclave = { false }
            let o = await CoreEnroll.enrol(.code("Zz9Zz9"), presence: p, config: CoreEnroll.Config(socket: fake.socket, uid: 1), problem: { _ in nil })
            t.eq(store.handle, nil, "an unenrolled key is deleted")
            t.ok(p.enrolled == nil)
            return o
        }
        let out: CoreEnroll.Outcome? = raw ?? nil
        t.eq(out?.enrolled, false)
        t.ok(out?.words.contains("wrong, used or expired") == true, out?.words ?? "nil")
        t.ok(out?.words.contains("Zz9Zz9") != true)
        fake.stop()
    }

    t.test("enrol: an untrusted config or socket sends nothing; a failed handoff says so; no handoff is silent") {
        let fake = FakeVyred(name: "core-untrusted")
        fake.tool("presence.enroll") { _ in ["id": "k1"] }
        t.ok(fake.start())
        let r: [CoreEnroll.Outcome?]? = t.wait { @MainActor () -> [CoreEnroll.Outcome?] in
            let p = CapsulePresence(home: vyScratch("enrol-un"), vyred: VyredClient(socket: "/nowhere"), store: MemStore())
            p.hasSecureEnclave = { false }
            let a = await CoreEnroll.enrol(.code("Ab3xY9"), presence: p, config: nil)
            let b = await CoreEnroll.enrol(.code("Ab3xY9"), presence: p, config: CoreEnroll.Config(socket: fake.socket, uid: 1), problem: { _ in "vyre-core's socket does not belong to vyre-core." })
            let c = await CoreEnroll.enrol(.failed, presence: p, config: nil)
            let d = await CoreEnroll.enrol(.absent, presence: p, config: nil)
            return [a, b, c, d]
        }
        t.eq(r?[0]?.enrolled, false); t.eq(r?[1]?.enrolled, false); t.eq(r?[2]?.enrolled, false)
        t.ok(r?[1]?.words.contains("was not sent") == true)
        t.eq(r?[3] == nil, true)
        t.eq(fake.callNames, [])
        fake.stop()
    }
}
