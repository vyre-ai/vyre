// ViewFrames: what a module's Capsule view says, as plain values (the platform's capsule view
// contract, team 0.2 CHAT "CAPSULE VIEW CONTRACT"). vyred sends small fixed frames; the Capsule draws
// them and never sees a tool name. Text in a frame is data: it is drawn as text and never acted on.
//
//   capsule.commands {}        -> [command]                       ViewCommand
//   capsule.view {...}         -> list | detail | form | error | needs | held      ViewFrame
//   capsule.act {...}          -> done | push | view | preview | held | needs | error   ViewActResult
//
// Parsing is forgiving about what may be missing and strict about what is drawn: an unknown kind or
// version is refused with words, a string is cut to 500 characters, a list to 50 rows.

import Foundation

public struct ViewCommand: Equatable, Sendable {
    public var module: String
    public var id: String
    public var title: String
    public var keywords: [String]
    public var alias: String?
    public var icon: String?
    public var root: Bool
    public var argName: String?
    public var argPlaceholder: String?
    public var firstParty: Bool
    public var hash: String

    public var key: String { "\(module)/\(id)" }
    public var takesArg: Bool { argName != nil }

    /// The commands in a `capsule.commands` answer, in the order given. Anything without a module,
    /// an id and a title is left out.
    public static func parse(_ data: Any?) -> [ViewCommand] {
        let list = ((data as? [String: Any])?["commands"] as? [[String: Any]]) ?? (data as? [[String: Any]]) ?? []
        return list.compactMap { o -> ViewCommand? in
            guard let m = ViewText.string(o["module"]), let id = ViewText.string(o["id"]), let t = ViewText.string(o["title"]) else { return nil }
            let arg = o["arg"] as? [String: Any]
            return ViewCommand(module: m, id: id, title: t,
                               keywords: ((o["keywords"] as? [Any]) ?? []).compactMap { ViewText.string($0) },
                               alias: ViewText.string(o["alias"]), icon: ViewText.string(o["icon"]),
                               root: VJ.bool(o["root"]) ?? false,
                               argName: arg.flatMap { ViewText.string($0["name"]) }, argPlaceholder: arg.flatMap { ViewText.string($0["placeholder"]) },
                               firstParty: VJ.bool(o["firstParty"]) ?? false, hash: ViewText.string(o["hash"]) ?? "")
        }
    }
}

enum ViewText {
    static let maxString = 500
    static let maxBody = 8000
    static let maxRows = 50

    static func string(_ v: Any?, max: Int = maxString) -> String? {
        guard let s = v as? String else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return nil }
        return t.count > max ? String(t.prefix(max - 1)) + "\u{2026}" : t
    }

    /// Like string, but keeps line breaks and inner spacing (a body).
    static func body(_ v: Any?) -> String? {
        guard let s = v as? String, !s.isEmpty else { return nil }
        return s.count > maxBody ? String(s.prefix(maxBody - 1)) + "\u{2026}" : s
    }
}

/// What a `needs` frame says is missing, when the module says it in vault's terms: a credential the
/// person can add here (`vault.need {module, need}` gives its fields and help), named by the module's
/// own need id. Without it the frame is only words.
public struct ViewNeed: Equatable, Sendable {
    public var module: String?
    public var need: String
    public var label: String?

    static func parse(_ v: Any?) -> ViewNeed? {
        if let s = ViewText.string(v) { return ViewNeed(module: nil, need: s, label: nil) }
        guard let o = v as? [String: Any], ViewText.string(o["kind"]) ?? "credential" == "credential",
              let need = ViewText.string(o["need"]) ?? ViewText.string(o["item"]) else { return nil }
        return ViewNeed(module: ViewText.string(o["module"]), need: need, label: ViewText.string(o["label"]) ?? ViewText.string(o["vendor"]))
    }
}

public struct ViewAction: Equatable, Sendable {
    public var id: String
    public var title: String
    /// "cmd+r": Command or Shift chords only; anything else is dropped.
    public var shortcut: KeyShortcut?
    /// Asks first, in these words.
    public var confirm: String?
    /// Sends something as the person: the answer will be a preview, never a send.
    public var outward: Bool
}

public struct ViewRow: Equatable, Sendable {
    public var id: String
    public var title: String
    public var subtitle: String?
    public var icon: String?
    public var accessory: String?
    public var group: String?
    public var actions: [ViewAction]
}

public struct ViewList: Equatable, Sendable {
    public var title: String
    public var rows: [ViewRow]
    public var more: Bool
    public var empty: String?
    /// Present only for an added module: every row is marked "from <module>".
    public var from: String?
}

public struct ViewField: Equatable, Sendable {
    public enum Kind: String, Sendable { case text, multiline, choice, bool, number }
    public var name: String
    public var label: String
    public var kind: Kind
    public var required: Bool
    public var choices: [String]
    public var value: String?
}

