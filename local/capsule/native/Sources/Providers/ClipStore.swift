// ClipStore: the Capsule's clipboard history. Local only. Ported from lib/clips.js.
//
// What the user copies can be anything, so nothing in this file reaches vyred, an event, a log or
// the network (proposal section 5). Items come from ClipWatcher, live in memory, and are written to
// one file the caller names, mode 0600, in a folder that is the user's alone, and nowhere else.
// Nothing here prints.
//
// Skipped, never stored at all: what the watcher already drops (items marked concealed, transient
// or auto-generated, password-manager copies, the Capsule's own writes), and here anything that
// looks like a secret (looksSecret below). The filter errs on skipping: a clip history that lost a
// commit hash is a small cost; one that kept an API key is not.
//
// Picking a clip writes it back to the pasteboard. Return then pastes it into the app in front, or
// only copies it, by the setting (Host/Paste.swift).

import CryptoKit
import Foundation

public enum ClipText {
    public static let TEXT_MAX = 20_000
    public static let LABEL_MAX = 200
    /// How much of a clip's text a query is matched against: enough to find it, cheap per keystroke.
    static let MATCH_CHARS = 1000
    public static let NOTE = "Copied. Press ⌘V to paste."

    static func re(_ p: String, _ o: NSRegularExpression.Options = []) -> NSRegularExpression { try! NSRegularExpression(pattern: p, options: o) }
    static func has(_ r: NSRegularExpression, _ s: String) -> Bool { r.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil }

