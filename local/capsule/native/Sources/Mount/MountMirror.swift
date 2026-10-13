// MountMirror: what this Mac knows of the Space's Drive, as items Finder can list (the Mac half of Vyre in Finder; mount.rs is the Windows half).
//
// The Drive holds files by path and has no folders of its own, so folders are made from the paths. An item's identifier is its Drive path ("f:" for a file, "d:" for a folder), which is why a
// rename shows as a delete and a create until the Drive has stable ids. Two siblings that differ only in case (APFS is case-insensitive) are told apart by a " (2)" in the later one's name.
// Pure: the extension feeds it the server's change pages and asks it for the items of a folder.

import Foundation

public struct MountChange: Equatable, Sendable {
    public var path: String
    public var size: Int64
    public var version: Int64
    public var seq: Int64
    public var deleted: Bool
    public init(path: String, size: Int64, version: Int64, seq: Int64, deleted: Bool) { self.path = path; self.size = size; self.version = version; self.seq = seq; self.deleted = deleted }

    /// One item of a `files.drive.space.changes` answer.
    public static func parse(_ v: Any) -> MountChange? {
        guard let o = v as? [String: Any], let path = o["path"] as? String, let version = (o["version"] as? NSNumber)?.int64Value else { return nil }
        return MountChange(path: path, size: (o["size"] as? NSNumber)?.int64Value ?? 0, version: version, seq: (o["seq"] as? NSNumber)?.int64Value ?? 0, deleted: (o["deleted"] as? Bool) ?? false)
    }
}

public enum MountId {
    public static let root = "root"
    public static func file(_ p: String) -> String { "f:" + p }
    public static func dir(_ p: String) -> String { "d:" + p }
    /// (isFolder, Drive path) of an identifier, nil for the root or something this mirror never made.
    public static func parse(_ id: String) -> (folder: Bool, path: String)? {
        if id.hasPrefix("f:") { return (false, String(id.dropFirst(2))) }
        if id.hasPrefix("d:") { return (true, String(id.dropFirst(2))) }
        return nil
    }
}

public struct MountItem: Equatable, Sendable {
    public var id: String
    public var parent: String
    public var name: String
    public var folder: Bool
    public var size: Int64
    public var version: Int64
}

/// What changed for Finder, in order.
public enum MountOp: Equatable, Sendable {
    case upsert(MountItem)
    case remove(String)
}

public final class MountMirror {
    private struct Node { var item: MountItem; var children: Set<String> = [] }
    private var nodes: [String: Node] = [:]
    /// lowercased name -> id, per parent
    private var names: [String: [String: String]] = [:]
    /// folders kept alive by a marker file, not by the files in them
    private var marked: Set<String> = []
    public private(set) var anchor: Int64?

    public init(anchor: Int64? = nil) { self.anchor = anchor }

    public var count: Int { nodes.values.filter { !$0.item.folder }.count }
    public func item(_ id: String) -> MountItem? { nodes[id]?.item }
    public func version(ofPath p: String) -> Int64? { nodes[MountId.file(p)]?.item.version }

    /// The items directly inside a folder (the root is MountId.root), by name.
    public func children(of id: String) -> [MountItem] {
        let kids: Set<String> = id == MountId.root ? Set(nodes.values.filter { $0.item.parent == MountId.root }.map { $0.item.id }) : (nodes[id]?.children ?? [])
        return kids.compactMap { nodes[$0]?.item }.sorted { $0.name.lowercased() < $1.name.lowercased() || ($0.name.lowercased() == $1.name.lowercased() && $0.id < $1.id) }
    }

    private func parentPath(_ p: String) -> String? { p.contains("/") ? String(p[..<p.lastIndex(of: "/")!]) : nil }

    private func uniqueName(_ wanted: String, parent: String, id: String) -> String {
        var name = wanted
        var n = 2
        while let other = names[parent]?[name.lowercased()], other != id {
            let ns = wanted as NSString
            let ext = ns.pathExtension, stem = ns.deletingPathExtension
            name = ext.isEmpty || stem.isEmpty ? "\(wanted) (\(n))" : "\(stem) (\(n)).\(ext)"
            n += 1
        }
        return name
    }

    /// Make sure the folders above `path` exist; returns the ops for those it made, outermost first.
    private func ensureFolders(above path: String) -> [MountOp] {
        guard let pp = parentPath(path) else { return [] }
        var ops = ensureFolders(above: pp)
        let id = MountId.dir(pp)
        if nodes[id] != nil { return ops }
        let parent = parentPath(pp).map { MountId.dir($0) } ?? MountId.root
        let last = String(pp.split(separator: "/", omittingEmptySubsequences: false).last ?? "")
        guard let local = MountNames.localSegment(last) else { return ops }
        let item = MountItem(id: id, parent: parent, name: uniqueName(local, parent: parent, id: id), folder: true, size: 0, version: 0)
        nodes[id] = Node(item: item)
        names[parent, default: [:]][item.name.lowercased()] = id
        if parent != MountId.root { nodes[parent]?.children.insert(id) }
        ops.append(.upsert(item))
        return ops
    }