public struct ViewForm: Equatable, Sendable {
    public var id: String
    public var title: String
    public var fields: [ViewField]
    public var submitTitle: String
    public var outward: Bool
}

public struct ViewDetail: Equatable, Sendable {
    public var title: String
    public var body: String
    public var fields: [(label: String, value: String)]
    public var actions: [ViewAction]
    public var from: String?
    public static func == (a: ViewDetail, b: ViewDetail) -> Bool {
        a.title == b.title && a.body == b.body && a.actions == b.actions && a.from == b.from
            && a.fields.count == b.fields.count && zip(a.fields, b.fields).allSatisfy { $0.label == $1.label && $0.value == $1.value }
    }
}

public enum ViewFrame: Equatable, Sendable {
    case list(ViewList)
    case detail(ViewDetail)
    case form(ViewForm)
    case error(code: String, message: String)
    case needs(code: String, message: String, need: ViewNeed? = nil)
    case held(message: String)

    /// The frame in a `capsule.view` answer, or a words-only error for one this Capsule cannot draw.
    public static func parse(_ data: Any?) -> ViewFrame {
        guard let o = data as? [String: Any] else { return .error(code: "bad_frame", message: "The view sent nothing to draw.") }
        guard (o["v"] as? NSNumber)?.intValue == 1 else {
            return .error(code: "old_capsule", message: "This view is newer than this Lumen. Update Lumen to see it.")
        }
        let from = ViewText.string(o["from"])
        switch ViewText.string(o["kind"]) {
        case "list":
            let rows = ((o["rows"] as? [[String: Any]]) ?? []).prefix(ViewText.maxRows).compactMap(parseRow)
            return .list(ViewList(title: ViewText.string(o["title"]) ?? "", rows: rows, more: VJ.bool(o["more"]) ?? false,
                                  empty: ViewText.string(o["empty"]), from: from))
        case "detail":
            let fields = ((o["fields"] as? [[String: Any]]) ?? []).compactMap { f -> (String, String)? in
                guard let l = ViewText.string(f["label"]), let v = ViewText.string(f["value"]) else { return nil }
                return (l, v)
            }
            return .detail(ViewDetail(title: ViewText.string(o["title"]) ?? "", body: ViewText.body(o["body"]) ?? "", fields: fields,
                                      actions: parseActions(o["actions"]), from: from))
        case "form": return parseForm(o).map { .form($0) } ?? .error(code: "bad_frame", message: "The form had nothing to fill in.")
        case "error": return .error(code: ViewText.string(o["code"]) ?? "error", message: ViewText.string(o["message"]) ?? "It did not work.")
        case "needs": return .needs(code: ViewText.string(o["code"]) ?? "needs", message: ViewText.string(o["message"]) ?? "Something needs connecting first.", need: ViewNeed.parse(o["need"]))
        case "held": return .held(message: ViewText.string(o["message"]) ?? "Waiting for your OK.")
        default: return .error(code: "bad_frame", message: "That view is not one this Lumen can draw.")
        }
    }

    static func parseRow(_ o: [String: Any]) -> ViewRow? {
        guard let id = ViewText.string(o["id"]), let t = ViewText.string(o["title"]) else { return nil }
        return ViewRow(id: id, title: t, subtitle: ViewText.string(o["subtitle"]), icon: ViewText.string(o["icon"]),
                       accessory: ViewText.string(o["accessory"]), group: ViewText.string(o["group"]), actions: parseActions(o["actions"]))
    }

    static func parseActions(_ v: Any?) -> [ViewAction] {
        ((v as? [[String: Any]]) ?? []).compactMap { a in
            guard let id = ViewText.string(a["id"]), let t = ViewText.string(a["title"]) else { return nil }
            var confirm: String?
            if let s = ViewText.string(a["confirm"]) { confirm = s } else if VJ.bool(a["confirm"]) == true { confirm = "\(t)?" }
            return ViewAction(id: id, title: t, shortcut: shortcut(ViewText.string(a["shortcut"])), confirm: confirm, outward: VJ.bool(a["outward"]) ?? false)
        }
    }

    /// "cmd+r" or "shift+cmd+return". Only Command and Shift chords, as the Capsule's own keys are:
    /// Option and Control belong to extensions.
    static func shortcut(_ s: String?) -> KeyShortcut? {
        guard let s else { return nil }
        var cmd = false, shift = false, key: String?
        for p in s.lowercased().split(separator: "+").map(String.init) {
            switch p {
            case "cmd", "command": cmd = true
            case "shift": shift = true
            case "option", "opt", "alt", "ctrl", "control": return nil
            default:
                guard key == nil, p.count == 1 || ["return", "space", "delete", "tab"].contains(p) else { return nil }
                key = p
            }
        }
        guard let key, cmd || shift else { return nil }
        return KeyShortcut(key, command: cmd, shift: shift)
    }

