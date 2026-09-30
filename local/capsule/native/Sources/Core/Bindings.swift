// Bindings: your own short names and shortcuts for things the Capsule can run. An alias is a word
// you type ("sf") that brings its row to the top; a hotkey runs the row from anywhere, with no
// window. Both hang on a row's stable id (Kit ResultItem.id), so they survive a rename of the app
// or a change of the row's words.
//
// This file is the model: names, validation, and the file. Registering the keys with macOS and
// running the rows is Host/CommandBindings.swift.

import Carbon.HIToolbox
import Foundation

public struct CommandKey: Codable, Equatable, Sendable {
    public var id: String
    /// The row's title when it was bound, so a list can name it even if the row has gone.
    public var title: String
    public var alias: String?
    /// "ctrl+option+s". Words, lowercase, modifiers first in a fixed order, then one key.
    public var hotkey: String?
    public init(id: String, title: String, alias: String? = nil, hotkey: String? = nil) {
        self.id = id; self.title = title; self.alias = alias; self.hotkey = hotkey
    }
}

public enum HotkeySpec {
    static let keys: [String: UInt32] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
        "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
        "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42,
        ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50, "delete": 51,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
        "left": 123, "right": 124, "down": 125, "up": 126,
    ]
    static let names: [UInt32: String] = Dictionary(uniqueKeysWithValues: keys.map { ($0.value, $0.key) })

    /// Shortcuts that belong to macOS or to the Capsule and are never handed out.
    static let reserved: Set<String> = ["cmd+space", "cmd+tab", "cmd+q", "cmd+h", "cmd+w", "cmd+m", "cmd+`", "option+space",
                                        "ctrl+space", "cmd+option+esc", "ctrl+cmd+q", "cmd+option+space"]

    /// A spec from the keys pressed (a key code and the modifiers held), or nil for a key that
    /// cannot carry a shortcut. It has to hold Command, Option or Control: Shift alone or nothing
    /// would take a plain letter from every app.
    public static func spec(keyCode: UInt16, command: Bool, option: Bool, control: Bool, shift: Bool) -> String? {
        guard command || option || control, let key = names[UInt32(keyCode)] else { return nil }
        var parts: [String] = []
        if control { parts.append("ctrl") }
        if option { parts.append("option") }
        if shift { parts.append("shift") }
        if command { parts.append("cmd") }
        return (parts + [key]).joined(separator: "+")
    }

    /// The Carbon key code and modifiers for a spec, or nil if it is not one this file writes.
    public static func parse(_ s: String) -> (key: UInt32, mods: UInt32)? {
        var mods: UInt32 = 0, key: UInt32?
        for part in s.lowercased().split(separator: "+", omittingEmptySubsequences: false).map(String.init) {
            switch part {
            case "cmd", "command": mods |= UInt32(cmdKey)
            case "option", "opt", "alt": mods |= UInt32(optionKey)
            case "ctrl", "control": mods |= UInt32(controlKey)
            case "shift": mods |= UInt32(shiftKey)
            default:
                guard key == nil, let k = keys[part] else { return nil }
                key = k
            }
        }
        guard let key, mods & UInt32(cmdKey | optionKey | controlKey) != 0 else { return nil }
        return (key, mods)
    }

    /// The same spec in one fixed order, so two spellings of a shortcut compare equal. nil if bad.
    public static func normal(_ s: String) -> String? {
        guard let (key, mods) = parse(s), let name = names[key] else { return nil }
        var parts: [String] = []
        if mods & UInt32(controlKey) != 0 { parts.append("ctrl") }
        if mods & UInt32(optionKey) != 0 { parts.append("option") }
        if mods & UInt32(shiftKey) != 0 { parts.append("shift") }
        if mods & UInt32(cmdKey) != 0 { parts.append("cmd") }
        return (parts + [name]).joined(separator: "+")
    }

    public static func isReserved(_ s: String) -> Bool { normal(s).map { reserved.contains($0) } ?? false }

    /// "ctrl+option+s" as a person reads it: ⌃⌥S.
    public static func pretty(_ s: String) -> String {
        guard let n = normal(s) else { return s }
        let names: [String: String] = ["ctrl": "\u{2303}", "option": "\u{2325}", "shift": "\u{21E7}", "cmd": "\u{2318}", "space": "Space", "return": "\u{21A9}",
                                       "tab": "\u{21E5}", "delete": "\u{232B}", "left": "\u{2190}", "right": "\u{2192}", "up": "\u{2191}", "down": "\u{2193}"]
        return n.split(separator: "+").map { names[String($0)] ?? String($0).uppercased() }.joined()
    }
}

