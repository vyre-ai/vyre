// CoreEnroll: the Capsule's first key on a Mac that runs vyre-core (ADR 0040 sections 4 and 5).
//
// The installer starts this app, as the person, from vyre-core's own signed copy, with a one-time
// code on inherited file descriptor 3: exactly the code's bytes (six letters and digits), then end
// of file. Never argv, never the environment, never a file. The Capsule reads it before anything
// else runs, makes its Secure Enclave key, and sends the key's public half to vyre-core's own
// socket with the code as the proof (`x-vyre-presence: code code=<code>`). The code is used once,
// held in memory only, and never written, logged or shown.
//
// vyre-core's socket and uid come from a root-owned core.json, read under the same rule as
// lib/vyre-core-client.js readCoreConfig, and the socket is checked to be core's before any proof
// goes to it (a socket someone else put in its place never sees the code).

import Foundation
import CryptoKit

enum CoreEnroll {
    static let configPath = "/Library/Application Support/Vyre/core.json"

    struct Config: Equatable {
        var socket: String
        var uid: UInt32
    }

    /// What the installer put on fd 3.
    enum Handoff: Equatable {
        /// fd 3 is not a handoff at all (closed, or not a pipe or socket): an ordinary launch.
        case absent
        /// Exactly six letters and digits, then end of file.
        case code(String)
        /// Something was there but it was not the code: too long, too short, not letters and
        /// digits, no end of file in time. Nothing is sent anywhere.
        case failed
    }

    static let codeLength = 6
    /// What main.swift read from fd 3 at launch; .absent in tests and on an ordinary launch.
    nonisolated(unsafe) static var handoff: Handoff = .absent

    // MARK: fd 3

    /// Read the handoff. Call once, first thing in the process. `timeout` is how long a writer that
    /// neither writes nor closes is waited for. The descriptor is closed either way.
    static func readHandoff(fd: Int32 = 3, timeout: TimeInterval = 2) -> Handoff {
        var st = stat()
        // A launch from Finder or launchd has no fd 3. A pipe or a socket is a handoff.
        guard fstat(fd, &st) == 0 else { return .absent }
        let kind = st.st_mode & S_IFMT
        guard kind == S_IFIFO || kind == S_IFSOCK else { return .absent }
        defer { close(fd) }
        let deadline = Date().addingTimeInterval(timeout)
        var got = [UInt8]()
        var buf = [UInt8](repeating: 0, count: 16)
        while true {
            let left = deadline.timeIntervalSinceNow
            if left <= 0 { return .failed }
            var p = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let r = poll(&p, 1, Int32(min(left, 3600) * 1000))
            if r < 0 { if errno == EINTR { continue }; return .failed }
            if r == 0 { return .failed }
            let n = read(fd, &buf, buf.count)
            if n < 0 { if errno == EINTR || errno == EAGAIN { continue }; return .failed }
            if n == 0 { break }
            got.append(contentsOf: buf[0..<n])
            if got.count > codeLength { return .failed }
        }
        guard got.count == codeLength, got.allSatisfy({ isAlnum($0) }) else { return .failed }
        return .code(String(decoding: got, as: UTF8.self))
    }

    private static func isAlnum(_ b: UInt8) -> Bool {
        (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122)
    }

    // MARK: core.json

    /// The file and every folder above it must be root's and closed to other writers, or a hostile
    /// process could point the Capsule at a core of its own. nil for anything else.
    static func readConfig(file: String = configPath,
                           lstat: (String) -> stat? = { var s = stat(); return Darwin.lstat($0, &s) == 0 ? s : nil },
                           read: (String) -> Data? = { try? Data(contentsOf: URL(fileURLWithPath: $0)) }) -> Config? {
        guard let f = lstat(file), (f.st_mode & S_IFMT) == S_IFREG, f.st_uid == 0, f.st_mode & 0o022 == 0 else { return nil }
        var dir = (file as NSString).deletingLastPathComponent
        while true {
            guard let d = lstat(dir), (d.st_mode & S_IFMT) == S_IFDIR, d.st_uid == 0, d.st_mode & 0o022 == 0 else { return nil }
            let up = (dir as NSString).deletingLastPathComponent
            if up == dir || up.isEmpty { break }
            dir = up
        }
        guard let data = read(file), let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let socket = j["socket"] as? String, socket.hasPrefix("/"),
              let uid = (j["uid"] as? NSNumber).map({ $0.int64Value }), uid > 0, uid <= Int64(UInt32.max),
              !VJ.isBool(j["uid"]) else { return nil }
        return Config(socket: socket, uid: UInt32(uid))
    }

    /// Is this socket vyre-core's own: a socket, owned by core's uid, in a folder only core or root
    /// can write. Why not, or nil.
    static func socketProblem(_ c: Config,
                              lstat: (String) -> stat? = { var s = stat(); return Darwin.lstat($0, &s) == 0 ? s : nil }) -> String? {
        guard let s = lstat(c.socket), let d = lstat((c.socket as NSString).deletingLastPathComponent) else { return "vyre-core's socket is not there." }
        if (s.st_mode & S_IFMT) != S_IFSOCK { return "vyre-core's socket is not a socket." }
        if s.st_uid != c.uid { return "vyre-core's socket does not belong to vyre-core." }
        if (d.st_mode & S_IFMT) != S_IFDIR || (d.st_uid != c.uid && d.st_uid != 0) || d.st_mode & 0o022 != 0 {
            return "vyre-core's socket is in a folder others can write."
        }
        return nil
    }

    // MARK: fingerprint

    /// SHA-256 of the key's SPKI, sixteen hex digits in four groups: what the person compares with
    /// what the installer prints.
    static func fingerprint(publicKey b64url: String) -> String? {
        var s = b64url.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        guard let der = Data(base64Encoded: s), !der.isEmpty else { return nil }
        let hex = SHA256.hash(data: der).prefix(8).map { String(format: "%02x", $0) }.joined()
        return stride(from: 0, to: hex.count, by: 4).map { i -> String in
            let a = hex.index(hex.startIndex, offsetBy: i)
            return String(hex[a..<hex.index(a, offsetBy: 4)])
        }.joined(separator: " ")
    }

    // MARK: the whole step

    /// What the person is told. Never contains the code.
    struct Outcome: Equatable {
        var enrolled: Bool
        var words: String
    }

    /// Enrol the Capsule's key with vyre-core. `problem` is socketProblem's answer (a test's stand-in
    /// for the filesystem checks). Sends nothing anywhere unless the config and the socket are core's.
    @MainActor
    static func enrol(_ handoff: Handoff, presence: CapsulePresence, config: Config?, problem: (Config) -> String? = { socketProblem($0) }) async -> Outcome? {
        switch handoff {
        case .absent: return nil
        case .failed:
            return Outcome(enrolled: false, words: "The installer's code did not arrive. Run the install again, or type the code it shows.")
        case .code(let code):
            if presence.enrolled != nil { return nil }
            guard let config else { return Outcome(enrolled: false, words: "vyre-core's settings could not be trusted, so the installer's code was not sent.") }
            if let why = problem(config) { return Outcome(enrolled: false, words: "The installer's code was not sent. \(why)") }
            let client = VyredClient(socket: config.socket)
            if let why = await presence.enroll(client: client, header: "code code=\(code)") {
                return Outcome(enrolled: false, words: why)
            }
            let fp = presence.enrolled.flatMap { fingerprint(publicKey: $0.publicKey) }
            return Outcome(enrolled: true, words: fp.map { "This Capsule is your key. Fingerprint \($0)." } ?? "This Capsule is your key.")
        }
    }
}
