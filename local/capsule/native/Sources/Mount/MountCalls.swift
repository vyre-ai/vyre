// MountCalls: the server tool each thing Finder does becomes, and the frame that carries a call from the extension to the app (the Mac half of Vyre in Finder; mount.rs is the Windows half).
//
// Every call is made as the person's own device: the extension holds no key. It sends the call to the Vyre app over a socket in the app group's folder, and the app makes it from the page that
// holds this Mac's device channel (MountBridge.swift).

import Foundation

public struct MountCall: @unchecked Sendable {
    public let tool: String
    public let input: [String: Any]
    /// A stable text form, for tests.
    public var canonical: String {
        guard let d = try? JSONSerialization.data(withJSONObject: ["tool": tool, "input": input], options: [.sortedKeys]) else { return "" }
        return String(decoding: d, as: UTF8.self)
    }
}

public enum MountCalls {
    /// The most one call carries (core/files/space-drive.js MAX_UPLOAD), and the size of one part of a big upload or one ranged read.
    public static let oneCall = 8 * 1024 * 1024
    public static let part = 4 * 1024 * 1024

    public static func changes(since: Int64?, limit: Int = 500) -> MountCall {
        var i: [String: Any] = ["limit": limit]
        if let s = since { i["since"] = s }
        return MountCall(tool: "files.drive.space.changes", input: i)
    }
    public static func read(path: String, version: Int64, offset: Int64, length: Int) -> MountCall {
        MountCall(tool: "files.drive.space.read", input: ["path": path, "version": version, "offset": offset, "length": length])
    }
    public static func upload(path: String, bytes: Data, base: Int64?) -> MountCall {
        var i: [String: Any] = ["path": path, "base64": bytes.base64EncodedString()]
        if let b = base { i["base"] = b }
        return MountCall(tool: "files.drive.upload", input: i)
    }
    public static func begin(path: String, base: Int64?) -> MountCall {
        var i: [String: Any] = ["path": path]
        if let b = base { i["base"] = b }
        return MountCall(tool: "files.drive.space.upload.begin", input: i)
    }
    public static func part(upload: String, index: Int, bytes: Data) -> MountCall {
        MountCall(tool: "files.drive.space.upload.part", input: ["upload": upload, "index": index, "base64": bytes.base64EncodedString()])
    }
    public static func commit(upload: String, parts: Int) -> MountCall { MountCall(tool: "files.drive.space.upload.commit", input: ["upload": upload, "parts": parts]) }
    public static func abort(upload: String) -> MountCall { MountCall(tool: "files.drive.space.upload.abort", input: ["upload": upload]) }
    /// Finder's delete: the file goes to the server's trash, nothing is lost.
    public static func trash(path: String) -> MountCall { MountCall(tool: "files.drive.space.trash", input: ["path": path]) }
    public static func move(from: String, to: String) -> MountCall { MountCall(tool: "files.drive.space.move", input: ["from": from, "to": to]) }

    /// (offset, length) pieces of `part` bytes covering `size`: how a big file is read, and sent.
    public static func ranges(size: Int64) -> [(offset: Int64, length: Int)] {
        var out: [(Int64, Int)] = []
        var at: Int64 = 0
        while at < size {
            let len = Int(min(Int64(part), size - at))
            out.append((at, len))
            at += Int64(len)
        }
        return out
    }
    public static func needsParts(size: Int64) -> Bool { size > Int64(oneCall) }
}

/// The frame between the extension and the app: a 4-byte big-endian length, then JSON. A request is { id, tool, input }, an answer { id, data } or { id, error: { code, message } }.
public enum MountWire {
    public static let maxFrame = 24 * 1024 * 1024

    public static func frame(_ object: [String: Any]) -> Data? {
        guard JSONSerialization.isValidJSONObject(object), let body = try? JSONSerialization.data(withJSONObject: object), body.count <= maxFrame else { return nil }
        var len = UInt32(body.count).bigEndian
        return Data(bytes: &len, count: 4) + body
    }

    /// The length a frame announces, or nil when the header is short or the length is not allowed.
    public static func length(of header: Data) -> Int? {
        guard header.count >= 4 else { return nil }
        let n = header.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        return Int(n) <= maxFrame ? Int(n) : nil
    }

    public static func decode(_ body: Data) -> [String: Any]? { (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] }

    public static func request(id: Int, call: MountCall) -> Data? { frame(["id": id, "tool": call.tool, "input": call.input]) }
    public static func answer(id: Int, data: Any) -> Data? { frame(["id": id, "data": data]) }
    public static func failure(id: Int, code: String, message: String) -> Data? { frame(["id": id, "error": ["code": code, "message": message]]) }

    /// The tools the extension may ask the app to call, and no other: the app is a door to the person's own channel, and the extension is a separate process.
    public static let allowedTools: Set<String> = [
        "files.drive.space.changes", "files.drive.space.read", "files.drive.upload", "files.drive.space.upload.begin", "files.drive.space.upload.part",
        "files.drive.space.upload.commit", "files.drive.space.upload.abort", "files.drive.space.trash", "files.drive.space.move", "files.drive.space.stat",
    ]
}
