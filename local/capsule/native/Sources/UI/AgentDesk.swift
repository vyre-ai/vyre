// AgentDesk: the waiting list and the card that answers one item, drawn from Desk.
//
// Beacon for anything held or asking, quiet for a proposed lesson. The list is oldest first. A
// mail draft is edited in place and ⌘⏎ sends exactly what the card shows; an ask or a lesson is a
// yes or a no. Keys are the panel's (Agent/PanelKeys.swift); this view only draws.

import SwiftUI

struct WaitingList: View {
    @ObservedObject var desk: Desk

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("WAITING ON YOU · \(desk.waiting.count)").font(Theme.label).tracking(1.6).foregroundColor(Theme.beacon)
                Spacer()
                Text("oldest first").font(Theme.label).foregroundColor(Theme.ash)
            }
            .padding(.horizontal, 16).frame(height: Theme.headerHeight, alignment: .bottom)
            ForEach(Array(desk.waiting.prefix(Theme.maxRows).enumerated()), id: \.element.key) { i, w in
                WaitingRow(w: w, selected: desk.highlighted?.key == w.key)
                    .contentShape(Rectangle())
                    .onTapGesture { desk.openCard(w) }
                    .accessibilityIdentifier("waiting-\(i)")
            }
            AgentKeys(keys: ["↑↓ move", "⏎ review", "A allow", "esc close"])
        }
    }

    static func height(_ desk: Desk) -> CGFloat { Theme.headerHeight + CGFloat(min(desk.waiting.count, Theme.maxRows)) * Theme.rowHeight + AgentKeys.height }
}

struct WaitingRow: View {
    let w: Waiting
    let selected: Bool
    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(w.quiet ? Theme.ash : Theme.beacon).frame(width: 7, height: 7).frame(width: Theme.iconSize)
            VStack(alignment: .leading, spacing: 1) {
                Text(w.title).font(Theme.title).foregroundColor(Theme.bone).lineLimit(1)
                if !w.sub.isEmpty { Text(w.sub).font(Theme.subtitle).foregroundColor(Theme.stone).lineLimit(1) }
            }
            Spacer(minLength: 8)
            Text(w.age()).font(Theme.label).foregroundColor(Theme.ash)
            if selected { Image(systemName: "return").font(.system(size: 11)).foregroundColor(Theme.ash) }
        }
        .padding(.horizontal, 14)
        .frame(height: Theme.rowHeight)
        .background(selected ? Theme.raised : Color.clear)
        .overlay(alignment: .leading) { if selected { Rectangle().fill(Theme.beacon).frame(width: 2) } }
    }
}

/// One item's card. A mail draft is three editable lines; anything else is shown as it is.
struct HeldCardView: View {
    @ObservedObject var desk: Desk
    let w: Waiting

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(w.source == .lesson ? "VYRE PROPOSES" : "HELD FOR YOU").font(Theme.label).tracking(1.6)
                    .foregroundColor(w.source == .lesson ? Theme.ash : Theme.beacon)
                Text(w.title).font(Theme.title).foregroundColor(Theme.bone).lineLimit(1)
            }
            content
            HStack(spacing: 10) {
                Button { Task { await desk.yes(w) } } label: { Text(yesTitle + (w.source == .gate ? "  ⌘⏎" : "  ⏎")) }
                    .buttonStyle(AgentButton(primary: true)).disabled(desk.busy || desk.loading)
                Button { Task { await desk.no(w) } } label: { Text(noTitle) }
                    .buttonStyle(AgentButton(primary: false)).disabled(desk.busy)
                if let r = w.source == .lesson ? nil : (w.rule.map { "Rule: \($0)" } ?? w.why) {
                    Text(r).font(Theme.subtitle).foregroundColor(Theme.ash).lineLimit(1)
                }
                Spacer()
            }
            if let n = desk.note, !n.isEmpty { Text(n).font(Theme.subtitle).foregroundColor(Theme.bone).lineLimit(3) }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var yesTitle: String { w.source == .lesson ? "Accept" : w.source == .ask ? "Allow" : "Send" }
    private var noTitle: String { w.source == .lesson ? "Decline" : w.source == .ask ? "Deny" : "Discard" }

    @ViewBuilder private var content: some View {
        if w.source == .gate, desk.held?.draft != nil {
            grid("To") { TextField("", text: $desk.draft.to).textFieldStyle(.plain).font(.system(size: 13, design: .monospaced)).foregroundColor(Theme.bone) }
            grid("Subject") { TextField("", text: $desk.draft.subject).textFieldStyle(.plain).font(Theme.title).foregroundColor(Theme.bone) }
            TextEditor(text: $desk.draft.body).font(Theme.title).foregroundColor(Theme.bone)
                .scrollContentBackground(.hidden).frame(height: HeldCardView.bodyHeight)
                .background(RoundedRectangle(cornerRadius: 6).fill(Theme.raised))
            Text("Click any line to change it. ⌘⏎ sends what you see. Esc goes back.").font(Theme.label).foregroundColor(Theme.ash)
        } else if w.source == .gate && desk.loading {
            Text("Opening the draft…").font(Theme.subtitle).foregroundColor(Theme.ash)
        } else if w.source == .gate {
            if let to = w.to, !to.isEmpty { grid("To") { Text(to).font(.system(size: 13, design: .monospaced)).foregroundColor(Theme.bone) } }
            if let via = w.via { grid("Via") { Text(via).font(.system(size: 13, design: .monospaced)).foregroundColor(Theme.bone) } }
            if let s = desk.held?.summary, !s.isEmpty { Text(s).font(Theme.title).foregroundColor(Theme.stone).lineLimit(4) }
        } else if w.source == .lesson, let card = w.lesson {
            Text(card.rule).font(Theme.title).foregroundColor(Theme.bone).lineLimit(4)
            ForEach(card.lines, id: \.label) { l in grid(l.label) { Text(l.text).font(Theme.subtitle).foregroundColor(Theme.stone) } }
        } else {
            if let t = w.tool { grid("Tool") { Text(t).font(.system(size: 13, design: .monospaced)).foregroundColor(Theme.bone) } }
            if !w.sub.isEmpty { grid("Where") { Text(w.sub).font(Theme.subtitle).foregroundColor(Theme.stone) } }
        }
    }

    private func grid<V: View>(_ k: String, @ViewBuilder _ v: () -> V) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(k.uppercased()).font(Theme.label).tracking(1.2).foregroundColor(Theme.ash).frame(width: 64, alignment: .leading)
            v()
            Spacer(minLength: 0)
        }
    }

    static let bodyHeight: CGFloat = 150

    static func height(_ desk: Desk, _ w: Waiting) -> CGFloat {
        var h: CGFloat = 24 + 22 + 34 + 12
        if w.source == .gate, desk.held?.draft != nil { h += 22 + 22 + bodyHeight + 16 + 8 * 4 }
        else if w.source == .lesson { h += 44 + CGFloat(w.lesson?.lines.count ?? 0) * 20 }
        else { h += 50 }
        if let n = desk.note, !n.isEmpty { h += n.count > 90 ? 40 : 22 }
        return h
    }
}

