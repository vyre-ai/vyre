// FileTaste: which file rows a launcher user wants, and in what order. Pure, ported from local.js.
//
// Spotlight finds every name containing the query, and most of them are noise: libraries,
// caches, dependencies, build output, VCS, SDKs, app internals, dot-dirs. Spotlight cannot filter
// on the path (kMDItemPath is not in the index, so `kMDItemPath != "*x*"` is always true), so
// noise() runs on each path it returns. taste() then ranks what is left: the name match first, a
// document above source code, a folder in Documents, Desktop or Downloads lifted, anything inside
// a git repo pushed down, what was opened lately raised, and all of it scaled so a file never
// beats an app matched as well by name ("calcu" is the Calculator before Calculations.xlsx).
//
// mdQuery() is what the user's text becomes inside a Spotlight query: quotes, backslashes and
// asterisks escaped and control characters dropped, so what they type is only ever a string
// inside the quotes, never query syntax.

import Foundation

public struct FileCandidate: Sendable, Equatable {
    public var path: String
    public var name: String
    public var isFolder: Bool
    /// kMDItemLastUsedDate, 0 when never opened. Milliseconds since 1970.
    public var used: Double
    /// Modification time, milliseconds since 1970.
    public var modified: Double
    public var uti: String
    public var repo: Bool

    public init(path: String, name: String? = nil, isFolder: Bool = false, used: Double = 0, modified: Double = 0, uti: String = "", repo: Bool = false) {
        self.path = path; self.name = name ?? (path as NSString).lastPathComponent; self.isFolder = isFolder
        self.used = used; self.modified = modified; self.uti = uti; self.repo = repo
    }
}

public enum FileTaste {
    static func re(_ p: String, _ opts: NSRegularExpression.Options = []) -> NSRegularExpression {
        // The patterns are constants in this file; a typo is a crash in the first test, not at a user's desk.
        try! NSRegularExpression(pattern: p, options: opts)
    }
    static func test(_ r: NSRegularExpression, _ s: String) -> Bool {
        r.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }
    static func groups(_ r: NSRegularExpression, _ s: String) -> [String]? {
        guard let m = r.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
        return (0..<m.numberOfRanges).map { i in
            let rg = m.range(at: i)
            return rg.location == NSNotFound ? "" : (s as NSString).substring(with: rg)
        }
    }

    /// Text safe inside a Spotlight query string: control characters to spaces, trimmed, and
    /// quote, backslash and asterisk escaped.
    public static func escape(_ q: String) -> String {
        let cleaned = String(q.unicodeScalars.map { ($0.value < 0x20 || $0.value == 0x7f) ? " " : Character($0) })
            .trimmingCharacters(in: .whitespaces)
        var out = ""
        for c in cleaned { if c == "\\" || c == "\"" || c == "*" { out.append("\\") }; out.append(c) }
        return out
    }

    /// "a display name containing `q`", case- and diacritic-insensitive.
    public static func mdQuery(_ q: String) -> String { "kMDItemDisplayName == \"*\(escape(q))*\"cd" }

