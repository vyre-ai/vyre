// CapsuleView: the bar, the answer to an Ask, and the results, drawn from CapsuleModel.
//
// Keys are handled by the panel (Host/Panel.swift) before the text field sees them, so arrows,
// Enter and Escape behave the same whatever has focus. This view only draws.
//
// Layout: the bar (56), then one area of fixed height (results, memory, an answer, a side panel)
// with a footer that says what Enter does. Rows are inset and rounded; the selected one is a
// raised plate with the signal pill at its left edge. The top hit is larger, like Spotlight's.

import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct CapsuleView: View {
    @ObservedObject var model: CapsuleModel
    @ObservedObject var focus: FocusTicket
    /// Drawn off screen for a picture: a solid ground, since a window's material needs a window.
    var snapshot = false
    @FocusState private var boxFocused: Bool

    var body: some View {
        let open = CapsuleLayout.isOpen(model)
        VStack(spacing: 0) {
            bar
            if open {
                Rule()
                // One area of fixed height below the bar, like Spotlight's: results, memory and
                // answers arrive in waves inside it and never resize the panel mid-word.
                VStack(spacing: 0) {
                    if model.asked != nil && model.groups.isEmpty && side == nil {
                        // An answer alone gets the whole area, and scrolls in it.
                        ScrollView(.vertical, showsIndicators: false) { answer }
                            .frame(maxHeight: .infinity, alignment: .top)
                    } else {
                        if model.asked != nil { answer.frame(maxHeight: 260, alignment: .top).clipped(); Rule() }
                        if model.showsMemory, let m = model.memory { MemoryBox(memory: m).padding(.vertical, 4); Rule() }
                        HStack(alignment: .top, spacing: 0) {
                            if !model.groups.isEmpty { results } else { Spacer(minLength: 0) }
                            if let side {
                                Rectangle().fill(Theme.rule).frame(width: 1)
                                side.frame(width: CapsuleLayout.sideWidth).frame(maxHeight: .infinity, alignment: .top)
                            }
                        }
                        .frame(maxHeight: .infinity, alignment: .top)
                    }
                    footer
                }
                .frame(height: CapsuleLayout.area, alignment: .top)
                .clipped()
            } else if let line = model.line, !line.isEmpty {
                Rule(); lineView(line)
            }
        }
        .frame(width: Theme.width, height: CapsuleLayout.panelHeight(model), alignment: .top)
        .background { if snapshot { Theme.carbon } else { Backdrop() } }
        .clipShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).strokeBorder(Theme.ruleStrong.opacity(0.9), lineWidth: 1))
        .overlay(alignment: .top) {
            // A hairline of light along the top edge, as on the Mac's own panels.
            RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                .strokeBorder(LinearGradient(colors: [Theme.bone.opacity(0.10), .clear], startPoint: .top, endPoint: .center), lineWidth: 1)
                .allowsHitTesting(false)
        }
        .onChange(of: focus.count) { boxFocused = true }
        .onAppear { boxFocused = true }
    }

    // MARK: the bar

    private var bar: some View {
        HStack(spacing: 12) {
            MarkView(size: 22)
            if let c = model.target {
                HStack(spacing: 5) {
                    // An extension's target shows the icon it gave (an app's own); the outer chip
                    // of a two-level one leads, "WhatsApp › juno".
                    chipIcon(model.targetParent ?? c)
                    if let p = model.targetParent {
                        Text(p.label).font(.system(size: 13, weight: .medium)).foregroundColor(Theme.stone).lineLimit(1)
                        Text("›").font(.system(size: 12, weight: .medium)).foregroundColor(Theme.ash)
                    }
                    Text(c.label).font(.system(size: 13, weight: .medium)).lineLimit(1)
                }
                .foregroundColor(Theme.bone)
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(Capsule().fill(Theme.raised))
                .overlay(Capsule().strokeBorder(Theme.signal.opacity(0.55), lineWidth: 1))
                .frame(maxWidth: 240, alignment: .leading)
                .fixedSize()
            }
            TextField("", text: $model.text, prompt: Text(model.target == nil ? "Search, calculate, ask, or @ a session" : "Message").foregroundColor(Theme.ash.opacity(0.8)))
                .textFieldStyle(.plain)
                .font(Theme.query)
                .foregroundColor(Theme.bone)
                .focused($boxFocused)
            if let item = model.current, let s = item.sendsTo {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.up.right").font(.system(size: 9, weight: .semibold))
                    Text(s).lineLimit(1)
                }
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(Theme.stone)
                .padding(.horizontal, 7).padding(.vertical, 3)
                .overlay(Capsule().strokeBorder(Theme.ruleStrong, lineWidth: 1))
                .fixedSize()
            }
        }
        .padding(.leading, 18).padding(.trailing, 14)
        .frame(height: Theme.barHeight)
    }

    /// The chip's icon: the picture an extension gave its target (an app's own icon), its symbol,
    /// or the symbol for what kind of thing Vyre's own target is.
    @ViewBuilder private func chipIcon(_ c: VyreCandidate) -> some View {
        let spec = model.mentionIcon(c)
        if case .symbol(let name, _)? = spec {
            Image(systemName: name).font(.system(size: 11, weight: .medium))
        } else if let spec, let img = model.icons.image(spec, points: 14, scale: 2) {
            Image(nsImage: img).resizable().interpolation(.high).frame(width: 14, height: 14)
        } else {
            Image(systemName: c.kind == .agent ? "person.crop.circle" : c.kind == .project ? "folder" : c.kind == .app ? "app" : "text.bubble")
                .font(.system(size: 11, weight: .medium))
        }
    }

    // MARK: the answer (capsule-now rule 4: the question, who answers, memory, then the answer)

    private var answer: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("You").font(.system(size: 12, weight: .medium)).foregroundColor(Theme.ash)
                Text(model.asked ?? "").font(.system(size: 15, weight: .medium)).foregroundColor(Theme.bone).lineLimit(2)
            }
            HStack(spacing: 7) {
                if let r = model.reply, !r.finished || model.pending { Pulse() } else { MarkView(size: 13) }
                Text(model.reply?.queued.map { $0.name } ?? "Claude").font(.system(size: 13, weight: .semibold)).foregroundColor(Theme.bone)
                Text(replyState).font(Theme.label).foregroundColor(Theme.ash)
                Spacer()
            }
            if let m = model.askedMemory { MemoryBox(memory: m, inset: false) }
            if let q = model.reply?.queued {
                Label(q.delivered ? "Handed over to \(q.name). Its answer comes when this turn ends." : "Queued for \(q.name): it gets this when its current turn ends.",
                      systemImage: q.delivered ? "checkmark.circle" : "clock")
                    .font(Theme.subtitle).foregroundColor(Theme.stone)
            }
            if !model.replyText.isEmpty {
                Text(markdown(model.replyText))
                    .font(Theme.reply).foregroundColor(Theme.bone)
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let r = model.reply, r.finished, let e = r.error {
                Label(e == "stopped" ? "Stopped." : e, systemImage: "exclamationmark.circle").font(Theme.subtitle).foregroundColor(Theme.beacon)
            }
            // Rule 3: a notice is status, one faint line, never part of the answer.
            if let n = model.reply?.notice, !n.isEmpty {
                Text(n).font(Theme.label).foregroundColor(Theme.ash).lineLimit(2)
            }
        }
        .padding(.horizontal, 18).padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var replyState: String {
        if model.pending { return "starting" }
        guard let r = model.reply else { return "" }
        if let q = r.queued, !q.delivered, !r.finished { return "queued" }
        if !r.finished { return model.replyText.isEmpty ? "thinking" : "answering" }
        var parts = [r.ok == false ? "stopped" : "done"]
        if let m = r.model { parts.insert(m, at: 0) }
        if let c = r.cost { parts.append(String(format: "$%.3f", c)) }
        return parts.joined(separator: " · ")
    }

    private func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }

    // MARK: results

    private var results: some View {
        let flat = model.flat
        let index = Dictionary(flat.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { a, _ in a })
        return ScrollViewReader { proxy in
            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(model.groups) { g in
                        SectionHeader(title: g.items.allSatisfy { $0.kind == "mention" } ? "Send to" : g.section.rawValue)
                        ForEach(g.items) { item in
                            let i = index[item.id] ?? -1
                            Row(item: item, selected: i == model.selected, top: g.section == .top || item.kind == "calc", icons: model.icons)
                                .equatable()
                                .id(item.id)
                                .contentShape(Rectangle())
                                .onTapGesture { model.selected = i; model.run() }
                        }
                    }
                }
                .padding(.bottom, 6)
            }
            .frame(maxHeight: .infinity, alignment: .top)
            .onChange(of: model.selected) { if let id = model.current?.id { proxy.scrollTo(id) } }
        }
    }

    var resultsHeight: CGFloat { CapsuleLayout.resultsHeight(model.groups) }

    /// An extension's side panel for the selected row, or the one it asked to show.
    private var side: AnyView? { _ = model.panelTick; return model.panelFor?(model.current) }

    // MARK: the footer: what was said, and what Enter does

    private var footer: some View {
        HStack(spacing: 14) {
            if let line = model.line, !line.isEmpty {
                Text(line).font(.system(size: 12)).foregroundColor(Theme.stone).lineLimit(1).truncationMode(.tail)
            } else if let c = model.confirming {
                Text(c.action.confirm ?? "").font(.system(size: 12)).foregroundColor(Theme.beacon).lineLimit(1)
            } else {
                MarkView(size: 12).opacity(0.7)
                let n = model.flat.filter { $0.kind != "ask" }.count
                if n > 0 { Text(n == 1 ? "1 result" : "\(n) results").font(.system(size: 11.5)).foregroundColor(Theme.ash) }
            }
            Spacer(minLength: 8)
            if let item = model.current {
                if let first = item.actions.first {
                    KeyHint(title: model.confirming != nil ? "Confirm" : first.title, keys: ["⏎"])
                }
                if let alt = item.actions.dropFirst().first(where: { $0.shortcut == KeyShortcut("return", command: true) }) {
                    KeyHint(title: alt.title, keys: ["⌘", "⏎"])
                }
            }
        }
        .padding(.horizontal, 14)
        .frame(height: CapsuleLayout.footerHeight)
        .background(Theme.graphite.opacity(0.35))
        .overlay(alignment: .top) { Rule() }
    }

    private func lineView(_ s: String) -> some View {
        Text(s).font(Theme.subtitle).foregroundColor(Theme.stone)
            .padding(.horizontal, 18).frame(maxWidth: .infinity, minHeight: CapsuleLayout.lineHeight, maxHeight: CapsuleLayout.lineHeight, alignment: .leading)
    }
}

