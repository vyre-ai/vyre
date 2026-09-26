// CapsuleView: the bar, the answer to an Ask, and the results, drawn from CapsuleModel.
//
// Keys are handled by the panel (Host/Panel.swift) before the text field sees them, so arrows,
// Enter and Escape behave the same whatever has focus. This view only draws.

import AppKit
import SwiftUI

struct CapsuleView: View {
    @ObservedObject var model: CapsuleModel
    @ObservedObject var focus: FocusTicket
    @FocusState private var boxFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            bar
            if model.asked != nil { Rule(); answer }
            if model.showsMemory, let m = model.memory { Rule(); MemoryBox(memory: m) }
            if !model.groups.isEmpty || side != nil {
                Rule()
                HStack(alignment: .top, spacing: 0) {
                    if !model.groups.isEmpty { results }
                    if let side {
                        Rectangle().fill(Theme.rule).frame(width: 1)
                        side.frame(width: CapsuleLayout.sideWidth).frame(maxHeight: .infinity, alignment: .top)
                    }
                }
                .frame(height: max(resultsHeight, side == nil ? 0 : CapsuleLayout.sideMin))
            }
            if let line = model.line, !line.isEmpty { Rule(); lineView(line) }
        }
        .frame(width: Theme.width)
        .background(Backdrop())
        .clipShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).strokeBorder(Theme.ruleStrong, lineWidth: 1))
        .onChange(of: focus.count) { boxFocused = true }
        .onAppear { boxFocused = true }
    }

    private var bar: some View {
        HStack(spacing: 12) {
            MarkView(size: 22)
            if let c = model.target {
                Text("@" + c.label).font(.system(size: 13, design: .monospaced)).foregroundColor(Theme.bone).lineLimit(1)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 4).fill(Theme.raised))
                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Theme.ruleStrong, lineWidth: 1))
                    .frame(maxWidth: 220, alignment: .leading)
            }
            TextField("", text: $model.text, prompt: Text(model.target == nil ? "Search, calculate, ask, or @ a session" : "Message").foregroundColor(Theme.ash))
                .textFieldStyle(.plain)
                .font(Theme.query)
                .foregroundColor(Theme.bone)
                .focused($boxFocused)
            if let item = model.current, let s = item.sendsTo {
                Text("to \(s)").font(Theme.label).foregroundColor(Theme.ash).lineLimit(1)
            }
        }
        .padding(.horizontal, 16)
        .frame(height: Theme.barHeight)
    }

    // MARK: the answer (capsule-now rule 4: the question, who answers, memory, then the answer)

    private var answer: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("YOU").font(Theme.label).tracking(1.6).foregroundColor(Theme.ash).frame(width: 44, alignment: .leading)
                Text(model.asked ?? "").font(Theme.title).foregroundColor(Theme.bone).lineLimit(2)
            }
            .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 8)
            HStack(spacing: 8) {
                Text(model.reply?.queued.map { $0.name } ?? "Claude").font(Theme.label).tracking(1.6).foregroundColor(Theme.stone)
                Text(replyState).font(Theme.label).foregroundColor(Theme.ash)
                Spacer()
            }
            .padding(.horizontal, 16).padding(.bottom, 6)
            if let m = model.askedMemory { MemoryBox(memory: m).padding(.bottom, 4) }
            if let q = model.reply?.queued {
                Text(q.delivered ? "Handed over to \(q.name). Its answer comes when this turn ends." : "Queued for \(q.name): it gets this when its current turn ends.")
                    .font(Theme.subtitle).foregroundColor(Theme.stone)
                    .padding(.horizontal, 16).padding(.bottom, 6)
            }
            if !model.replyText.isEmpty {
                ScrollView {
                    Text(markdown(model.replyText))
                        .font(Theme.reply).foregroundColor(Theme.bone)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 240)
                .padding(.horizontal, 16)
            }
            if let r = model.reply, r.finished, let e = r.error {
                Text(e == "stopped" ? "Stopped." : e).font(Theme.subtitle).foregroundColor(Theme.beacon).padding(.horizontal, 16)
            }
            // Rule 3: a notice is status, one faint line, never part of the answer.
            if let n = model.reply?.notice, !n.isEmpty {
                Text(n).font(Theme.label).foregroundColor(Theme.ash).lineLimit(2).padding(.horizontal, 16).padding(.top, 6)
            }
        }
        .padding(.bottom, 12)
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
        return ScrollViewReader { proxy in
            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(model.groups) { g in
                        Text(g.section.rawValue.uppercased())
                            .font(Theme.label).tracking(1.6).foregroundColor(Theme.ash)
                            .padding(.horizontal, 16).frame(height: Theme.headerHeight, alignment: .bottomLeading)
                        ForEach(g.items) { item in
                            let i = flat.firstIndex(where: { $0.id == item.id }) ?? -1
                            Row(item: item, selected: i == model.selected, icons: model.icons)
                                .id(item.id)
                                .contentShape(Rectangle())
                                .onTapGesture { model.selected = i; model.run() }
                        }
                    }
                }
                .padding(.bottom, 6)
            }
            .frame(height: resultsHeight)
            .onChange(of: model.selected) { if let id = model.current?.id { proxy.scrollTo(id) } }
        }
    }

    var resultsHeight: CGFloat { CapsuleLayout.resultsHeight(model.groups) }

    /// An extension's side panel for the selected row, or the one it asked to show.
    private var side: AnyView? { _ = model.panelTick; return model.panelFor?(model.current) }

    private func lineView(_ s: String) -> some View {
        Text(s).font(Theme.subtitle).foregroundColor(Theme.stone)
            .padding(.horizontal, 16).frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
    }
}