    static let noiseDirs = re(#"/(Library|node_modules|\.git|\.Trash|Caches?|__pycache__|DerivedData|\.cache|\.next|vendor|site-packages|dist-packages|third[_-]party|[^/]+-sdk|build|dist|target|out|Pods|\.?venv|coverage|tmp)(/|$)"#)
    static let bundleDirs = re(#"\.(app|framework|bundle|photoslibrary|xcodeproj|xcworkspace)(/|$)"#, .caseInsensitive)
    static let dotDir = re(#"/\.[^/]"#)

    /// Paths no one looks for from a launcher.
    public static func noise(_ p: String) -> Bool { test(noiseDirs, p) || test(bundleDirs, p) || test(dotDir, p) }

    static let docExt: Set<String> = ["pdf", "doc", "docx", "pages", "rtf", "txt", "md", "odt", "key", "ppt", "pptx", "numbers", "xls", "xlsx",
        "csv", "tsv", "png", "jpg", "jpeg", "heic", "gif", "tif", "tiff", "webp", "svg", "psd", "ai", "sketch", "fig", "mov", "mp4",
        "m4a", "mp3", "wav", "epub", "eml", "zip", "dmg", "vcf", "ics"]
    static let codeExt: Set<String> = ["js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp",
        "hpp", "m", "cs", "php", "sh", "zsh", "json", "yaml", "yml", "toml", "lock", "xml", "html", "css", "scss", "sql", "map", "d", "plist"]
    static let docUTI = re(#"^(com\.adobe\.pdf|public\.(image|jpeg|png|heic|tiff|movie|audio|mpeg-4|plain-text|rtf|comma-separated-values-text|presentation|spreadsheet)|com\.apple\.(iwork|keynote|pages|numbers)|org\.openxmlformats|com\.microsoft\.(word|excel|powerpoint)|net\.daringfireball\.markdown)"#)
    static let codeDir = re(#"/(src|lib|app|components)/"#)
    static let fileExt: [String] = (docExt.union(codeExt)).filter { $0.count >= 2 }.sorted()

    /// The extension of a name, lowercased, or "".
    public static func extOf(_ name: String) -> String {
        groups(extRe, name)?[1].lowercased() ?? ""
    }

    /// Does the box read as a filename: an extension ("q3.xl"), a slash, or a known extension as
    /// the last word ("invoice pdf")? Then more file rows are worth showing.
    public static func filenameLike(_ query: String) -> Bool {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if q.contains("/") { return true }
        if let g = groups(dotExtRe, q), fileExt.contains(where: { $0.hasPrefix(g[1]) }) { return true }
        if let g = groups(lastWordRe, q) { return fileExt.contains(g[1]) }
        return false
    }

    static let DAY = 86_400_000.0
    static let extRe = re(#"\.([a-z0-9]{1,8})$"#, .caseInsensitive)
    static let dotExtRe = re(#"\.([a-z0-9]{1,5})$"#)
    static let lastWordRe = re(#"\s([a-z0-9]{2,5})$"#)
    static let typedRe = re(#"^(.*\S)\s+([a-z0-9]{2,5})$"#, .caseInsensitive)

    /// How much a launcher user wants this row for `query`, or 0 to drop it.
    public static func taste(_ r: FileCandidate, _ query: String, now: Double = Date().timeIntervalSince1970 * 1000,
                             home: String = NSHomeDirectory()) -> Double {
        let label = r.name
        let ext = extOf(label)
        let stem = ext.isEmpty ? label : String(label.dropLast(ext.count + 1))
        var m = max(Match.score(query, label), Match.score(query, stem))
        // "invoice pdf": the last word names the type, the rest the name.
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if let g = groups(typedRe, trimmed), !ext.isEmpty, g[2].lowercased() == ext {
            m = max(m, Match.score(g[1], stem))
        }
        if m < 0.5 { return 0 }
        var s = m >= 0.8 ? m * 0.85 : m * 0.5
        let dir = (r.path as NSString).deletingLastPathComponent
        if r.repo || test(codeDir, r.path) { s -= 0.3 }
        else if r.isFolder { if [home + "/Documents", home + "/Desktop", home + "/Downloads", home].contains(dir) { s += 0.05 } }
        else if test(docUTI, r.uti) || docExt.contains(ext) { s += 0.05 }
        else if codeExt.contains(ext) { s -= 0.1 }
        if r.used > 0 {
            let age = now - r.used
            s += age < DAY ? 0.05 : age < 7 * DAY ? 0.04 : age < 30 * DAY ? 0.025 : age < 365 * DAY ? 0.01 : 0
        } else if r.modified > 0 && now - r.modified < 7 * DAY {
            s += 0.01
        }
        return s > 0 ? s : 0 // a repo file matched only mid-name is not shown at all
    }

    /// Whether `dir` or a parent below `stop` holds a `.git`, cached per directory for one search.
    public static func inRepo(_ dir: String, stop: String, cache: inout [String: Bool],
                              exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> Bool {
        if dir.isEmpty || dir == stop || dir == "/" || !dir.hasPrefix(stop + "/") { return false }
        if let hit = cache[dir] { return hit }
        let hit = exists(dir + "/.git") || inRepo((dir as NSString).deletingLastPathComponent, stop: stop, cache: &cache, exists: exists)
        cache[dir] = hit
        return hit
    }
}