    static func parseForm(_ o: [String: Any]) -> ViewForm? {
        let fields = ((o["fields"] as? [[String: Any]]) ?? []).compactMap { f -> ViewField? in
            guard let name = ViewText.string(f["name"]) else { return nil }
            let kind = ViewField.Kind(rawValue: ViewText.string(f["type"]) ?? "text") ?? .text
            let value: String? = (f["default"] as? String) ?? (f["default"] as? NSNumber).map { VJ.isBool($0) ? ($0.boolValue ? "true" : "false") : "\($0)" }
            return ViewField(name: name, label: ViewText.string(f["label"]) ?? name, kind: kind, required: VJ.bool(f["required"]) ?? false,
                             choices: ((f["choices"] as? [Any]) ?? []).compactMap { ViewText.string($0) }, value: value)
        }
        guard !fields.isEmpty else { return nil }
        let submit = o["submit"] as? [String: Any]
        return ViewForm(id: ViewText.string(o["id"]) ?? "form", title: ViewText.string(o["title"]) ?? "", fields: fields,
                        submitTitle: submit.flatMap { ViewText.string($0["title"]) } ?? "Send", outward: VJ.bool(submit?["outward"]) ?? false)
    }
}

public enum ViewEffect: Equatable, Sendable {
    case open(String), copy(String), say(String), ask(String)
}

public struct ViewPreview: Equatable, Sendable {
    public var title: String
    public var words: [(label: String, value: String)]
    public var hash: String
    /// The server's proof that these exact words were shown (an HMAC); the second Return must send it back.
    public var token: String
    public static func == (a: ViewPreview, b: ViewPreview) -> Bool {
        a.title == b.title && a.hash == b.hash && a.token == b.token && a.words.count == b.words.count && zip(a.words, b.words).allSatisfy { $0.label == $1.label && $0.value == $1.value }
    }
}

public enum ViewActResult: Equatable, Sendable {
    case done(said: String?, effect: ViewEffect?)
    case push(command: String)
    case view(ViewFrame)
    case preview(ViewPreview)
    case held(message: String)
    case needs(code: String, message: String, need: ViewNeed? = nil)
    case error(code: String, message: String)

    public static func parse(_ data: Any?) -> ViewActResult {
        guard let o = data as? [String: Any] else { return .error(code: "bad_frame", message: "The action answered with nothing.") }
        guard (o["v"] as? NSNumber)?.intValue == 1 else { return .error(code: "old_capsule", message: "This action is newer than this Lumen. Update Lumen.") }
        switch ViewText.string(o["kind"]) {
        case "done":
            var effect: ViewEffect?
            if let e = o["effect"] as? [String: Any] {
                if let s = ViewText.string(e["open"], max: 2000) { effect = .open(s) }
                else if let s = ViewText.string(e["copy"], max: ViewText.maxBody) { effect = .copy(s) }
                else if let s = ViewText.string(e["say"]) { effect = .say(s) }
                else if let s = e["ask"] as? String, !s.trimmingCharacters(in: .whitespaces).isEmpty { effect = .ask(String(s.prefix(2000))) }
            }
            return .done(said: ViewText.string(o["said"]), effect: effect)
        case "push": return ViewText.string(o["command"]).map { .push(command: $0) } ?? .error(code: "bad_frame", message: "The action pointed at nothing.")
        case "view":
            let f = ViewFrame.parse(o["frame"])
            if case .form = f { return .view(f) }
            return .error(code: "bad_frame", message: "The action opened something this Lumen cannot draw.")
        case "preview":
            let words = ((o["words"] as? [[String: Any]]) ?? []).compactMap { w -> (String, String)? in
                guard let l = ViewText.string(w["label"]), let v = ViewText.body(w["value"]) else { return nil }
                return (l, v)
            }
            guard let hash = ViewText.string(o["hash"]), !words.isEmpty else { return .error(code: "bad_frame", message: "There was nothing to preview.") }
            return .preview(ViewPreview(title: ViewText.string(o["title"]) ?? "Check this first", words: words, hash: hash,
                                        token: ViewText.string(o["token"], max: 2000) ?? ""))
        case "held": return .held(message: ViewText.string(o["message"]) ?? "Waiting for your OK.")
        case "needs": return .needs(code: ViewText.string(o["code"]) ?? "needs", message: ViewText.string(o["message"]) ?? "Something needs connecting first.", need: ViewNeed.parse(o["need"]))
        case "error": return .error(code: ViewText.string(o["code"]) ?? "error", message: ViewText.string(o["message"]) ?? "It did not work.")
        default: return .error(code: "bad_frame", message: "The action answered with something this Lumen cannot read.")
        }
    }
}
