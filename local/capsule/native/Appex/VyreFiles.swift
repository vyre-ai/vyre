// VyreFiles: the Finder extension (NSFileProviderReplicatedExtension). "Vyre" in Finder's sidebar, files on demand, and what the person does in Finder going back to the server.
//
// It runs as its own process with no key and no network of its own. Every server call goes to the Vyre app over a socket in the app group's folder (MountClient), and the app makes it from the page
// that holds this Mac's device channel. So it is the person's own device and session, and the server's grants decide what shows.
//
// Built by `build.sh appex` (a plain swiftc bundle, no Xcode project) from this file and Sources/Mount/. Not run on a Mac yet: it needs the app group entitlement, which needs the Apple developer
// account (the owner's native mounting decision).

import FileProvider
import Foundation
import UniformTypeIdentifiers

// MARK: The link to the app

/// Why a call did not work, in the terms Finder needs.
struct MountFailure: Error { let code: String; let message: String }

enum MountClient {
    static func socketPath() -> String? {
        guard let folder = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: MountConfig.group)?.path else { return nil }
        return MountConfig.socketPath(inGroupFolder: folder)
    }

    /// One call, one connection. The answer's `data`, or a MountFailure with the server's own code.
    static func call(_ c: MountCall) async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { cont in
            DispatchQueue.global().async {
                do { cont.resume(returning: try blocking(c)) } catch { cont.resume(throwing: error) }
            }
        }
    }

    private static func blocking(_ c: MountCall) throws -> [String: Any] {
        guard let path = socketPath() else { throw MountFailure(code: "no_app", message: "Vyre is not set up for Finder on this Mac.") }
        let s = socket(AF_UNIX, SOCK_STREAM, 0)
        guard s >= 0 else { throw MountFailure(code: "no_app", message: "No socket.") }
        defer { close(s) }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else { throw MountFailure(code: "no_app", message: "Path too long.") }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in for (i, b) in bytes.enumerated() { raw[i] = UInt8(bitPattern: b) } }
        let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(s, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        guard ok == 0 else { throw MountFailure(code: "no_app", message: "Open Vyre on this Mac to use its files in Finder.") }
        var tv = timeval(tv_sec: 120, tv_usec: 0)
        setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        guard let frame = MountWire.request(id: 1, call: c), write(all: s, frame) else { throw MountFailure(code: "bad_call", message: "That call is too big.") }
        guard let header = read(all: s, 4), let n = MountWire.length(of: header), let body = read(all: s, n), let o = MountWire.decode(body) else { throw MountFailure(code: "no_answer", message: "Vyre did not answer.") }
        if let e = o["error"] as? [String: Any] { throw MountFailure(code: e["code"] as? String ?? "failed", message: e["message"] as? String ?? "") }
        return (o["data"] as? [String: Any]) ?? [:]
    }

    private static func write(all fd: Int32, _ d: Data) -> Bool {
        var sent = 0
        while sent < d.count {
            let w = d.withUnsafeBytes { Darwin.write(fd, $0.baseAddress! + sent, d.count - sent) }
            if w > 0 { sent += w } else if w < 0 && errno == EINTR { continue } else { return false }
        }
        return true
    }

    private static func read(all fd: Int32, _ n: Int) -> Data? {
        var data = Data(count: n)
        var got = 0
        while got < n {
            let r = data.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress! + got, n - got) }
            if r > 0 { got += r } else if r < 0 && errno == EINTR { continue } else { return nil }
        }
        return data
    }

    /// The error Finder shows for a failure.
    static func fileProviderError(_ e: Error) -> Error {
        guard let f = e as? MountFailure else { return NSFileProviderError(.cannotSynchronize) }
        switch f.code {
        case "not_found": return NSFileProviderError(.noSuchItem)
        case "exists": return NSFileProviderError(.filenameCollision)
        case "no_app", "no_link", "no_page", "timeout", "unavailable": return NSFileProviderError(.serverUnreachable)
        case "too_large": return NSFileProviderError(.insufficientQuota)
        default: return NSFileProviderError(.cannotSynchronize)
        }
    }
}

