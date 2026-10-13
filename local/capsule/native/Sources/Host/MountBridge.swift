// MountBridge: the app's side of Vyre in Finder. It does three things and holds no key:
//
//  1. the switch: add or remove the File Provider domain, so "Vyre" shows in Finder's sidebar (or not);
//  2. a socket in the app group's folder that the Finder extension calls. The extension is a separate process with no device channel, so each server call comes here, and the app makes it from the page
//     that holds THIS Mac's device channel: the person's own device and session, never a shared key. Only the tools in MountWire.allowedTools are passed on, and only from the same user;
//  3. a nudge every half minute so Finder asks the extension what changed on the server.

import AppKit
import FileProvider
import Foundation

/// Domain handling, behind a protocol so the switch is tested without a Mac that has the extension installed.
protocol MountDomains {
    func isAdded() async -> Bool
    func add() async throws
    func remove() async throws
    func signal() async
}

struct SystemMountDomains: MountDomains {
    var domain: NSFileProviderDomain { NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier(MountConfig.domainId), displayName: MountConfig.displayName) }

    func isAdded() async -> Bool {
        await withCheckedContinuation { c in
            NSFileProviderManager.getDomainsWithCompletionHandler { domains, _ in c.resume(returning: domains.contains { $0.identifier.rawValue == MountConfig.domainId }) }
        }
    }
    func add() async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            NSFileProviderManager.add(domain) { e in if let e { c.resume(throwing: e) } else { c.resume() } }
        }
    }
    func remove() async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            NSFileProviderManager.remove(domain) { e in if let e { c.resume(throwing: e) } else { c.resume() } }
        }
    }
    func signal() async {
        guard let m = NSFileProviderManager(for: domain) else { return }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in m.signalEnumerator(for: .workingSet) { _ in c.resume() } }
    }
}

/// The switch and what stands behind it.
@MainActor
final class MountBridge {
    static let shared = MountBridge()
    /// Makes one server call from the page and answers { data } or { error: { code, message } }. Set by the window.
    var caller: (@Sendable (String, [String: Any]) async -> [String: Any])?
    var domains: MountDomains = SystemMountDomains()
    private var server: MountSocketServer?
    private var nudge: Task<Void, Never>?
    private let defaults = UserDefaults.standard
    static let wantedKey = "mount.on"

    var wanted: Bool { defaults.bool(forKey: Self.wantedKey) }

    /// What Settings shows: whether this build can show Vyre in Finder at all, and whether it does now.
    func state() async -> [String: Any] {
        let supported = Bundle.main.builtInPlugInsURL.map { FileManager.default.fileExists(atPath: $0.appendingPathComponent("VyreFiles.appex").path) } ?? false
        let on = supported ? await domains.isAdded() : false
        return ["supported": supported, "on": on]
    }

    func set(_ on: Bool) async -> String? {
        if on {
            guard let folder = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: MountConfig.group)?.path, let path = MountConfig.socketPath(inGroupFolder: folder) else { return "Vyre cannot find the folder it shares with Finder." }
            if server == nil {
                let s = MountSocketServer(path: path) { [weak self] tool, input in
                    guard let call = await self?.caller else { return ["error": ["code": "no_app", "message": "Vyre is not open."]] }
                    return await call(tool, input)
                }
                do { try s.start() } catch { return "Vyre could not open its link to Finder: \(error)" }
                server = s
            }
            do { try await domains.add() } catch { return "Finder would not add Vyre: \(error.localizedDescription)" }
            startNudging()
        } else {
            nudge?.cancel(); nudge = nil
            do { try await domains.remove() } catch { return "Finder would not remove Vyre: \(error.localizedDescription)" }
            server?.stop(); server = nil
        }
        defaults.set(on, forKey: Self.wantedKey)
        return nil
    }

    /// At launch: bring the link back if the person left it on.
    func restore() {
        guard wanted else { return }
        Task { @MainActor in if let e = await self.set(true) { VyreAppWindow.log("mount: \(e)") } }
    }

    private func startNudging() {
        nudge?.cancel()
        let d = domains
        nudge = Task.detached {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                await d.signal()
            }
        }
    }
}