    static let tokenPrefix = re("(?:^|[^A-Za-z0-9_])(?:" + [
        "sk-[A-Za-z0-9_-]{16,}", "sk_(?:live|test)_[A-Za-z0-9]{10,}", "[rp]k_(?:live|test)_[A-Za-z0-9]{10,}",
        "gh[pousr]_[A-Za-z0-9]{20,}", "github_pat_[A-Za-z0-9_]{20,}", "glpat-[A-Za-z0-9_-]{16,}",
        "xox[abposr]-[A-Za-z0-9-]{10,}", "xapp-[A-Za-z0-9-]{10,}", "(?:AKIA|ASIA)[0-9A-Z]{16}", "AIza[0-9A-Za-z_-]{30,}",
        "ya29\\.[0-9A-Za-z_-]{20,}", "npm_[A-Za-z0-9]{30,}", "pypi-[A-Za-z0-9_-]{30,}", "hf_[A-Za-z0-9]{30,}",
        "shp(?:at|ss|ca|pa)_[a-fA-F0-9]{20,}", "SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}", "dop_v1_[a-f0-9]{40,}",
        "(?:sk|pk)-ant-[A-Za-z0-9_-]{16,}", "AC[a-f0-9]{32}", "SK[a-f0-9]{32}", "EAA[A-Za-z0-9]{40,}",
    ].joined(separator: "|") + ")")
    static let jwt = re(#"eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*"#)
    static let privateKey = re(#"-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|PRIVATE KEY BLOCK)-----"#)
    /// `password = hunter2`, `API_KEY: ...`, `"token": "..."`, as in a .env file or a config.
    static let assigned = re(#"(?:pass(?:word|wd|phrase)?|secret|api[_-]?key|access[_-]?key|auth[_-]?token|token|bearer|credential|private[_-]?key)["']?\s*[:=]\s*["']?[^\s"']{6,}"#, .caseInsensitive)
    static let bearer = re(#"\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}"#)
    /// scheme://user:password@host
    static let urlCredentials = re(#"[a-z][a-z0-9+.-]*://[^\s:@/]+:[^\s@/]+@"#, .caseInsensitive)
    static let urlSecretParam = re(#"[?&#](?:access_token|id_token|refresh_token|token|api_?key|key|secret|client_secret|sig|signature|password|pwd|code|auth|X-Amz-Signature)=[^&\s]{6,}"#, .caseInsensitive)
    /// A one-time code on its own: 6 to 8 digits, maybe split in the middle.
    static let otp = re(#"^(?:\d{6,8}|\d{3}[ -]\d{3}|\d{4}[ -]\d{4})$"#)
    static let edgePunct = re(#"^["'`(\[{<]+|["'`)\]}>,;.]+$"#)
    static let pathOrURL = re(#"^(?:[/~.]|[a-z][a-z0-9+.-]*://)"#, .caseInsensitive)
    static let hexish = re(#"^[0-9a-f-]+$"#, .caseInsensitive)
    static let joinedWords = re(#"^[A-Za-z]+(?:[-_.][A-Za-z]+)*[0-9]{0,4}$"#)

    /// Shannon entropy in bits per character.
    static func entropy(_ s: String) -> Double {
        var n: [Character: Int] = [:]
        for c in s { n[c, default: 0] += 1 }
        let len = Double(s.count)
        return n.values.reduce(0) { e, c in let p = Double(c) / len; return e - p * log2(p) }
    }

    /// Card numbers: 13 to 19 digits that pass the Luhn check.
    static func card(_ s: String) -> Bool {
        let d = s.filter { $0 != " " && $0 != "-" }
        guard (13...19).contains(d.count), d.allSatisfy({ $0.isASCII && $0.isNumber }) else { return false }
        var sum = 0
        for (i, ch) in d.reversed().enumerated() {
            var x = Int(String(ch))!
            if i % 2 == 1 { x *= 2; if x > 9 { x -= 9 } }
            sum += x
        }
        return sum % 10 == 0
    }

    /// A run of characters with no spaces that reads like a key: long, random, letters and digits.
    /// Paths and plain URLs are not; a UUID or a commit hash is, and is skipped, on purpose.
    static func randomToken(_ tok: String, min: Int) -> Bool {
        let t = edgePunct.stringByReplacingMatches(in: tok, range: NSRange(tok.startIndex..., in: tok), withTemplate: "")
        if t.count < min { return false }
        if has(pathOrURL, t) { return false }
        if !t.contains(where: { $0.isASCII && $0.isNumber }) || !t.contains(where: { $0.isASCII && $0.isLetter }) { return false }
        if t.count >= 32 && has(hexish, t) { return true }
        if has(joinedWords, t) { return false }
        return entropy(t) >= (t.count >= 40 ? 3.3 : 3.6)
    }

    /// Whether copied text looks like a secret and must not be kept. Errs on yes.
    public static func looksSecret(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return false }
        if has(otp, t) || card(t) { return true }
        if has(tokenPrefix, t) || has(jwt, t) || has(privateKey, t) || has(assigned, t) || has(bearer, t) { return true }
        if has(urlCredentials, t) || has(urlSecretParam, t) { return true }
        if !t.contains(where: { $0.isWhitespace }) { return randomToken(t, min: 20) }
        // Longer text: any long random-looking token inside it (a pasted .env line, a curl command).
        return t.split(whereSeparator: { $0.isWhitespace }).contains { randomToken(String($0), min: 32) }
    }

    static func base(_ p: String) -> String { let b = (p as NSString).lastPathComponent; return b.isEmpty ? p : b }

    public static func label(_ c: Clip) -> String {
        switch c.kind {
        case .files:
            let f = c.files ?? []
            return f.count > 1 ? "\(base(f[0])) and \(f.count - 1) more" : base(f.first ?? "")
        case .image: return "Image"
        case .text:
            let one = (c.text ?? "").split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
            if one.count <= LABEL_MAX { return one }
            var cut = String(one.prefix(LABEL_MAX - 1))
            while cut.last?.isWhitespace == true { cut.removeLast() }
            return cut + "…"
        }
    }

    /// "just now", "5 min ago", "2 h ago", "3 d ago".
    public static func age(_ ms: Double) -> String {
        let s = max(0, ms) / 1000
        if s < 60 { return "just now" }
        if s < 3600 { return "\(Int(s / 60)) min ago" }
        if s < 86400 { return "\(Int(s / 3600)) h ago" }
        return "\(Int(s / 86400)) d ago"
    }

    static func hash(_ s: String) -> String {
        SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined().prefix(16).description
    }
}

public struct Clip: Codable, Sendable, Equatable {
    public enum Kind: String, Codable, Sendable { case text, files, image }
    public var h: String
    public var kind: Kind
    public var text: String?
    public var files: [String]?
    public var app: String?
    /// Milliseconds since 1970.
    public var t: Double
}

/// One item as the watcher read it off the pasteboard.
public struct ClipItem: Sendable, Equatable {
    public var count: Int?
    public var at: Double?
    public var app: String?
    public var text: String?
    public var files: [String]?
    public var image = false
    public init(count: Int? = nil, at: Double? = nil, app: String? = nil, text: String? = nil, files: [String]? = nil, image: Bool = false) {
        self.count = count; self.at = at; self.app = app; self.text = text; self.files = files; self.image = image
    }
}

public struct ClipHit: Sendable { public var clip: Clip; public var score: Double }

public final class ClipStore: @unchecked Sendable {
    public let file: URL
    let now: @Sendable () -> Double
    let max: Int
    let days: Double
    let delay: TimeInterval
    private let lock = NSRecursiveLock()
    private var items: [Clip]?
    private var scheduled = false
    /// Pasteboard counts of the Capsule's own writes, so a pick never returns as a new clip.
    private var own: [Int] = []

    static let prefix = try! NSRegularExpression(pattern: #"^(?:clipboard|clips?|paste)(?:\s+(.*))?$"#, options: .caseInsensitive)

    public init(file: URL, now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }, max: Int = 200, days: Double = 7,
                delay: TimeInterval = 0.5) {
        self.file = file; self.now = now; self.max = max; self.days = days; self.delay = delay
    }

    private func loadLocked() -> [Clip] {
        if let items { return items }
        var got: [Clip] = []
        if let data = try? Data(contentsOf: file), let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let arr = j["items"] as? [Any] {
            for raw in arr {
                guard let d = try? JSONSerialization.data(withJSONObject: raw), let c = try? JSONDecoder().decode(Clip.self, from: d), valid(c) else { continue }
                got.append(c)
            }
        }
        items = got
        pruneLocked()
        return items ?? []
    }

    func valid(_ c: Clip) -> Bool {
        switch c.kind {
        case .text: return !(c.text ?? "").isEmpty
        case .files: return !(c.files ?? []).isEmpty
        case .image: return true
        }
    }

    @discardableResult
    private func pruneLocked() -> Bool {
        guard let cur = items else { return false }
        let oldest = now() - days * 86_400_000
        let kept = Array(cur.filter { $0.t >= oldest }.prefix(max))
        if kept.count == cur.count { return false }
        items = kept
        scheduleLocked()
        return true
    }

    /// Record one item from the watcher. Returns the stored clip, or nil when it was skipped.
    @discardableResult
    public func add(_ item: ClipItem) -> Clip? {
        lock.lock(); defer { lock.unlock() }
        if let n = item.count, let i = own.firstIndex(of: n) { own.remove(at: i); return nil }
        let t = (item.at ?? 0) > 0 ? item.at! : now()
        let app = item.app.flatMap { $0.isEmpty ? nil : String($0.prefix(80)) }
        var c: Clip
        if let fs = item.files, !fs.isEmpty {
            let files = Array(fs.filter { $0.hasPrefix("/") }.prefix(50))
            if files.isEmpty { return nil }
            c = Clip(h: ClipText.hash("files\0" + files.joined(separator: "\0")), kind: .files, files: files, app: app, t: t)
        } else if let text = item.text {
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || ClipText.looksSecret(text) { return nil }
            let kept = text.count > ClipText.TEXT_MAX ? String(text.prefix(ClipText.TEXT_MAX)) : text
            c = Clip(h: ClipText.hash("text\0" + kept), kind: .text, text: kept, app: app, t: t)
        } else if item.image {
            c = Clip(h: ClipText.hash("image\0\(Int(t))\0\(item.count.map(String.init) ?? "")"), kind: .image, app: app, t: t)
        } else {
            return nil
        }
        var list = loadLocked()
        list.removeAll { $0.h == c.h }                    // the same thing again moves to the top
        list.insert(c, at: 0)
        items = list
        pruneLocked()
        scheduleLocked()
        return c
    }

    /// Every kept clip, newest first.
    public func list() -> [Clip] {
        lock.lock(); defer { lock.unlock() }
        _ = loadLocked()
        pruneLocked()
        return items ?? []
    }

    func score(_ q: String, _ c: Clip) -> Double {
        let hay: String
        switch c.kind {
        case .files: hay = (c.files ?? []).map(ClipText.base).joined(separator: " ")
        case .image: hay = "image"
        case .text: hay = String((c.text ?? "").prefix(ClipText.MATCH_CHARS))
        }
        let s = Match.score(q, hay)
        return s >= 0.5 ? s : 0
    }

    /// Whether the box asks for the history by name ("clipboard", "clip", "paste").
    public static func listing(_ query: String) -> Bool {
        FileTaste.groups(prefix, query.trimmingCharacters(in: .whitespacesAndNewlines)) != nil
    }

    /// Clips for the launcher box. A bare query ranks on Match.score of the text, word-prefix and
    /// substring hits only, since a long text contains nearly any letters in order. "clipboard",
    /// "clip" or "paste" first lists recent clips in order (then filters by what follows), above
    /// everything else.
    public func search(_ query: String, limit: Int = 8) -> [ClipHit] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let all = list()
        if let g = FileTaste.groups(Self.prefix, q) {
            let rest = (g.count > 1 ? g[1] : "").trimmingCharacters(in: .whitespaces)
            let hits = rest.isEmpty ? all : all.filter { score(rest, $0) > 0 }
            return hits.prefix(limit).enumerated().map { i, c in ClipHit(clip: c, score: 3 - Double(i) * 0.01) }
        }
        if q.count < 2 { return [] }
        var hits: [ClipHit] = []
        for c in all { let s = score(q, c); if s > 0 { hits.append(ClipHit(clip: c, score: s)) } }
        hits.sort { $0.score != $1.score ? $0.score > $1.score : $0.clip.t > $1.clip.t }
        return Array(hits.prefix(limit))
    }

    public func clip(_ id: String) -> Clip? {
        let h = id.hasPrefix("clip:") ? String(id.dropFirst(5)) : id
        return list().first { $0.h == h }
    }

    /// The user picked a clip: `write` puts it on the pasteboard and answers the new change count
    /// (or nil when it failed). The Capsule's own write is remembered so it never returns as new.
    public func pick(_ id: String, write: (Clip) -> Result<Int, ClipWriteError>) -> Result<String, ClipWriteError> {
        guard let c = clip(id) else { return .failure(.init("That clip is gone.")) }
        if c.kind == .image { return .failure(.init("Only a note of the image was kept, not the image.")) }
        switch write(c) {
        case .failure(let e): return .failure(.init("Could not copy: \(e.message)"))
        case .success(let count):
            lock.lock(); defer { lock.unlock() }
            own.append(count)
            if own.count > 16 { own.removeFirst() }
            // Picked again, so it is recent again.
            var list = loadLocked()
            if let i = list.firstIndex(where: { $0.h == c.h }) {
                var moved = list.remove(at: i)
                moved.t = now()
                list.insert(moved, at: 0)
            }
            items = list
            scheduleLocked()
            return .success(ClipText.NOTE)
        }
    }

    /// Forget one clip.
    @discardableResult
    public func remove(_ id: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        let h = id.hasPrefix("clip:") ? String(id.dropFirst(5)) : id
        var list = loadLocked()
        guard let i = list.firstIndex(where: { $0.h == h }) else { return false }
        list.remove(at: i)
        items = list
        scheduleLocked()
        return true
    }

    /// Forget every clip, and write that down now.
    public func clear() {
        lock.lock(); items = []; own = []; lock.unlock()
        flush()
    }

    private func scheduleLocked() {
        if scheduled { return }
        scheduled = true
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + delay) { [weak self] in self?.flush() }
    }

    /// Write now, 0600, temp file then rename, so a crash never leaves half a file.
    public func flush() {
        lock.lock()
        scheduled = false
        guard let snapshot = items else { lock.unlock(); return }
        lock.unlock()
        let fm = FileManager.default
        let dir = file.deletingLastPathComponent()
        let tmp = dir.appendingPathComponent(file.lastPathComponent + ".\(getpid()).tmp")
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let arr = try snapshot.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) }
            let data = try JSONSerialization.data(withJSONObject: ["v": 1, "items": arr])
            guard fm.createFile(atPath: tmp.path, contents: data, attributes: [.posixPermissions: 0o600]) else { throw CocoaError(.fileWriteUnknown) }
            chmod(tmp.path, 0o600)
            if rename(tmp.path, file.path) != 0 { throw CocoaError(.fileWriteUnknown) }
        } catch {
            try? fm.removeItem(at: tmp)
        }
    }
}

public struct ClipWriteError: Error, Equatable, Sendable {
    public var message: String
    public init(_ m: String) { message = m }
}