// MARK: The mirror, shared by every enumerator and operation

/// The one mirror of the Drive in this process, and the pull that keeps it current.
final class MountState: @unchecked Sendable {
    static let shared = MountState()
    private let lock = NSLock()
    private var mirror = MountMirror()
    private var pulling: Task<[MountOp], Error>?

    func read<T>(_ f: (MountMirror) -> T) -> T { lock.lock(); defer { lock.unlock() }; return f(mirror) }
    func write<T>(_ f: (MountMirror) -> T) -> T { lock.lock(); defer { lock.unlock() }; return f(mirror) }

    /// Ask the server what changed since the mirror's anchor, page by page, and apply it. One pull at a time: a second caller waits for the first.
    @discardableResult
    func pull() async throws -> [MountOp] {
        let task: Task<[MountOp], Error> = lock.withLock {
            if let t = pulling { return t }
            let t = Task<[MountOp], Error> {
                defer { self.lock.withLock { self.pulling = nil } }
                var all: [MountOp] = []
                while true {
                    let since = self.read { $0.anchor }
                    let r = try await MountClient.call(MountCalls.changes(since: since))
                    let items = (r["items"] as? [Any] ?? []).compactMap(MountChange.parse)
                    guard let anchor = (r["anchor"] as? NSNumber)?.int64Value else { throw MountFailure(code: "bad_answer", message: "The server gave no anchor.") }
                    all += self.write { $0.apply(items, anchor: anchor) }
                    if !(r["more"] as? Bool ?? false) { return all }
                }
            }
            pulling = t
            return t
        }
        return try await task.value
    }
}

// MARK: Items

final class VyreItem: NSObject, NSFileProviderItem {
    let item: MountItem
    init(_ i: MountItem) { item = i }

    var itemIdentifier: NSFileProviderItemIdentifier { item.id == MountId.root ? .rootContainer : NSFileProviderItemIdentifier(item.id) }
    var parentItemIdentifier: NSFileProviderItemIdentifier { item.parent == MountId.root ? .rootContainer : NSFileProviderItemIdentifier(item.parent) }
    var filename: String { item.name }
    var contentType: UTType { item.folder ? .folder : (UTType(filenameExtension: (item.name as NSString).pathExtension) ?? .data) }
    var capabilities: NSFileProviderItemCapabilities { item.folder ? [.allowsReading, .allowsContentEnumerating, .allowsAddingSubItems, .allowsRenaming, .allowsReparenting, .allowsDeleting] : [.allowsReading, .allowsWriting, .allowsRenaming, .allowsReparenting, .allowsDeleting] }
    var documentSize: NSNumber? { item.folder ? nil : NSNumber(value: item.size) }
    var itemVersion: NSFileProviderItemVersion { let v = Data(String(item.version).utf8); return NSFileProviderItemVersion(contentVersion: v, metadataVersion: v) }
}

/// The root, as an item (the system asks for it).
let rootMountItem = MountItem(id: MountId.root, parent: MountId.root, name: "Vyre", folder: true, size: 0, version: 0)

// MARK: Enumerators

final class FolderEnumerator: NSObject, NSFileProviderEnumerator {
    let folder: String
    init(folder: String) { self.folder = folder }
    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        Task {
            do {
                if MountState.shared.read({ $0.anchor }) == nil { try await MountState.shared.pull() }
                let kids = MountState.shared.read { $0.children(of: self.folder) }
                observer.didEnumerate(kids.map(VyreItem.init))
                observer.finishEnumerating(upTo: nil)
            } catch { observer.finishEnumeratingWithError(MountClient.fileProviderError(error)) }
        }
    }
}