/// A unix socket server: one request per frame (MountWire), each answered on the same connection.
final class MountSocketServer: @unchecked Sendable {
    typealias Caller = @Sendable (String, [String: Any]) async -> [String: Any]
    private let path: String
    private let caller: Caller
    private var fd: Int32 = -1
    private let accepting = DispatchQueue(label: "sh.vyre.mount.accept")
    private let serving = DispatchQueue(label: "sh.vyre.mount.serve", attributes: .concurrent)
    private let limit = DispatchSemaphore(value: 16)

    init(path: String, caller: @escaping Caller) { self.path = path; self.caller = caller }

    func start() throws {
        unlink(path)
        let s = socket(AF_UNIX, SOCK_STREAM, 0)
        guard s >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else { close(s); throw NSError(domain: NSPOSIXErrorDomain, code: Int(ENAMETOOLONG)) }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in for (i, b) in bytes.enumerated() { raw[i] = UInt8(bitPattern: b) } }
        let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        guard bound == 0 else { let e = errno; close(s); throw NSError(domain: NSPOSIXErrorDomain, code: Int(e)) }
        chmod(path, 0o600)
        guard listen(s, 16) == 0 else { let e = errno; close(s); throw NSError(domain: NSPOSIXErrorDomain, code: Int(e)) }
        fd = s
        accepting.async { [self] in
            while true {
                let c = accept(s, nil, nil)
                if c < 0 { if errno == EINTR { continue } else { return } }
                // same user only
                var uid: uid_t = 0, gid: gid_t = 0
                guard getpeereid(c, &uid, &gid) == 0, uid == getuid() else { close(c); continue }
                limit.wait()
                serving.async { [self] in serve(c); close(c); limit.signal() }
            }
        }
    }

    func stop() {
        if fd >= 0 { shutdown(fd, SHUT_RDWR); close(fd); fd = -1 }
        unlink(path)
    }

    private func serve(_ c: Int32) {
        while let header = Self.readFully(c, 4), let n = MountWire.length(of: header), let body = Self.readFully(c, n), let req = MountWire.decode(body) {
            let id = req["id"] as? Int ?? 0
            guard let tool = req["tool"] as? String, MountWire.allowedTools.contains(tool) else {
                if let f = MountWire.failure(id: id, code: "refused", message: "That is not something Finder may ask for.") { _ = Self.writeFully(c, f) }
                continue
            }
            let input = req["input"] as? [String: Any] ?? [:]
            let sem = DispatchSemaphore(value: 0)
            let box = AnswerBox()
            let caller = self.caller
            Task.detached { box.value = await caller(tool, input); sem.signal() }
            sem.wait()
            let out = box.value
            let frame: Data?
            if let e = out["error"] as? [String: Any] { frame = MountWire.failure(id: id, code: e["code"] as? String ?? "failed", message: e["message"] as? String ?? "") }
            else { frame = MountWire.answer(id: id, data: out["data"] ?? NSNull()) }
            guard let f = frame, Self.writeFully(c, f) else { return }
        }
    }

    static func readFully(_ fd: Int32, _ n: Int) -> Data? {
        var data = Data(count: n)
        var got = 0
        while got < n {
            let r = data.withUnsafeMutableBytes { read(fd, $0.baseAddress! + got, n - got) }
            if r > 0 { got += r } else if r < 0 && errno == EINTR { continue } else { return nil }
        }
        return data
    }

    static func writeFully(_ fd: Int32, _ data: Data) -> Bool {
        var sent = 0
        while sent < data.count {
            let w = data.withUnsafeBytes { write(fd, $0.baseAddress! + sent, data.count - sent) }
            if w > 0 { sent += w } else if w < 0 && errno == EINTR { continue } else { return false }
        }
        return true
    }
}

private final class AnswerBox: @unchecked Sendable { var value: [String: Any] = [:] }