enum CapsuleLayout {
    static let footerHeight: CGFloat = 30
    /// The fixed area under the bar while anything is shown there: nine rows, two headers and the footer.
    static let area: CGFloat = 6 + 2 * Theme.headerHeight + 9 * Theme.rowHeight + footerHeight
    static let lineHeight: CGFloat = 30

    @MainActor static func isOpen(_ m: CapsuleModel) -> Bool {
        m.asked != nil || !m.groups.isEmpty || m.showsMemory || m.panelFor?(m.current) != nil
    }

    /// The panel's height: the bar alone, the bar and a line, or the bar and the fixed area.
    @MainActor static func panelHeight(_ m: CapsuleModel) -> CGFloat {
        if isOpen(m) { return Theme.barHeight + 1 + area }
        if let l = m.line, !l.isEmpty { return Theme.barHeight + 1 + lineHeight }
        return Theme.barHeight
    }

    static let sideWidth: CGFloat = 260
    static let sideMin: CGFloat = 180
    static func resultsHeight(_ groups: [CapsuleModel.Group]) -> CGFloat {
        var h: CGFloat = 6, rows = 0
        for g in groups {
            if rows >= Theme.maxRows { break }
            h += Theme.headerHeight
            let n = min(g.items.count, Theme.maxRows - rows)
            h += CGFloat(n) * Theme.rowHeight
            rows += n
        }
        return h
    }
}

