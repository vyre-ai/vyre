// Glass: the Capsule's way into Glass (ADR 0005, decision 5). Ported from lib/glass.js.
//
// Glass lives in the Deck, on the box, at `/glass/<agent>` for an agent's computer and
// `/glass/box` for the box's files. The Capsule only opens that page in the default browser:
// Tailscale identifies the user there, so there is no second trust path from here.
//
// Two rules keep it honest. The box's address comes from the link (`link.status`, the address
// this Mac paired with) and nothing else; with no paired box there is no row at all, because a
// guessed host would send the user somewhere they did not choose. And "Open Glass" shows only for
// an agent that has a computer: an agent without one has no screen to watch.

import AppKit
import Foundation

public struct GlassRow: Sendable, Equatable {
    public var id: String
    /// The agent's name, or "box".
    public var target: String
    public var label: String
    public var sub: String
    public var score: Double
}

public enum Glass {
    /// The box's own target: files only, it has no screen.
    public static let box = "box"

    /// The box's address as the link knows it, or nil. Only an https origin counts: that is what
    /// pairing accepts, and anything else is not a place to send a browser. `has` says whether this
    /// vyred has link.status at all; without it nothing is asked.
    public static func address(_ link: VyredLink, has: Bool = true) async -> String? {
        guard has else { return nil }
        let r = await link.call("link.status", [:])
        guard let s = r.data as? [String: Any], VJ.truthy(s["linked"]), let b = s["box"] as? [String: Any] else { return nil }
        return origin(VJ.str(b["address"]))
    }

    /// An https origin (with its port, if any), or nil.
    public static func origin(_ value: String?) -> String? {
        guard let v = value, let c = URLComponents(string: v), c.scheme?.lowercased() == "https",
              let host = c.host, !host.isEmpty, !v.contains(" ") else { return nil }
        let port = c.port.flatMap { $0 == 443 ? nil : $0 }
        return "https://\(host.lowercased())\(port.map { ":\($0)" } ?? "")"
    }

    /// encodeURIComponent: a space or a slash in a name stays inside one path segment.
    static func encode(_ s: String) -> String {
        var ok = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
        ok.insert(charactersIn: "-_.!~*'()")
        return s.addingPercentEncoding(withAllowedCharacters: ok) ?? ""
    }

    /// The Glass page for a target: `https://<box>/glass/<agent>`. Nil without a box address or a target.
    public static func url(box: String?, target: String) -> String? {
        guard let o = origin(box), !target.isEmpty else { return nil }
        return "\(o)/glass/\(encode(target))"
    }

    private static func row(_ target: String, _ sub: String, _ score: Double) -> GlassRow {
        GlassRow(id: "glass:\(target)", target: target, label: target == box ? "Open your server's files in Glass" : "Open Glass · \(target)", sub: sub, score: score)
    }

    /// "Open Glass" rows for a bare query. Typed as a command (`glass`, `glass <agent>`, `glass
    /// box`), they lead the list. Otherwise one follows each agent with a computer that the words
    /// name, and each thread of such an agent, just under the agent or thread row itself. None
    /// without a box address.
    public static func results(_ query: String, _ cat: VyreCatalog?) -> [GlassRow] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, let cat, origin(cat.box) != nil else { return [] }
        let agents = (cat.agents ?? []).filter(\.computer).map(\.name)
        if let cmd = VyRx.groups("^glass(?:\\s+(.*))?$", q) {
            let who = cmd[1].trimmingCharacters(in: .whitespaces).lowercased()
            var out: [GlassRow] = []
            for name in agents {
                if who.isEmpty || name.lowercased() == who { out.append(row(name, "watch its computer in the browser", 3)) }
                else if name.lowercased().hasPrefix(who) { out.append(row(name, "watch its computer in the browser", 2.5)) }
            }
            if who.isEmpty || box.hasPrefix(who) { out.append(row(box, "your server's files in the browser", who == box ? 3 : 2.4)) }
            return out
        }
        if agents.isEmpty { return [] }
        var found: [String: GlassRow] = [:], order: [String] = []
        func offer(_ name: String, _ sub: String, _ m: Double) {
            // A little under the match that brought it, so the agent or thread row comes first.
            let score = m * 0.95
            if let had = found[name], had.score >= score { return }
            if found[name] == nil { order.append(name) }
            found[name] = row(name, sub, score)
        }
        for name in agents { let m = Match.score(q, name); if m >= 0.5 { offer(name, "watch its computer in the browser", m) } }
        var current: [String: String] = [:]
        for a in cat.agents ?? [] { if let th = a.thread { current[th] = a.name } }
        for t in cat.threads {
            guard let name = t.agent ?? current[t.id], agents.contains(name), !t.label.isEmpty else { continue }
            let m = Match.score(q, t.label)
            if m >= 0.5 { offer(name, "\(t.label) · its computer in the browser", m) }
        }
        return order.compactMap { found[$0] }
    }

    /// Open a Glass page in the default browser. The URL is rebuilt from the box address and the
    /// target, never taken from a row, and it is https, so nothing can read it as a flag.
    public static func open(box: String?, target: String, opener: (URL) -> Bool = { NSWorkspace.shared.open($0) }) -> ActionOutcome {
        guard let u = url(box: box, target: target), let link = URL(string: u) else {
            return .failed("No server is paired with this Mac (vyre link pair <address>).")
        }
        return opener(link) ? .close(nil) : .failed("The browser did not open \(u).")
    }
}