public struct Bindings: Equatable, Sendable {
    public var items: [CommandKey] = []
    public init(items: [CommandKey] = []) { self.items = items }

    // MARK: file

    public static func load(path: String) -> Bindings {
        guard let d = FileManager.default.contents(atPath: path),
              let root = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              let list = root["bindings"] as? [[String: Any]] else { return Bindings() }
        var out = Bindings()
        for o in list {
            guard let id = o["id"] as? String, !id.isEmpty else { continue }
            let alias = (o["alias"] as? String).flatMap(cleanAlias)
            let hotkey = (o["hotkey"] as? String).flatMap { HotkeySpec.normal($0) }.flatMap { HotkeySpec.isReserved($0) ? nil : $0 }
            if alias == nil && hotkey == nil { continue }
            // One owner per alias and per shortcut: the first in the file keeps it.
            let a = alias.flatMap { x in out.items.contains { $0.alias == x } ? nil : x }
            let h = hotkey.flatMap { x in out.items.contains { $0.hotkey == x } ? nil : x }
            if a == nil && h == nil { continue }
            out.items.removeAll { $0.id == id }
            out.items.append(CommandKey(id: id, title: (o["title"] as? String) ?? id, alias: a, hotkey: h))
        }
        return out
    }

    public func save(path: String) -> Bool {
        let list: [[String: Any]] = items.map { b in
            var o: [String: Any] = ["id": b.id, "title": b.title]
            if let a = b.alias { o["alias"] = a }
            if let h = b.hotkey { o["hotkey"] = h }
            return o
        }
        guard let d = try? JSONSerialization.data(withJSONObject: ["bindings": list], options: [.prettyPrinted, .sortedKeys]) else { return false }
        try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        return (try? d.write(to: URL(fileURLWithPath: path), options: .atomic)) != nil
    }

    // MARK: names

    /// An alias as it will be kept: lowercase, one word of letters, digits, dot, dash or underscore,
    /// 1 to 12 long. nil if it is not one.
    public static func cleanAlias(_ raw: String) -> String? {
        let a = raw.trimmingCharacters(in: .whitespaces).lowercased()
        guard (1...12).contains(a.count), a.allSatisfy({ $0.isLetter || $0.isNumber || ".-_".contains($0) }) else { return nil }
        return a
    }

    public func binding(for id: String) -> CommandKey? { items.first { $0.id == id } }
    public func byAlias(_ text: String) -> CommandKey? { items.first { $0.alias == text.lowercased() } }
    public func byHotkey(_ spec: String) -> CommandKey? { HotkeySpec.normal(spec).flatMap { s in items.first { $0.hotkey == s } } }

    // MARK: changes. Each returns why not, in words, or nil when it worked.

    public mutating func setAlias(_ raw: String, id: String, title: String) -> String? {
        guard let a = Self.cleanAlias(raw) else { return "An alias is one word, up to 12 letters, digits, dots, dashes or underscores." }
        if let other = byAlias(a), other.id != id { return "\u{201C}\(a)\u{201D} is already the alias of \(other.title)." }
        update(id, title) { $0.alias = a }
        return nil
    }

    public mutating func setHotkey(_ raw: String, id: String, title: String) -> String? {
        guard let s = HotkeySpec.normal(raw) else { return "That is not a shortcut. Hold Command, Option or Control with a key." }
        if HotkeySpec.isReserved(s) { return "\(HotkeySpec.pretty(s)) is used by macOS or by the Capsule itself." }
        if let other = byHotkey(s), other.id != id { return "\(HotkeySpec.pretty(s)) already runs \(other.title)." }
        update(id, title) { $0.hotkey = s }
        return nil
    }

    public mutating func clearAlias(id: String) { change(id) { $0.alias = nil } }
    public mutating func clearHotkey(id: String) { change(id) { $0.hotkey = nil } }

    private mutating func update(_ id: String, _ title: String, _ f: (inout CommandKey) -> Void) {
        if let i = items.firstIndex(where: { $0.id == id }) { f(&items[i]); items[i].title = title }
        else { var b = CommandKey(id: id, title: title); f(&b); items.append(b) }
    }

    private mutating func change(_ id: String, _ f: (inout CommandKey) -> Void) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        f(&items[i])
        if items[i].alias == nil && items[i].hotkey == nil { items.remove(at: i) }
    }
}