/// Hands focus back to the box each time the panel shows.
@MainActor final class FocusTicket: ObservableObject {
    @Published var count = 0
}

struct Rule: View {
    var body: some View { Rectangle().fill(Theme.rule).frame(height: 1) }
}

struct SectionHeader: View {
    let title: String
    var body: some View {
        Text(title.uppercased())
            .font(.system(size: 10, weight: .semibold, design: .monospaced)).tracking(1.1)
            .foregroundColor(Theme.ash)
            .padding(.leading, 18).padding(.bottom, 5)
            .frame(maxWidth: .infinity, minHeight: Theme.headerHeight, alignment: .bottomLeading)
    }
}

/// "Open ⏎": what a key does, with the key drawn as a small cap.
struct KeyHint: View {
    let title: String
    let keys: [String]
    var body: some View {
        HStack(spacing: 5) {
            Text(title).font(.system(size: 11.5, weight: .medium)).foregroundColor(Theme.stone)
            ForEach(keys, id: \.self) { KeyCap(key: $0) }
        }
    }
}

struct KeyCap: View {
    let key: String
    var body: some View {
        Text(key).font(.system(size: 10.5, weight: .semibold, design: .rounded)).foregroundColor(Theme.stone)
            .frame(minWidth: 17, minHeight: 17).padding(.horizontal, 2)
            .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(Theme.raised))
            .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous).strokeBorder(Theme.ruleStrong, lineWidth: 1))
    }
}