    private func visible(_ path: String) -> Bool {
        let segs = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        if segs.contains(where: { $0.isEmpty }) { return false }
        if MountNames.hiddenTop.contains(segs[0]) { return false }
        return segs.allSatisfy { MountNames.localSegment($0) != nil }
    }

    /// Take a node out, and the folders it leaves empty (unless a marker keeps them), outermost last.
    private func drop(_ id: String) -> [MountOp] {
        guard let node = nodes.removeValue(forKey: id) else { return [] }
        names[node.item.parent]?[node.item.name.lowercased()] = nil
        var ops: [MountOp] = [.remove(id)]
        if node.item.parent != MountId.root {
            nodes[node.item.parent]?.children.remove(id)
            if let pn = nodes[node.item.parent], pn.children.isEmpty, let p = MountId.parse(node.item.parent), !marked.contains(p.path) { ops += drop(node.item.parent) }
        }
        return ops
    }

    /// Apply a page of the server's changes, oldest first. A change at a version already known is skipped, so asking again from an old anchor is safe.
    @discardableResult
    public func apply(_ changes: [MountChange], anchor newAnchor: Int64) -> [MountOp] {
        var ops: [MountOp] = []
        for c in changes {
            guard visible(c.path) else { continue }
            let name = String(c.path.split(separator: "/", omittingEmptySubsequences: false).last ?? "")
            if name == MountNames.folderMarker {
                let dirPath = parentPath(c.path) ?? ""
                if dirPath.isEmpty { continue }
                if c.deleted {
                    marked.remove(dirPath)
                    if let n = nodes[MountId.dir(dirPath)], n.children.isEmpty { ops += drop(MountId.dir(dirPath)) }
                } else {
                    marked.insert(dirPath)
                    ops += ensureFolders(above: dirPath + "/x")
                }
                continue
            }
            if MountNames.isTransient(name) { continue }
            let id = MountId.file(c.path)
            if c.deleted {
                ops += drop(id)
                continue
            }
            if let have = nodes[id]?.item, have.version >= c.version { continue }
            ops += ensureFolders(above: c.path)
            let parent = parentPath(c.path).map { MountId.dir($0) } ?? MountId.root
            if var node = nodes[id] {
                node.item.size = c.size; node.item.version = c.version
                nodes[id] = node
                ops.append(.upsert(node.item))
            } else {
                guard let local = MountNames.localSegment(name) else { continue }
                let item = MountItem(id: id, parent: parent, name: uniqueName(local, parent: parent, id: id), folder: false, size: c.size, version: c.version)
                nodes[id] = Node(item: item)
                names[parent, default: [:]][item.name.lowercased()] = id
                if parent != MountId.root { nodes[parent]?.children.insert(id) }
                ops.append(.upsert(item))
            }
        }
        anchor = newAnchor
        return ops
    }

    /// This Mac wrote a version itself (an upload finished): remember it so the same change coming back from the server shows nothing, and answer the item.
    @discardableResult
    public func noteWritten(path: String, version: Int64, size: Int64) -> [MountOp] {
        apply([MountChange(path: path, size: size, version: version, seq: 0, deleted: false)], anchor: anchor ?? 0)
    }

    /// This Mac moved or trashed a file itself: forget it here.
    @discardableResult
    public func noteGone(path: String) -> [MountOp] { drop(MountId.file(path)) }

    /// Every file under a folder, by Drive path (a folder rename or delete acts on each).
    public func files(under folderPath: String) -> [String] {
        let pre = folderPath + "/"
        return nodes.values.filter { !$0.item.folder && (MountId.parse($0.item.id)?.path.hasPrefix(pre) ?? false) }.compactMap { MountId.parse($0.item.id)?.path }.sorted()
    }
}

/// The sync anchor Finder holds: the server's change number, 8 bytes, big endian.
public enum MountAnchor {
    public static func encode(_ n: Int64) -> Data { var v = UInt64(bitPattern: n).bigEndian; return Data(bytes: &v, count: 8) }
    public static func decode(_ d: Data) -> Int64? {
        guard d.count == 8 else { return nil }
        return Int64(bitPattern: d.reduce(UInt64(0)) { ($0 << 8) | UInt64($1) })
    }
}