enum CapsuleLayout {
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

/// The memory box (capsule-now rules 1, 2, 7): the fact first, then quotes as quotes with who
/// said them and when. These same lines, and no others, go with a quick question.
struct MemoryBox: View {
    let memory: MemoryAnswer
    var body: some View {
        let items = Memo.items(memory)
        VStack(alignment: .leading, spacing: 5) {
            Text(memory.label.uppercased()).font(Theme.label).tracking(1.6).foregroundColor(Theme.recall)
            ForEach(items) { it in
                if it.kind == .quote {
                    (Text("\(it.who ?? "You") said\(it.age.isEmpty ? "" : ", " + Memo.ago(it.age)): ").foregroundColor(Theme.ash)
                        + Text("\u{201C}\(it.text)\u{201D}").foregroundColor(Theme.stone)
                        + Text(it.source.map { "  \($0.name)" } ?? "").foregroundColor(Theme.ash).font(Theme.label))
                        .font(Theme.subtitle).lineLimit(2)
                } else {
                    (Text(it.text).foregroundColor(Theme.bone)
                        + Text(it.age.isEmpty ? "" : "  " + Memo.ago(it.age)).foregroundColor(Theme.ash).font(Theme.label))
                        .font(Theme.title).lineLimit(2)
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Its height, for sizing the panel before SwiftUI lays it out.
    static func height(_ m: MemoryAnswer) -> CGFloat {
        20 + 18 + Memo.items(m).reduce(0) { $0 + ($1.text.count > 80 ? 40 : 21) }
    }
}

struct Rule: View {
    var body: some View { Rectangle().fill(Theme.rule).frame(height: 1) }
}

struct Row: View {
    let item: ResultItem
    let selected: Bool
    let icons: IconCache
    @Environment(\.displayScale) private var scale

    var body: some View {
        HStack(spacing: 10) {
            icon.frame(width: Theme.iconSize, height: Theme.iconSize)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(item.title).font(Theme.title).foregroundColor(Theme.bone).lineLimit(1)
                if !item.subtitle.isEmpty {
                    Text(item.subtitle).font(Theme.subtitle).foregroundColor(Theme.stone).lineLimit(1).truncationMode(.middle)
                }
            }
            Spacer(minLength: 8)
            if selected, let a = item.actions.first {
                Text(a.title).font(Theme.subtitle).foregroundColor(Theme.ash)
                Image(systemName: "return").font(.system(size: 11)).foregroundColor(Theme.ash)
            }
        }
        .padding(.horizontal, 14)
        .frame(height: Theme.rowHeight)
        .background(selected ? Theme.raised : Color.clear)
        .overlay(alignment: .leading) { if selected { Rectangle().fill(Theme.signal).frame(width: 2) } }
    }

    @ViewBuilder private var icon: some View {
        if case .mark = item.icon {
            MarkView(size: 18)
        } else if let img = icons.image(item.icon, points: Theme.iconSize, scale: scale) {
            Image(nsImage: img).resizable().interpolation(.high)
        } else {
            Color.clear
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
        wash.layer?.backgroundColor = NSColor(srgbRed: 0x16 / 255, green: 0x15 / 255, blue: 0x13 / 255, alpha: 0.82).cgColor
        wash.autoresizingMask = [.width, .height]
        v.addSubview(wash)
        return v
    }
    func updateNSView(_ v: NSVisualEffectView, context: Context) {}
}