/// The signal dot breathing while an answer is on its way. The only motion that loops, and only
/// while something is actually happening.
struct Pulse: View {
    @State private var on = false
    var body: some View {
        Circle().fill(Theme.signal).frame(width: 7, height: 7)
            .opacity(on ? 1 : 0.35)
            .frame(width: 13, height: 13)
            .onAppear { withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { on = true } }
    }
}

/// The memory box (capsule-now rules 1, 2, 7): the fact first, then quotes as quotes with who
/// said them and when. These same lines, and no others, go with a quick question. A recall-tinted
/// rule on its left says it came from memory, where no model was used.
struct MemoryBox: View {
    let memory: MemoryAnswer
    var inset = true
    var body: some View {
        let items = Memo.items(memory)
        HStack(alignment: .top, spacing: 12) {
            RoundedRectangle(cornerRadius: 1).fill(Theme.recall.opacity(0.85)).frame(width: 2)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: "sparkle.magnifyingglass").font(.system(size: 10, weight: .semibold))
                    Text(memory.label.uppercased()).font(.system(size: 10, weight: .semibold, design: .monospaced)).tracking(1.1)
                }
                .foregroundColor(Theme.recall)
                ForEach(items) { it in
                    if it.kind == .quote {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\u{201C}\(it.text)\u{201D}").font(.system(size: 12.5)).foregroundColor(Theme.stone).lineLimit(2)
                            HStack(spacing: 6) {
                                Text("\(it.who ?? "You") said\(it.age.isEmpty ? "" : ", " + Memo.ago(it.age))")
                                if let s = it.source { Text("·"); Text(s.name).lineLimit(1) }
                            }
                            .font(.system(size: 11)).foregroundColor(Theme.ash)
                        }
                    } else {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(it.text).font(.system(size: 14.5, weight: .medium)).foregroundColor(Theme.bone).lineLimit(2)
                            if !it.age.isEmpty { Text(Memo.ago(it.age)).font(.system(size: 11)).foregroundColor(Theme.ash) }
                        }
                    }
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, inset ? 18 : 0).padding(.vertical, inset ? 10 : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Its height, for sizing before SwiftUI lays it out.
    static func height(_ m: MemoryAnswer) -> CGFloat {
        20 + 18 + Memo.items(m).reduce(0) { $0 + ($1.kind == .quote ? 36 : 22) }
    }
}

/// A result row. Equatable on what it draws, so a keystroke that leaves a row as it was does not
/// draw it again.
struct Row: View, Equatable {
    nonisolated static func == (a: Row, b: Row) -> Bool {
        a.item.id == b.item.id && a.item.title == b.item.title && a.item.subtitle == b.item.subtitle && a.item.icon == b.item.icon
            && a.selected == b.selected && a.top == b.top && a.item.actions.first?.title == b.item.actions.first?.title
    }
    let item: ResultItem
    let selected: Bool
    var top = false
    let icons: IconCache
    @Environment(\.displayScale) private var scale

    private var iconSize: CGFloat { top ? 32 : 26 }
    private var rowHeight: CGFloat { item.kind == "calc" ? Theme.rowHeight + 22 : top ? Theme.rowHeight + 12 : Theme.rowHeight }