/// The working set: everything Finder keeps in step, and the changes since the anchor it holds.
final class WorkingSetEnumerator: NSObject, NSFileProviderEnumerator {
    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        // The working set is kept by changes; there is nothing to list.
        observer.finishEnumerating(upTo: nil)
    }

    func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        Task {
            do {
                let had = MountAnchor.decode(anchor.rawValue)
                // A process with no mirror (it was restarted) rebuilds it from the full listing and then has Finder start over: the mirror cannot say what changed since an older anchor.
                let fresh = MountState.shared.read { $0.anchor } == nil
                let ops = try await MountState.shared.pull()
                if fresh || had == nil {
                    observer.finishEnumeratingWithError(NSFileProviderError(.syncAnchorExpired))
                    return
                }
                var updated: [VyreItem] = [], gone: [NSFileProviderItemIdentifier] = []
                for op in ops {
                    switch op {
                    case .upsert(let i): updated.append(VyreItem(i))
                    case .remove(let id): gone.append(NSFileProviderItemIdentifier(id))
                    }
                }
                if !updated.isEmpty { observer.didUpdate(updated) }
                if !gone.isEmpty { observer.didDeleteItems(withIdentifiers: gone) }
                let now = MountState.shared.read { $0.anchor } ?? 0
                observer.finishEnumeratingChanges(upTo: NSFileProviderSyncAnchor(MountAnchor.encode(now)), moreComing: false)
            } catch { observer.finishEnumeratingWithError(MountClient.fileProviderError(error)) }
        }
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        Task {
            if MountState.shared.read({ $0.anchor }) == nil { _ = try? await MountState.shared.pull() }
            completionHandler(MountState.shared.read { $0.anchor }.map { NSFileProviderSyncAnchor(MountAnchor.encode($0)) })
        }
    }
}

// MARK: The extension

@objc(VyreFileProvider)
final class VyreFileProvider: NSObject, NSFileProviderReplicatedExtension {
    let domain: NSFileProviderDomain
    required init(domain: NSFileProviderDomain) { self.domain = domain; super.init() }
    func invalidate() {}

    private func path(of id: NSFileProviderItemIdentifier) -> (folder: Bool, path: String)? { id == .rootContainer ? (true, "") : MountId.parse(id.rawValue) }

    func item(for identifier: NSFileProviderItemIdentifier, request: NSFileProviderRequest, completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void) -> Progress {
        let p = Progress(totalUnitCount: 1)
        Task {
            if identifier == .rootContainer { completionHandler(VyreItem(rootMountItem), nil); p.completedUnitCount = 1; return }
            if MountState.shared.read({ $0.anchor }) == nil { _ = try? await MountState.shared.pull() }
            if let i = MountState.shared.read({ $0.item(identifier.rawValue) }) { completionHandler(VyreItem(i), nil) } else { completionHandler(nil, NSFileProviderError(.noSuchItem)) }
            p.completedUnitCount = 1
        }
        return p
    }

    func enumerator(for containerItemIdentifier: NSFileProviderItemIdentifier, request: NSFileProviderRequest) throws -> NSFileProviderEnumerator {
        switch containerItemIdentifier {
        case .workingSet: return WorkingSetEnumerator()
        case .rootContainer: return FolderEnumerator(folder: MountId.root)
        case .trashContainer: throw NSFileProviderError(.noSuchItem)
        default:
            guard MountId.parse(containerItemIdentifier.rawValue)?.folder == true else { throw NSFileProviderError(.noSuchItem) }
            return FolderEnumerator(folder: containerItemIdentifier.rawValue)
        }
    }

    // MARK: Bytes down