/// The quiet key hints under a list.
struct AgentKeys: View {
    let keys: [String]
    var body: some View {
        HStack(spacing: 14) { ForEach(keys, id: \.self) { Text($0).font(Theme.label).foregroundColor(Theme.ash) } ; Spacer() }
            .padding(.horizontal, 16).frame(height: AgentKeys.height)
    }
    static let height: CGFloat = 28
}

struct AgentButton: ButtonStyle {
    let primary: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.subtitle)
            .foregroundColor(primary ? Theme.graphite : Theme.bone)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 6).fill(primary ? Theme.bone : Theme.raised).opacity(configuration.isPressed ? 0.8 : 1))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(primary ? Color.clear : Theme.ruleStrong, lineWidth: 1))
    }
}

/// "2 waiting on you. Press ↑ to see them." under an empty box.
struct WaitingHint: View {
    @ObservedObject var desk: Desk
    var body: some View {
        let n = desk.waiting.count
        HStack(spacing: 8) {
            Circle().fill(desk.loud > 0 ? Theme.beacon : Theme.ash).frame(width: 6, height: 6)
            Text("\(n) waiting on you. Press ↑ to see \(n == 1 ? "it" : "them").").font(Theme.subtitle).foregroundColor(Theme.stone)
            Spacer()
        }
        .padding(.horizontal, 16).frame(height: WaitingHint.height)
    }
    static let height: CGFloat = 30
}

/// Where the agent views sit in the panel, and how tall they are, for the panel's size.
@MainActor enum AgentLayout {
    /// The desk takes the space under the bar while it is open.
    static func deskShown(_ m: CapsuleModel) -> Bool { m.desk.mode != .none }
    static func hintShown(_ m: CapsuleModel) -> Bool {
        m.desk.mode == .none && m.text.isEmpty && m.target == nil && m.asked == nil && !m.desk.waiting.isEmpty
    }
    /// The conversation with the agent in the chip, while nothing else has the space.
    static func directShown(_ m: CapsuleModel) -> Bool { m.desk.mode == .none && m.direct.dm != nil && m.asked == nil }
    static func height(_ m: CapsuleModel) -> CGFloat {
        switch m.desk.mode {
        case .none: return (hintShown(m) ? 1 + WaitingHint.height : 0) + (directShown(m) ? DirectView.height(m.direct) : 0)
        case .list: return 1 + WaitingList.height(m.desk)
        case .card: return m.desk.open.map { 1 + HeldCardView.height(m.desk, $0) } ?? 0
        }
    }

    @ViewBuilder static func view(_ m: CapsuleModel) -> some View {
        switch m.desk.mode {
        case .none:
            if directShown(m) { Rule(); DirectView(direct: m.direct, desk: m.desk) }
            else if hintShown(m) { Rule(); WaitingHint(desk: m.desk) }
        case .list: Rule(); WaitingList(desk: m.desk)
        case .card: if let w = m.desk.open { Rule(); HeldCardView(desk: m.desk, w: w) }
        }
    }
}