    var body: some View {
        HStack(spacing: 11) {
            icon.frame(width: iconSize, height: iconSize)
            if top {
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.title).font(.system(size: item.kind == "calc" ? 22 : 15, weight: .semibold, design: item.kind == "calc" ? .rounded : .default))
                        .foregroundColor(Theme.bone).lineLimit(1).textSelection(.disabled)
                    if let sub = shownSubtitle { Text(sub).font(.system(size: 12)).foregroundColor(Theme.ash).lineLimit(1).truncationMode(.middle) }
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(item.title).font(.system(size: 14)).foregroundColor(Theme.bone).lineLimit(1)
                    if let sub = shownSubtitle {
                        Text(sub).font(.system(size: 12)).foregroundColor(Theme.ash).lineLimit(1).truncationMode(.middle)
                    }
                }
            }
            Spacer(minLength: 10)
            if isLive {
                HStack(spacing: 5) {
                    Circle().fill(Theme.signal).frame(width: 6, height: 6)
                    Text("Live in terminal")
                }
                .font(.system(size: 11, weight: .medium)).foregroundColor(Theme.signal)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Capsule().fill(Theme.signal.opacity(0.10)))
            } else if let k = RowKind.label(item) {
                Text(k).font(.system(size: 11.5)).foregroundColor(Theme.ash.opacity(0.9)).lineLimit(1)
            }
        }
        .padding(.leading, 12).padding(.trailing, 10)
        .frame(height: rowHeight)
        .background {
            if selected {
                RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.raised)
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.bone.opacity(0.06), lineWidth: 1))
                    .overlay(alignment: .leading) {
                        Capsule().fill(Theme.signal).frame(width: 3, height: top ? 20 : 16).offset(x: -1)
                    }
            }
        }
        .padding(.horizontal, 6)
        .animation(.easeOut(duration: 0.09), value: selected)
    }

    /// App rows say only their name, as Spotlight's do; a folder path under an app is noise.
    private var shownSubtitle: String? {
        if item.subtitle.isEmpty || item.kind == "app" || item.kind == "system" { return nil }
        if isLive { let rest = item.subtitle.dropFirst(Self.live.count).drop { $0 == " " || $0 == "·" }; return rest.isEmpty ? nil : String(rest) }
        return item.subtitle
    }

    static let live = "live in terminal"
    private var isLive: Bool { item.kind == "mention" && item.subtitle.hasPrefix(Self.live) }

    @ViewBuilder private var icon: some View {
        if case .mark = item.icon {
            MarkView(size: top ? 24 : 20)
        } else if case .symbol(let name, let tint) = item.icon {
            // Symbols sit on a small tile so they line up with app icons beside them.
            RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Theme.raised)
                .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Theme.rule, lineWidth: 1))
                .overlay(Image(systemName: name).font(.system(size: top ? 15 : 13, weight: .medium)).foregroundColor(Theme.tint(tint)))
                .padding(1)
        } else if let img = icons.image(item.icon, points: iconSize, scale: scale) {
            Image(nsImage: img).resizable().interpolation(.high)
        } else {
            Color.clear
        }
    }
}

/// The quiet word at a row's right edge: what kind of thing it is.
enum RowKind {
    nonisolated(unsafe) static var types: [String: String] = [:]
    static func label(_ item: ResultItem) -> String? {
        switch item.kind {
        case "app": return "Application"
        case "command", "system": return "Command"
        case "calc": return "Calculator"
        case "setting", "settings": return "System Settings"
        case "mention": return nil
        case "ask": return nil
        case "file":
            let ext = (item.title as NSString).pathExtension.lowercased()
            if ext.isEmpty { return "Folder" }
            if let hit = types[ext] { return hit }
            var name = UTType(filenameExtension: ext)?.localizedDescription ?? ext.uppercased()
            name = name.prefix(1).uppercased() + name.dropFirst()
            types[ext] = name
            return name
        default: return nil
        }
    }
}

/// The Vyre mark: the wire (a V that turns up) and the signal dot, from the 16-unit drawing.
struct MarkView: View {
    let size: CGFloat
    var body: some View {
        Canvas { ctx, sz in
            let k = sz.width / 16
            var wire = Path()
            wire.move(to: CGPoint(x: 2.5 * k, y: 4 * k))
            wire.addLine(to: CGPoint(x: 8 * k, y: 13 * k))
            wire.addLine(to: CGPoint(x: 11.52 * k, y: 7.24 * k))
            ctx.stroke(wire, with: .color(Theme.bone), style: StrokeStyle(lineWidth: 2 * k, lineCap: .round, lineJoin: .round))
            let r = 1.8 * k
            ctx.fill(Path(ellipseIn: CGRect(x: 13.5 * k - r, y: 4 * k - r, width: 2 * r, height: 2 * r)), with: .color(Theme.signal))
        }
        .frame(width: size, height: size)
    }
}

/// The panel's ground: the system's HUD material under a carbon wash, so it reads as Vyre and still
/// lets the desktop through a little, like Spotlight.
struct Backdrop: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = .hudWindow
        v.blendingMode = .behindWindow
        v.state = .active
        v.appearance = NSAppearance(named: .darkAqua)
        let wash = NSView()
        wash.wantsLayer = true
        wash.layer?.backgroundColor = NSColor(srgbRed: 0x16 / 255, green: 0x15 / 255, blue: 0x13 / 255, alpha: 0.86).cgColor
        wash.autoresizingMask = [.width, .height]
        v.addSubview(wash)
        return v
    }
    func updateNSView(_ v: NSVisualEffectView, context: Context) {}
}