    func fetchContents(for itemIdentifier: NSFileProviderItemIdentifier, version requestedVersion: NSFileProviderItemVersion?, request: NSFileProviderRequest, completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 100)
        Task {
            do {
                guard let i = MountState.shared.read({ $0.item(itemIdentifier.rawValue) }), !i.folder, let drive = MountId.parse(i.id)?.path else { throw NSFileProviderError(.noSuchItem) }
                let dir = try NSFileProviderManager(for: domain)?.temporaryDirectoryURL() ?? FileManager.default.temporaryDirectory
                let url = dir.appendingPathComponent(UUID().uuidString)
                FileManager.default.createFile(atPath: url.path, contents: nil)
                let out = try FileHandle(forWritingTo: url)
                defer { try? out.close() }
                progress.totalUnitCount = max(i.size, 1)
                for r in MountCalls.ranges(size: i.size) {
                    if progress.isCancelled { try? FileManager.default.removeItem(at: url); throw NSFileProviderError(.serverUnreachable) }
                    let a = try await MountClient.call(MountCalls.read(path: drive, version: i.version, offset: r.offset, length: r.length))
                    guard let b64 = a["base64"] as? String, let bytes = Data(base64Encoded: b64) else { throw MountFailure(code: "bad_answer", message: "No bytes.") }
                    try out.write(contentsOf: bytes)
                    progress.completedUnitCount += Int64(bytes.count)
                }
                completionHandler(url, VyreItem(i), nil)
            } catch { completionHandler(nil, nil, MountClient.fileProviderError(error)) }
        }
        return progress
    }

    // MARK: Bytes up

    /// Send a file's bytes as one version: one call when small, parts when big. Answers the new version.
    private func send(drivePath: String, from url: URL, size: Int64, base: Int64?) async throws -> Int64 {
        if !MountCalls.needsParts(size: size) {
            let bytes = (try? Data(contentsOf: url)) ?? Data()
            let r = try await MountClient.call(MountCalls.upload(path: drivePath, bytes: bytes, base: base))
            return (r["version"] as? NSNumber)?.int64Value ?? 1
        }
        let begun = try await MountClient.call(MountCalls.begin(path: drivePath, base: base))
        guard let id = begun["upload"] as? String else { throw MountFailure(code: "bad_answer", message: "No upload.") }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        do {
            for (n, r) in MountCalls.ranges(size: size).enumerated() {
                try handle.seek(toOffset: UInt64(r.offset))
                let chunk = try handle.read(upToCount: r.length) ?? Data()
                _ = try await MountClient.call(MountCalls.part(upload: id, index: n, bytes: chunk))
            }
        } catch { _ = try? await MountClient.call(MountCalls.abort(upload: id)); throw error }
        let done = try await MountClient.call(MountCalls.commit(upload: id, parts: MountCalls.ranges(size: size).count))
        return (done["version"] as? NSNumber)?.int64Value ?? 1
    }

    private func fileSize(_ url: URL?) -> Int64 { url.flatMap { try? FileManager.default.attributesOfItem(atPath: $0.path)[.size] as? NSNumber }?.int64Value ?? 0 }

    func createItem(basedOn template: NSFileProviderItem, fields: NSFileProviderItemFields, contents url: URL?, options: NSFileProviderCreateItemOptions = [], request: NSFileProviderRequest, completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        Task {
            do {
                guard let name = MountNames.driveName(forFinder: template.filename), let parent = path(of: template.parentItemIdentifier) else { throw NSFileProviderError(.noSuchItem) }
                if MountNames.isTransient(name) { throw NSFileProviderError(.excludedFromSync) }
                let drive = parent.path.isEmpty ? name : parent.path + "/" + name
                let isFolder = template.contentType == .folder
                var version: Int64 = 1
                if isFolder {
                    let r = try await MountClient.call(MountCalls.upload(path: drive + "/" + MountNames.folderMarker, bytes: Data(), base: nil))
                    version = (r["version"] as? NSNumber)?.int64Value ?? 1
                    _ = MountState.shared.write { $0.apply([MountChange(path: drive + "/" + MountNames.folderMarker, size: 0, version: version, seq: 0, deleted: false)], anchor: $0.anchor ?? 0) }
                    guard let made = MountState.shared.read({ $0.item(MountId.dir(drive)) }) else { throw NSFileProviderError(.cannotSynchronize) }
                    completionHandler(VyreItem(made), [], false, nil)
                } else {
                    let size = fileSize(url)
                    if let url { version = try await send(drivePath: drive, from: url, size: size, base: nil) }
                    else { version = (try await MountClient.call(MountCalls.upload(path: drive, bytes: Data(), base: nil))["version"] as? NSNumber)?.int64Value ?? 1 }
                    _ = MountState.shared.write { $0.noteWritten(path: drive, version: version, size: size) }
                    guard let made = MountState.shared.read({ $0.item(MountId.file(drive)) }) else { throw NSFileProviderError(.cannotSynchronize) }
                    completionHandler(VyreItem(made), [], false, nil)
                }
            } catch { completionHandler(nil, [], false, MountClient.fileProviderError(error)) }
            progress.completedUnitCount = 1
        }
        return progress
    }

    func modifyItem(_ item: NSFileProviderItem, baseVersion version: NSFileProviderItemVersion, changedFields: NSFileProviderItemFields, contents newContents: URL?, options: NSFileProviderModifyItemOptions = [], request: NSFileProviderRequest, completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        Task {
            do {
                guard var cur = MountState.shared.read({ $0.item(item.itemIdentifier.rawValue) }), let here = MountId.parse(cur.id) else { throw NSFileProviderError(.noSuchItem) }
                var drive = here.path
                // renamed or moved first, then the new bytes at the new place
                if changedFields.contains(.filename) || changedFields.contains(.parentItemIdentifier) {
                    guard let name = MountNames.driveName(forFinder: item.filename), let parent = path(of: item.parentItemIdentifier) else { throw NSFileProviderError(.noSuchItem) }
                    let target = parent.path.isEmpty ? name : parent.path + "/" + name
                    if target != drive {
                        let pairs: [(String, String)] = here.folder ? MountState.shared.read { $0.files(under: drive) }.map { ($0, target + String($0.dropFirst(drive.count))) } : [(drive, target)]
                        for (from, to) in pairs {
                            let r = try await MountClient.call(MountCalls.move(from: from, to: to))
                            let v = (r["version"] as? NSNumber)?.int64Value ?? 1
                            let size = MountState.shared.read { $0.item(MountId.file(from))?.size ?? 0 }
                            _ = MountState.shared.write { m in m.noteGone(path: from); return m.noteWritten(path: to, version: v, size: size) }
                        }
                        if here.folder { _ = try? await MountClient.call(MountCalls.move(from: drive + "/" + MountNames.folderMarker, to: target + "/" + MountNames.folderMarker)) }
                        drive = target
                    }
                }
                if changedFields.contains(.contents), let newContents, !here.folder {
                    let size = fileSize(newContents)
                    let base = MountState.shared.read { $0.version(ofPath: drive) }
                    let v = try await send(drivePath: drive, from: newContents, size: size, base: base)
                    _ = MountState.shared.write { $0.noteWritten(path: drive, version: v, size: size) }
                }
                cur = MountState.shared.read { $0.item(here.folder ? MountId.dir(drive) : MountId.file(drive)) } ?? cur
                completionHandler(VyreItem(cur), [], false, nil)
            } catch { completionHandler(nil, [], false, MountClient.fileProviderError(error)) }
            progress.completedUnitCount = 1
        }
        return progress
    }

    func deleteItem(identifier: NSFileProviderItemIdentifier, baseVersion version: NSFileProviderItemVersion, options: NSFileProviderDeleteItemOptions = [], request: NSFileProviderRequest, completionHandler: @escaping (Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        Task {
            do {
                guard let here = MountId.parse(identifier.rawValue) else { throw NSFileProviderError(.noSuchItem) }
                // Finder's delete is a move to the server's trash: nothing is lost, and the real delete still asks.
                let files = here.folder ? MountState.shared.read { $0.files(under: here.path) } : [here.path]
                for f in files {
                    _ = try await MountClient.call(MountCalls.trash(path: f))
                    _ = MountState.shared.write { $0.noteGone(path: f) }
                }
                if here.folder { _ = try? await MountClient.call(MountCalls.trash(path: here.path + "/" + MountNames.folderMarker)) }
                completionHandler(nil)
            } catch { completionHandler(MountClient.fileProviderError(error)) }
            progress.completedUnitCount = 1
        }
        return progress
    }
}
